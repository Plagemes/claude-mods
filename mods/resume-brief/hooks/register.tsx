import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import type { Brief } from '../types'

const DEFAULT_MAX_AGE_DAYS = 14
const DAY_MS = 86_400_000
const PROMPTS_KEPT = 3
const FILES_KEPT = 8
const FILES_SHOWN = 3
const TODOS_KEPT = 8
const LINE_CHARS = 160
const GIT_TIMEOUT_MS = 3_000
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/** mods-hub's heartbeat file: one entry per live session, with its last global events. */
const HUB_SESSIONS = '.claude/claude-mods/hub/sessions.json'
const DECISIONS_KEPT = 5

const briefAtom = atom({ plugin: 'resume-brief', key: 'brief' } as const, null)
const isHiddenAtom = atom({ plugin: 'resume-brief', key: 'isHidden' } as const, false)
const othersAtom = atom({ plugin: 'resume-brief', key: 'others' } as const, 0)

/** What mods-hub's sessions.json says about this project: other live sessions, and decisions recorded since a time. */
type Neighbours = { others: number; decisions: string[] }

/** What this load caches between saves: the branch, read once per turn off the hot path. */
type Saver = { branch: string; isInteractive: boolean }

const storeKey = (root: string): string => `brief:${root.replace(/[\\/]+$/, '')}`
const clip = (text: string): string => (text.length > LINE_CHARS ? `${text.slice(0, LINE_CHARS - 1)}…` : text)
const firstLine = (text: string): string => clip(text.trim().split('\n')[0]?.trim() ?? '')
const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

function relativeTo(root: string, path: string): string {
  const prefix = `${root.replace(/[\\/]+$/, '')}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

function isBrief(value: unknown): value is Brief {
  if (typeof value !== 'object' || value === null) return false
  const brief = value as Record<string, unknown>
  return typeof brief.sessionId === 'string' && typeof brief.savedAt === 'number' && Array.isArray(brief.prompts)
}

/** The brief the transcript supports, or undefined for a session with no request yet. */
function briefOf(messages: readonly SessionMessage[], root: string): Omit<Brief, 'sessionId' | 'savedAt' | 'branch'> | undefined {
  const prompts: string[] = []
  const files: string[] = []
  let todos: string[] = []
  let lastAnswer = ''
  for (const message of messages) {
    const text = message.text.trim()
    if (message.role === 'user' && text && !message.toolResults?.length && !text.startsWith('<')) prompts.push(firstLine(text))
    if (message.role === 'assistant' && text) lastAnswer = firstLine(text)
    for (const use of message.toolUses) {
      const path = use.input.file_path ?? use.input.notebook_path
      if (EDIT_TOOLS.has(use.tool) && typeof path === 'string' && use.isError !== true) {
        const relative = relativeTo(root, path)
        const earlier = files.indexOf(relative)
        if (earlier >= 0) files.splice(earlier, 1)
        files.push(relative)
      }
      if (use.tool === 'TodoWrite' && Array.isArray(use.input.todos)) {
        todos = use.input.todos
          .filter((todo): todo is { content: string; status: string } => typeof todo?.content === 'string')
          .filter(todo => todo.status !== 'completed')
          .map(todo => clip(todo.content))
      }
    }
  }
  if (prompts.length === 0) return undefined

  return { prompts: prompts.slice(-PROMPTS_KEPT), files: files.slice(-FILES_KEPT), todos: todos.slice(0, TODOS_KEPT), lastAnswer }
}

function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 2) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 36) return `${hours} h ago`
  return `${Math.round(hours / 24)} days ago`
}

function filesLine(files: readonly string[]): string {
  const shown = files.slice(-FILES_SHOWN).reverse().map(baseName).join(', ')
  return files.length > FILES_SHOWN ? `${shown} +${files.length - FILES_SHOWN}` : shown
}

function continuePrompt(brief: Brief, now: number, decisions: readonly string[] = []): string {
  const lines = [`Continue where we left off. In the last session (${brief.branch ? `on branch ${brief.branch}, ` : ''}${ago(now - brief.savedAt)}):`]
  lines.push(`- My last requests: ${brief.prompts.map(prompt => `"${prompt}"`).join('; ')}`)
  if (brief.files.length > 0) lines.push(`- Files you edited: ${brief.files.join(', ')}`)
  if (brief.todos.length > 0) lines.push(`- Todos still open: ${brief.todos.join('; ')}`)
  if (brief.lastAnswer) lines.push(`- Where you stopped: ${brief.lastAnswer}`)
  if (decisions.length > 0) lines.push(`- Decided since, in other sessions: ${decisions.join('; ')}`)
  lines.push('Check the current state of those files first, then pick up the unfinished work.')

  return lines.join('\n')
}

// ── mods-hub: the other sessions on this project ────────────────────────────────────────────────────

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Says hello to mods-hub when it is installed; false without it. */
async function greetHub($: EngineInterface): Promise<boolean> {
  if ((await hubMode($)) === undefined) return false
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: ['session.started', 'decision.recorded'] })
  return true
}

/** Whether a session working in `cwd` works on the project at `root`. */
const isSameProject = (cwd: unknown, root: string): boolean => {
  const base = root.replace(/[\\/]+$/, '')
  return typeof cwd === 'string' && (cwd.replace(/[\\/]+$/, '') === base || cwd.startsWith(`${base}/`))
}

/**
 * Reads mods-hub's sessions.json (written only while the hub is installed): how many OTHER live sessions work
 * on this project, and the decisions any of them recorded (`decision.recorded`, global) after `since`.
 */
async function neighboursOf($: EngineInterface, since: number): Promise<Neighbours> {
  const none: Neighbours = { others: 0, decisions: [] }
  try {
    const home = await $.env.get('HOME')
    if (home === undefined || home === '') return none
    const sessions = JSON.parse(await $.fs.read(`${home}/${HUB_SESSIONS}`)) as Record<string, { id?: unknown; cwd?: unknown; events?: unknown }>
    const root = await $.session.root()
    const own = await $.session.id()
    let others = 0
    const decisions: { at: number; title: string }[] = []
    for (const [id, entry] of Object.entries(sessions)) {
      if (typeof entry !== 'object' || entry === null || !isSameProject(entry.cwd, root)) continue
      if (id !== own) others += 1
      for (const event of Array.isArray(entry.events) ? entry.events : []) {
        const { topic, at, data } = (event ?? {}) as { topic?: unknown; at?: unknown; data?: { title?: unknown } }
        if (topic === 'decision.recorded' && typeof at === 'number' && at > since && typeof data?.title === 'string') decisions.push({ at, title: clip(data.title) })
      }
    }
    const titles = [...new Set(decisions.sort((a, b) => a.at - b.at).map(decision => decision.title))]
    return { others, decisions: titles.slice(-DECISIONS_KEPT) }
  } catch {
    return none
  }
}

async function branchOf($: EngineInterface): Promise<string> {
  try {
    const out = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS })
    const branch = out.stdout.trim()
    return out.exitCode === 0 && branch !== 'HEAD' ? branch : ''
  } catch {
    return ''
  }
}

/** Saves where this session stands, keeping the previous brief when there is nothing to say yet. */
async function saveBrief($: EngineInterface, saver: Saver, sessionId: string): Promise<void> {
  const root = await $.session.root()
  const facts = briefOf(await $.session.messages(), root)
  if (facts === undefined) return
  const brief: Brief = { sessionId, savedAt: await $.clock.now(), branch: saver.branch, ...facts }
  await $.store.set(storeKey(root), brief)
}

async function saveAfterTurn($: EngineInterface, saver: Saver): Promise<void> {
  try {
    saver.branch = await branchOf($)
    await saveBrief($, saver, await $.session.id())
  } catch {
    // A brief that cannot be saved now is saved after the next turn or at exit.
  }
}

/** The stored brief of the previous session in this project, when it is recent enough to show. */
async function previousBrief($: EngineInterface, maxAgeMs: number): Promise<Brief | undefined> {
  const stored = await $.store.get(storeKey(await $.session.root()))
  if (!isBrief(stored)) return undefined
  const isOwn = stored.sessionId === (await $.session.id())
  const isFresh = (await $.clock.now()) - stored.savedAt <= maxAgeMs

  return !isOwn && isFresh ? stored : undefined
}

async function showBrief($: EngineInterface, maxAgeMs: number): Promise<Brief | undefined> {
  const brief = await previousBrief($, maxAgeMs)
  await update($, briefAtom, () => brief ?? null)
  await update($, isHiddenAtom, () => brief === undefined)

  return brief
}

async function continueWork($: EngineInterface): Promise<void> {
  const brief = await read($, briefAtom)
  await update($, isHiddenAtom, () => true)
  if (brief === null) return
  const { decisions } = (await hubMode($)) === undefined ? { decisions: [] } : await neighboursOf($, brief.savedAt)
  await $.prompt.submit({ text: continuePrompt(brief, await $.clock.now(), decisions), asUser: true })
}

async function hide($: EngineInterface): Promise<void> {
  if (!(await read($, isHiddenAtom))) await update($, isHiddenAtom, () => true)
}

async function briefCommand($: EngineInterface, maxAgeMs: number): Promise<string> {
  const brief = await showBrief($, maxAgeMs)
  if (brief === undefined) return 'No earlier session to resume in this project.'
  return `↩ Shown above the prompt. Press Continue to pick up “${brief.prompts.at(-1) ?? ''}”.`
}

export const register: Register = (on, options) => {
  const days = typeof options.maxAgeDays === 'number' ? options.maxAgeDays : DEFAULT_MAX_AGE_DAYS
  const maxAgeMs = Math.max(0, days) * DAY_MS
  const saver: Saver = { branch: '', isInteractive: true }

  on('session.start', async ($, e, next) => {
    saver.isInteractive = e.isInteractive
    await $.command.register({ name: 'resume-brief', description: 'Show what you were working on in the last session' })
    if (e.isInteractive) await showBrief($, maxAgeMs)
    if ((await greetHub($)) && e.isInteractive) {
      const { others } = await neighboursOf($, Number.POSITIVE_INFINITY)
      await update($, othersAtom, () => others)
    }

    return next(e)
  })

  on('command.run', { command: 'resume-brief' }, async $ => ({ text: await briefCommand($, maxAgeMs) }))

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer') await hide($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && saver.isInteractive) $.clock.after(0, () => void saveAfterTurn($, saver))

    return result
  })

  on('session.end', async ($, e, next) => {
    try {
      if (saver.isInteractive) await saveBrief($, saver, e.sessionId)
    } catch {
      // Exiting stays fast; the brief saved after the last turn stands.
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const brief = await read($, briefAtom)
    if (e.props.hasSurvey || brief === null || (await read($, isHiddenAtom))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    // Other plugins' bands draw beneath this one rather than being replaced by it.
    const below = await next(e)
    const when = ago((await $.clock.now()) - brief.savedAt)
    const others = await read($, othersAtom)
    const facts = [
      brief.files.length > 0 ? `Edited ${filesLine(brief.files)}` : '',
      brief.todos.length > 0 ? `${brief.todos.length} open todo${brief.todos.length === 1 ? '' : 's'}` : '',
    ].filter(Boolean)

    return (
      <Box flexDirection="column">
        <Box key="brief" flexDirection="column" width={e.props.bodyColumns}>
          <Text wrap="truncate-end">
            <Text bold>↩ Last session</Text>
            <Text dimColor>
              {' '}
              · {when}
              {brief.branch ? ` · ${brief.branch}` : ''}
            </Text>
          </Text>
          <Text wrap="truncate-end">
            You asked: “{brief.prompts.at(-1) ?? ''}”
          </Text>
          {facts.length > 0 && (
            <Text dimColor wrap="truncate-end">
              {facts.join(' · ')}
            </Text>
          )}
          {others > 0 && (
            <Text color="warning" wrap="truncate-end">
              {others === 1 ? '1 other session is' : `${others} other sessions are`} open on this project now
            </Text>
          )}
          <Box flexDirection="row" gap={1}>
            <Button key="continue" label="Continue" hotkey="c" variant="primary" onPress={() => continueWork($)} />
            <Button key="dismiss" label="Dismiss" hotkey="x" role="dismiss" onPress={() => hide($)} />
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
