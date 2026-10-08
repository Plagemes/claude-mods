import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HandoffView } from '../types'
import { composeNote, decisionsOf, handoffPrompt, missingSections, sectionsOf, stampOf } from './note'
import type { Decision, GitFacts } from './note'
import { paneFailure } from './shared/render-safe'

const PANE = 'handoff'
const GIT_TIMEOUT_MS = 10_000
/** mods-hub's heartbeat file: one entry per live session, with its last global events. */
const HUB_SESSIONS = '.claude/claude-mods/hub/sessions.json'
/** Decisions recorded in the last day count as this work's. */
const DECISION_WINDOW_MS = 24 * 3_600_000
const STATUS_LINES = 40
const STAT_LINES = 30
const MAX_SUFFIX = 20

const viewAtom = atom({ plugin: 'handoff', key: 'view' } as const, null)

type Settings = { dir: string; copy: boolean; isHubbed: boolean }

/** A failure's detail is a lowercase clause; as a command answer it starts a sentence. */
const asSentence = (clause: string): string => clause.charAt(0).toUpperCase() + clause.slice(1)

const capLines = (text: string, max: number): string => {
  const lines = text.trimEnd().split('\n').filter(line => line.trim() !== '')
  return lines.length > max ? [...lines.slice(0, max), `… ${lines.length - max} more`].join('\n') : lines.join('\n')
}

async function git($: EngineInterface, args: readonly string[]): Promise<string | undefined> {
  try {
    const run = await $.process.run(['git', ...args], { timeoutMs: GIT_TIMEOUT_MS })
    return run.exitCode === 0 ? run.stdout : undefined
  } catch {
    return undefined
  }
}

async function gitFacts($: EngineInterface): Promise<GitFacts | undefined> {
  const branch = (await git($, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim()
  if (branch === undefined) return undefined
  return {
    branch,
    status: capLines((await git($, ['status', '--short'])) ?? '', STATUS_LINES),
    diffStat: capLines((await git($, ['diff', '--stat', 'HEAD'])) ?? '', STAT_LINES),
    commits: capLines((await git($, ['log', '-5', '--format=%h %s'])) ?? '', 5),
  }
}

/**
 * The decisions the hub has seen recorded (`decision.recorded`) in the last day: this session's, and those other
 * sessions on the same project published for everyone (the hub's sessions.json); nothing without the hub.
 */
async function hubDecisions($: EngineInterface, root: string, now: number): Promise<Decision[]> {
  const since = now - DECISION_WINDOW_MS
  const events: unknown[] = []
  try {
    events.push(...(await $.mods.recent({ topic: 'decision.recorded' })))
  } catch {
    return []
  }
  try {
    const home = await $.env.get('HOME')
    const sessions: unknown = home === undefined || home === '' ? {} : JSON.parse(await $.fs.read(`${home}/${HUB_SESSIONS}`))
    for (const entry of typeof sessions === 'object' && sessions !== null ? Object.values(sessions) : []) {
      const { cwd, events: own } = (entry ?? {}) as { cwd?: unknown; events?: unknown }
      if (typeof cwd === 'string' && (cwd === root || cwd.startsWith(`${root}/`)) && Array.isArray(own)) events.push(...own)
    }
  } catch {
    // No heartbeat file: this session's decisions are enough.
  }
  return decisionsOf(events, since)
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

/** With mods-hub installed: hello (this mod reads `decision.recorded`, and the other sessions' heartbeats). */
async function greetHub($: EngineInterface, settings: Settings): Promise<void> {
  if ((await hubMode($)) === undefined) return
  settings.isHubbed = await hubHello($, { version: await ownVersion($), publishes: [], consumes: ['decision.recorded', 'session.ended'] })
}

/** `.claude/handoff/2026-10-07-1342.md`, or `-2`, `-3`… when that minute already has one. */
async function freePath($: EngineInterface, dir: string, stamp: string): Promise<string> {
  for (let n = 1; n <= MAX_SUFFIX; n += 1) {
    const path = `${dir}/${stamp}${n === 1 ? '' : `-${n}`}.md`
    if (!(await $.fs.exists(path))) return path
  }
  return `${dir}/${stamp}-${Date.now()}.md`
}

async function writeHandoff($: EngineInterface, settings: Settings, note: string): Promise<HandoffView> {
  const set = async (view: HandoffView): Promise<HandoffView> => {
    await update($, viewAtom, () => view)
    return view
  }
  await set({ status: 'writing', text: '', path: '', isCopied: false, detail: 'Reading the session and git…' })
  const facts = await gitFacts($)
  const decisions = settings.isHubbed ? await hubDecisions($, await $.session.root(), await $.clock.now()) : []
  const reply = await $.model.fork({ prompt: handoffPrompt(facts, note, decisions) })
  if (!reply.isAnswered) {
    const why =
      reply.reason === 'nothing-to-fork' ? 'nothing to hand off yet: this conversation has no work in it.'
        : reply.reason === 'api-error' ? `the model call failed (${reply.error}).`
          : reply.reason === 'aborted' ? 'writing the note was interrupted.'
            : 'the model wrote nothing.'
    return set({ status: 'error', text: '', path: '', isCopied: false, detail: why })
  }
  const when = await $.clock.now()
  const root = await $.session.root()
  const sessionId = await $.session.id().catch(() => undefined)
  const text = composeNote(sectionsOf(reply.text), { when, branch: facts?.branch, sessionId })
  const absolute = await freePath($, `${root}/${settings.dir}`, stampOf(when))
  await $.fs.write(absolute, text)
  const path = absolute.slice(root.length + 1)
  const isCopied = settings.copy && (await $.ui.copy({ text }).catch(() => ({ isCopied: false }))).isCopied
  const missing = missingSections(text)
  const detail = missing.length === 0 ? '' : `Missing sections: ${missing.join(', ')}.`
  return set({ status: 'ready', text, path, isCopied, detail })
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    dir: String(options.dir ?? '').trim().replace(/^\.\/|\/+$/g, '') || '.claude/handoff',
    copy: options.copy !== false,
    isHubbed: false,
  }

  on('session.start', async ($, e, next) => {
    await registerCommand($, {
      name: 'handoff',
      description: 'Write a handoff note (goal, status, changes, next steps) to .claude/handoff and copy it',
      argumentHint: '[what to stress]',
    })
    afterStart($, 'handoff', () => greetHub($, settings))
    return next(e)
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'Handoff', rows: 24 })
    const view = await writeHandoff($, settings, e.args.trim())
    if (view.status !== 'ready') {
      await $.ui.close({ id: PANE })
      return { text: asSentence(view.detail) }
    }
    const copied = view.isCopied ? ' and copied it to the clipboard' : settings.copy ? ' (the clipboard was not reachable; use Copy in the pane)' : ''
    return { text: `Wrote ${view.path}${copied}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const view = await read($, viewAtom)
    if (view === null || view.status === 'writing') {
      return <Text color="suggestion">{view?.detail ?? 'Writing the handoff note…'}</Text>
    }
    const copy = async (surface: typeof e.surface) => {
      const copied = await $.ui.copy({ text: view.text, surface })
      $.ui.toast(copied.isCopied ? 'Note copied' : `Could not copy (${copied.reason})`)
    }

    return (
      <Box flexDirection="column" gap={1}>
        {view.status === 'error' ? (
          <Text color="error">{view.detail}</Text>
        ) : (
          <Box flexDirection="column">
            <Text bold wrap="truncate-end">{`Saved to ${view.path}`}</Text>
            <Text dimColor>{view.isCopied ? 'Copied to the clipboard: paste it where your teammate will see it.' : 'Use Copy to put it on the clipboard.'}</Text>
            {view.detail !== '' && <Text color="warning">{view.detail}</Text>}
          </Box>
        )}
        {view.status === 'ready' && <Markdown key="note" text={view.text} />}
        <Box gap={1}>
          {view.status === 'ready' && <Button key="copy" label="Copy" hotkey="c" variant="primary" onPress={press => void copy(press.surface)} />}
          <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  }).catch(async ($, e, next) =>
    next.error.kind === 're-entry'
      ? next(e)
      : paneFailure($.ui.resolve(e), { title: 'handoff', failure: next.error, below: await next(e).catch(() => null), onRetry: () => $.ui.invalidate('ui.render') }),
  )
}

/** Registers a slash command. A refused name (Claude Code's own, or another mod's) is reported as a notice, never thrown, so the rest of session.start still runs. */
async function registerCommand($: EngineInterface, spec: Parameters<EngineInterface['command']['register']>[0]): Promise<boolean> {
  try {
    await $.command.register(spec)
    return true
  } catch (error) {
    $.ui.log(`${$.plugin.name}: /${spec.name} was not registered (${error instanceof Error ? error.message : String(error)}).`)
    return false
  }
}

// #region @vendored shared/hub-client.ts sha256:6b153e2e759f: edit the source, then run `node scripts/sync-shared.mjs`.
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
/**
 * Runs a mod's start-up work (the hub hello, a first scan, loading what it keeps) once `session.start` has returned,
 * after a short delay staggered by the mod's name (0.15–1.35 s), so ~200 mods sharing one hooks worker do not all wait
 * on the hub, a process or the disk inside the session.start chain (`ran past its 10s budget`). A failure is logged
 * to the debug log. Call it from `session.start` in place of `await work()`; never await the hub there
 * (scripts/check-startup.mjs).
 */
function afterStart($: EngineInterface, mod: string, work: () => Promise<unknown>): void {
  let hash = 7
  for (let i = 0; i < mod.length; i += 1) hash = (hash * 31 + mod.charCodeAt(i)) % 1_200
  $.clock.after(150 + hash, () => {
    void work().catch(error => $.ui.log(`${mod}: start-up work failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' }))
  })
}
// #endregion @vendored shared/hub-client.ts
