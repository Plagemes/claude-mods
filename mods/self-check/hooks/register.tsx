import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelForkResult, PluginOptions, Register } from 'claude-code'

import type { SelfCheckFinding } from '../types'
import { checkPrompt, fixPrompt, oneLine, parseVerdict } from './verdict'

const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const
/** Gaps sent back to Claude by auto mode, at most, in one session. */
const MAX_AUTO_FIXES = 10
const REQUEST_SHOWN = 160
const PERSON_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])

const findingAtom = atom({ plugin: 'self-check', key: 'finding' } as const, null)

type Mode = 'notify' | 'auto'

/** The main-loop turn running now: what it was asked, the files it edited, and whether it is a fix this plugin sent. */
type Turn = { turnId: string; text: string; files: Set<string>; isFix: boolean }

type Session = {
  turn: Turn | undefined
  isTurnRunning: boolean
  /** Main-loop turns started this load: a check whose count moved on is stale. */
  turnsStarted: number
  /** A fix prompt was sent; the turn it starts is not checked again (one round at most). */
  isFixPending: boolean
  personSubmitting: number
  autoFixes: number
}

type Job = { turnId: string; request: string; answer: string; files: string[]; startedCount: number }

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const isBusy = (session: Session): boolean => session.isTurnRunning || session.personSubmitting > 0
const gapsLabel = (n: number): string => `${n} gap${n === 1 ? '' : 's'}`

async function relative($: EngineInterface, files: readonly string[]): Promise<string[]> {
  const root = (await $.session.root().catch(() => '')).replace(/[\\/]+$/, '')
  return files.map(path => (root !== '' && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path))
}

/** Sends the gaps back to Claude as your next prompt, never while a turn is running. */
async function submitFix($: EngineInterface, session: Session, gaps: readonly string[]): Promise<boolean> {
  if (isBusy(session)) {
    $.ui.toast('Claude is busy: press Fix gaps again when this turn ends')
    return false
  }
  session.isFixPending = true
  try {
    const sent = await $.prompt.submit({ text: fixPrompt(gaps), asUser: true })
    if (sent.drop === undefined) return true
    $.ui.toast(`could not send the fix: ${sent.drop}`)
  } catch (error) {
    $.ui.log(`self-check: could not send the fix: ${messageOf(error)}`, { to: 'debug' })
  }
  session.isFixPending = false
  return false
}

async function fixFromBand($: EngineInterface, session: Session): Promise<void> {
  const finding = await read($, findingAtom)
  if (finding === null) return
  if (await submitFix($, session, finding.gaps)) await update($, findingAtom, () => null)
}

/** Auto mode: sends the gaps back once, unless you are typing, busy, or the session's limit is reached. */
async function autoFix($: EngineInterface, session: Session, finding: SelfCheckFinding): Promise<void> {
  if (session.autoFixes >= MAX_AUTO_FIXES) {
    await hubNotify($, { level: 'warning', title: `${gapsLabel(finding.gaps.length)} found; auto-fix has run ${MAX_AUTO_FIXES} times this session, so it is up to you now` })
    return
  }
  const draft = await $.prompt.read().catch(() => ({ text: '', cursor: 0 }))
  if (draft.text.trim() !== '' || isBusy(session)) return
  session.autoFixes += 1
  await update($, findingAtom, current => (current?.turnId === finding.turnId ? { ...current, isSentToFix: true } : current))
  if (await submitFix($, session, finding.gaps)) {
    await hubNotify($, { level: 'info', title: `🔎 ${gapsLabel(finding.gaps.length)} found · asked Claude to close them` })
  } else {
    await update($, findingAtom, current => (current?.turnId === finding.turnId ? { ...current, isSentToFix: false } : current))
  }
}

/** Forks the conversation with the checklist and files the verdict, unless a newer turn has begun meanwhile. */
async function check($: EngineInterface, session: Session, mode: Mode, job: Job): Promise<void> {
  const files = await relative($, job.files)
  const startedAt = await $.clock.now()
  let reply: ModelForkResult | undefined
  try {
    reply = await $.model.fork({ prompt: checkPrompt(job.request, job.answer, files) })
  } catch (error) {
    reply = undefined
    $.ui.log(`self-check: the check failed: ${messageOf(error)}`, { to: 'debug' })
  }
  const verdict = reply?.isAnswered === true ? parseVerdict(reply.text) : undefined
  // The check ran whether or not a newer turn has made its verdict stale: tell the hub's bus how it went.
  await hubPublish($, { topic: 'agent.finished', data: { agentType: 'self-check', outcome: verdict === undefined ? 'failed' : 'ok', durationMs: Math.max(0, (await $.clock.now()) - startedAt) } })
  if (session.turnsStarted !== job.startedCount) return
  if (verdict === undefined) {
    $.ui.status(undefined)
    const why = reply === undefined ? 'error' : reply.isAnswered ? 'no readable verdict' : reply.reason
    $.ui.log(`self-check: skipped the check of the last turn (${why})`, { to: 'debug' })
    return
  }
  if (verdict.isComplete) {
    $.ui.status('✓ self-check: done as asked')
    return
  }
  const finding: SelfCheckFinding = { turnId: job.turnId, request: oneLine(job.request, REQUEST_SHOWN), gaps: verdict.gaps, isSentToFix: false }
  await update($, findingAtom, () => finding)
  $.ui.status(`⚠ self-check: ${gapsLabel(finding.gaps.length)}`)
  if (mode === 'auto') await autoFix($, session, finding)
}

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Says hello to mods-hub when it is installed. */
async function greetHub($: EngineInterface): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: ['agent.finished'], consumes: [] })
}

export const register: Register = (on, options: PluginOptions) => {
  const mode: Mode = options.mode === 'auto' ? 'auto' : 'notify'
  const session: Session = { turn: undefined, isTurnRunning: false, turnsStarted: 0, isFixPending: false, personSubmitting: 0, autoFixes: 0 }

  on('session.start', async ($, e, next) => {
    await greetHub($)
    return next(e)
  })

  // Your own prompt holds an auto fix back until its turn has started.
  on('prompt.submit', async ($, e, next) => {
    if (!PERSON_ORIGINS.has(e.origin.kind)) return next(e)
    session.personSubmitting += 1
    try {
      return await next(e)
    } finally {
      session.personSubmitting -= 1
    }
  })

  on('turn.start', async ($, e, next) => {
    session.isTurnRunning = true
    session.turnsStarted += 1
    session.turn = { turnId: e.turnId, text: e.text, files: new Set(), isFix: session.isFixPending }
    session.isFixPending = false
    if ((await read($, findingAtom)) !== null) await update($, findingAtom, () => null)
    $.ui.status(undefined)
    return next(e)
  })

  on('tool.call', { tool: EDIT_TOOLS }, async ($, e, next) => {
    const ran = await next(e)
    const path = 'file_path' in e ? e.file_path : 'notebook_path' in e ? e.notebook_path : undefined
    if (session.turn !== undefined && ran.deny === undefined && ran.isError !== true && typeof path === 'string') session.turn.files.add(path)
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    session.isTurnRunning = false
    const turn = session.turn
    session.turn = undefined
    const isChecked = turn !== undefined && turn.turnId === e.turnId && !turn.isFix && e.reason === 'answer' && turn.files.size > 0 && turn.text.trim() !== ''
    if (!isChecked) return result
    const job: Job = { turnId: turn.turnId, request: turn.text, answer: e.answer, files: [...turn.files], startedCount: session.turnsStarted }
    $.ui.status('🔎 self-check…')
    $.clock.after(0, () => void check($, session, mode, job).catch(error => $.ui.log(`self-check: ${messageOf(error)}`, { to: 'debug' })))
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const finding = await read($, findingAtom)
    if (finding === null || finding.isSentToFix || e.props.hasSurvey || e.props.isWorking) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const below = await next(e)

    return (
      <Box flexDirection="column">
        <Box key="self-check" flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
          <Text bold color="warning">
            ⚠ Self-check: {gapsLabel(finding.gaps.length)} in the last turn
          </Text>
          <Text dimColor wrap="truncate-end">
            You asked: {finding.request}
          </Text>
          {finding.gaps.map((gap, index) => (
            <Box key={`gap:${index}`} flexDirection="row" gap={1}>
              <Text color="warning">•</Text>
              <Text>{gap}</Text>
            </Box>
          ))}
          <Box flexDirection="row" gap={1} marginTop={1}>
            <Button key="fix" label="Fix gaps" hotkey="f" variant="primary" onPress={() => void fixFromBand($, session)} />
            <Button key="dismiss" label="Dismiss" hotkey="d" role="dismiss" onPress={() => void update($, findingAtom, () => null)} />
          </Box>
        </Box>
        {below}
      </Box>
    )
  })
}

// #region @vendored shared/hub-client.ts sha256:0acb840d81b7: edit the source, then run `node scripts/sync-shared.mjs`.
// mods-hub client (docs/MOD_CONTRACT.md): uses the hub when it is installed, keeps working when it is not.

type HubMods = EngineInterface['mods']

/** Publishes an event on the hub's bus; false when there is no hub or it refused the event. */
async function hubPublish($: EngineInterface, input: Parameters<HubMods['publish']>[0]): Promise<boolean> {
  try {
    await $.mods.publish(input)
    return true
  } catch {
    return false
  }
}

/**
 * Routes a notification through the hub (channels, silent, night, presence), or shows it as a toast when there is
 * no hub: `title — body`, for `fallback.timeoutMs` when given (the toast's own option).
 */
async function hubNotify($: EngineInterface, input: Parameters<HubMods['notify']>[0], fallback: { timeoutMs?: number } = {}): Promise<void> {
  try {
    await $.mods.notify(input)
  } catch {
    const text = input.body === undefined || input.body === '' ? input.title : `${input.title} — ${input.body}`
    if (fallback.timeoutMs === undefined) $.ui.toast(text)
    else $.ui.toast(text, { timeoutMs: fallback.timeoutMs })
  }
}

/** The global mode (presence, silent, night, interaction), or undefined when there is no hub. */
async function hubMode($: EngineInterface): Promise<Awaited<ReturnType<HubMods['mode']>> | undefined> {
  try {
    return await $.mods.mode()
  } catch {
    return undefined
  }
}

/** Announces this mod to the hub, with its panel tab when it has one; call once from `session.start`. */
async function hubHello($: EngineInterface, hello: Parameters<HubMods['hello']>[0], tab?: Parameters<HubMods['registerTab']>[0]): Promise<boolean> {
  try {
    await $.mods.hello(hello)
    if (tab !== undefined) await $.mods.registerTab(tab)
    return true
  } catch {
    return false
  }
}

/** Opens the shared panel on this mod's tab; false when there is no hub (open your own pane then). */
async function hubShowTab($: EngineInterface, id: string): Promise<boolean> {
  try {
    return (await $.mods.showTab({ id })).isPlaced
  } catch {
    return false
  }
}

/**
 * Stops, pauses or resumes the automatic work (`control.stop` / `control.pause` / `control.resume`) in this session
 * or, with `scope: 'all'`, in every session; false when there is no hub (stop what you run yourself then).
 */
async function hubStop($: EngineInterface, input: Parameters<HubMods['stop']>[0]): Promise<boolean> {
  try {
    await $.mods.stop(input)
    return true
  } catch {
    return false
  }
}

/** Puts a fact on the hub's blackboard as `<this mod>.<name>`; false when there is no hub or it refused the fact. */
async function hubShareFact($: EngineInterface, input: Parameters<HubMods['share']>[0]): Promise<boolean> {
  try {
    await $.mods.share(input)
    return true
  } catch {
    return false
  }
}

/** A fact from the hub's blackboard by its full key (`stack-detector.stack`); undefined when there is no hub or no such fact. */
async function hubReadFact($: EngineInterface, key: string): Promise<Awaited<ReturnType<HubMods['read']>> | undefined> {
  try {
    return (await $.mods.read({ key })) ?? undefined
  } catch {
    return undefined
  }
}

/** Whether the shared panel shows tab `id` now; read while drawing, it subscribes the drawing. */
async function hubTabIs($: EngineInterface, id: string): Promise<boolean> {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
  return value === id
}
// #endregion @vendored shared/hub-client.ts
