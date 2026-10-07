import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import { PROMPT_CHARS, SYSTEM, fallbackReason, filesMatching, glimpseOf, historyText, lastTurnText, parseReasons, reasonsPrompt } from './why'
import type { Touch, WhyEntry } from './why'

const STORE_PREFIX = 'why:'
const MAX_ENTRIES = 2_000
const MAX_FILES_PER_TURN = 60
const MAX_TOKENS = 1_500
const MODEL_TIMEOUT_MS = 45_000
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const
const ENDED_EARLY = '(the session ended before this turn finished)'

type Settings = { model: string }

/** The main-loop turn under way: its request and the files it changed so far. */
type Turn = { turnId: string; prompt: string; touches: Map<string, Touch> }

type Session = {
  root: string | undefined
  turn: Turn | undefined
  /** Store writes, one after another, so a reason never lands on a stale copy of the log. */
  queue: Promise<void>
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

async function rootOf($: EngineInterface, session: Session): Promise<string> {
  if (session.root === undefined) session.root = (await $.session.root().catch(() => '')).replace(/[\\/]+$/, '')
  return session.root
}

const isEntry = (value: unknown): value is WhyEntry => {
  const entry = value as Partial<WhyEntry> | null
  return typeof entry === 'object' && entry !== null && typeof entry.file === 'string' && typeof entry.turnId === 'string'
}

async function load($: EngineInterface, session: Session): Promise<WhyEntry[]> {
  const stored = await $.store.get(`${STORE_PREFIX}${await rootOf($, session)}`).catch(() => undefined)
  return Array.isArray(stored) ? stored.filter(isEntry) : []
}

/** Saves the project's log, the oldest entries dropped past the cap; halves it once if the store is full. */
async function save($: EngineInterface, session: Session, entries: readonly WhyEntry[]): Promise<void> {
  const key = `${STORE_PREFIX}${await rootOf($, session)}`
  const kept = entries.slice(-MAX_ENTRIES)
  try {
    await $.store.set(key, kept)
  } catch (error) {
    $.ui.log(`why-log: the store refused the log (${messageOf(error)}); keeping the newest half`, { to: 'debug' })
    await $.store.set(key, kept.slice(-Math.floor(kept.length / 2))).catch(() => undefined)
  }
}

function serially(session: Session, work: () => Promise<void>): Promise<void> {
  session.queue = session.queue.then(work).catch(() => undefined)
  return session.queue
}

/** Files a finished turn's changes, then asks the small model for one reason per file. */
async function record($: EngineInterface, session: Session, settings: Settings, turn: Turn, answer: string): Promise<void> {
  const touches = [...turn.touches.values()]
  const at = await $.clock.now()
  await serially(session, async () => {
    const added: WhyEntry[] = touches.map(touch => ({ file: touch.file, at, turnId: turn.turnId, prompt: turn.prompt, reason: '', edits: touch.edits }))
    await save($, session, [...(await load($, session)), ...added])
  })

  let reasons = new Map<string, string>()
  try {
    const reply = await $.model.complete({ model: settings.model, system: SYSTEM, prompt: reasonsPrompt(turn.prompt, answer, touches), maxTokens: MAX_TOKENS, effort: 'low', timeoutMs: MODEL_TIMEOUT_MS })
    if (reply.isAnswered) reasons = parseReasons(reply.text, touches.map(touch => touch.file))
  } catch (error) {
    $.ui.log(`why-log: no reasons this time: ${messageOf(error)}`, { to: 'debug' })
  }
  const fallback = fallbackReason(answer)
  await serially(session, async () => {
    const entries = await load($, session)
    await save($, session, entries.map(entry => (entry.turnId === turn.turnId && entry.reason === '' ? { ...entry, reason: reasons.get(entry.file) ?? fallback } : entry)))
  })
}

async function why($: EngineInterface, session: Session, args: string): Promise<string> {
  await session.queue
  const entries = await load($, session)
  const root = await rootOf($, session)
  const query = args.trim()
  if (query === '') return lastTurnText(entries)
  const relative = root !== '' && query.startsWith(`${root}/`) ? query.slice(root.length + 1) : query
  const files = filesMatching(entries, relative)
  if (files.length === 0) return `No recorded changes for ${query}. why-log records edits Claude makes from now on.`
  if (files.length > 1) return `Which one? ${files.join(', ')}`
  return historyText(entries, files[0] ?? relative)
}

export const register: Register = (on, options: PluginOptions) => {
  const settings: Settings = { model: (typeof options.model === 'string' ? options.model.trim() : '') || 'haiku' }
  const session: Session = { root: undefined, turn: undefined, queue: Promise.resolve() }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'why', description: "Why files were changed: the last turn's reasons, or a file's history", argumentHint: '[file]' })
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    session.turn = { turnId: e.turnId, prompt: e.text.replace(/\s+/g, ' ').trim().slice(0, PROMPT_CHARS), touches: new Map() }
    return next(e)
  })

  on('tool.call', { tool: EDIT_TOOLS }, async ($, e, next) => {
    const ran = await next(e)
    const { turn } = session
    if (turn === undefined || ran.deny !== undefined || ran.isError === true) return ran
    const path = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
    const root = await rootOf($, session)
    const file = root !== '' && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
    const glimpse = glimpseOf(e.tool === 'Edit' ? e.new_string : e.tool === 'Write' ? e.content : e.new_source)
    const touch = turn.touches.get(file)
    if (touch !== undefined) touch.edits += 1
    else if (turn.touches.size < MAX_FILES_PER_TURN) turn.touches.set(file, { file, edits: 1, glimpse })
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const { turn } = session
    if (e.agentId !== undefined || turn === undefined) return result
    session.turn = undefined
    if (turn.touches.size > 0) {
      const { answer } = e
      $.clock.after(0, () => void record($, session, settings, turn, answer).catch(error => $.ui.log(`why-log: ${messageOf(error)}`, { to: 'debug' })))
    }
    return result
  })

  // A turn cut short by the session's end is still recorded, with no model call (there is no time for one).
  on('session.end', async ($, e, next) => {
    const { turn } = session
    session.turn = undefined
    if (turn !== undefined && turn.touches.size > 0) {
      const at = await $.clock.now()
      const added = [...turn.touches.values()].map(touch => ({ file: touch.file, at, turnId: turn.turnId, prompt: turn.prompt, reason: ENDED_EARLY, edits: touch.edits }))
      await serially(session, async () => save($, session, [...(await load($, session)), ...added]))
    }
    return next(e)
  })

  on('command.run', { command: 'why' }, async ($, e) => {
    try {
      return { text: await why($, session, e.args) }
    } catch (error) {
      return { text: `Failed: ${messageOf(error)}` }
    }
  })
}
