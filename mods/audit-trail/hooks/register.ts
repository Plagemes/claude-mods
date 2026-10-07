import type { EngineInterface, Register, ToolCallResult, TurnUsage } from 'claude-code'

import { sha256Hex } from './sha256'
import { clip, redact, summarize } from './summary'

type PromptMode = 'hash' | 'text' | 'none'
type Settings = { directory: string; prompts: PromptMode }
type Outcome = 'ok' | 'error' | 'denied'
type Fields = Readonly<Record<string, string | number | undefined>>
type Pending = { directory: string; day: string; line: string }
/** Everything that changes while the module is loaded: lines waiting for the disk, and the write in flight. */
type Trail = {
  pending: Pending[]
  isScheduled: boolean
  writing: Promise<void> | undefined
  sessionId: string | undefined
  hasWarned: boolean
  /** mods-hub is installed, and how far its bus was read into the log. */
  hasHub: boolean
  eventsSeenAt: number
}

const DEFAULT_DIRECTORY = '.claude/audit'
const MAX_SUMMARY_LENGTH = 200
const MAX_PROMPT_TEXT_LENGTH = 2000
/** `$.fs` refuses to read or write more than 4 MiB; a day's log moves on to a new part well before that, even in UTF-8. */
const MAX_PART_CHARS = 1_000_000
const MAX_PARTS = 100
/** Claude Code's wording when the person answers "no" at a permission prompt, or a permission rule refuses the call. */
const PERMISSION_REFUSAL = /^(?:The user doesn't want to proceed|Permission (?:to use .+|for this action) has been denied)/
const ABSOLUTE_PATH = /^(?:[\\/]|[A-Za-z]:[\\/])/
/** How often, with mods-hub installed, the bus's new events are written to the log. */
const EVENT_POLL_MS = 10_000
const MAX_EVENTS_READ = 50

const pad = (n: number): string => String(n).padStart(2, '0')

/** The local calendar day, `YYYY-MM-DD`: one file per day of the person's own clock. */
const localDay = (ms: number): string => {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const fileName = (day: string, part: number): string => (part === 1 ? `${day}.jsonl` : `${day}.${part}.jsonl`)

const modeOf = (value: unknown): PromptMode => (value === 'text' || value === 'none' ? value : 'hash')

const outcomeOf = (ran: ToolCallResult): Outcome => {
  if (ran.deny !== undefined) return 'denied'
  if (ran.isError === true) return PERMISSION_REFUSAL.test(ran.text ?? '') ? 'denied' : 'error'
  return 'ok'
}

const promptFields = (text: string, mode: PromptMode): Fields => {
  if (mode === 'hash') return { chars: text.length, sha256: sha256Hex(text) }
  if (mode === 'text') return { chars: text.length, text: clip(redact(text.slice(0, MAX_PROMPT_TEXT_LENGTH * 8)), MAX_PROMPT_TEXT_LENGTH) }
  return { chars: text.length }
}

const tokensOf = (usage: TurnUsage | undefined): Fields =>
  usage === undefined ? {} : { inputTokens: usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens, outputTokens: usage.output_tokens }

/** The folder the log goes to: relative paths start at the project root, `~/` at the home folder. */
const resolveDirectory = async ($: EngineInterface, configured: string): Promise<string> => {
  const directory = (configured.trim() || DEFAULT_DIRECTORY).replace(/[\\/]+$/, '')
  if (ABSOLUTE_PATH.test(directory)) return directory
  if (directory.startsWith('~/')) {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
    if (home !== undefined && home !== '') return `${home.replace(/[\\/]+$/, '')}${directory.slice(1)}`
  }
  return `${await $.session.root()}/${directory.replace(/^~\//, '')}`
}

const warnOnce = ($: EngineInterface, trail: Trail, error: unknown): void => {
  const reason = error instanceof Error ? error.message : String(error)
  $.ui.log(`audit-trail: could not write the log: ${reason}`, { to: 'debug' })
  if (trail.hasWarned) return
  trail.hasWarned = true
  $.ui.toast('could not write the audit log; actions are not being recorded')
}

/** The text of a log file, '' when there is none yet, undefined when it is there but cannot be read (too big). */
const readLog = async ($: EngineInterface, path: string): Promise<string | undefined> => {
  if (!(await $.fs.exists(path))) return ''
  return $.fs.read(path).catch(() => undefined)
}

/** Appends lines to the day's log, moving on to a numbered part when one is full. `$.fs` has no append, so this reads then writes. */
const appendLines = async ($: EngineInterface, directory: string, day: string, lines: readonly string[]): Promise<void> => {
  const added = `${lines.join('\n')}\n`
  for (let part = 1; part <= MAX_PARTS; part++) {
    const path = `${directory}/${fileName(day, part)}`
    const existing = await readLog($, path)
    if (existing !== undefined && existing.length + added.length <= MAX_PART_CHARS) {
      await $.fs.write(path, existing + added)
      return
    }
  }
  throw new Error(`more than ${MAX_PARTS} log parts for ${day}`)
}

/** Writes everything waiting, one file at a time, until nothing is left. */
const drain = async ($: EngineInterface, trail: Trail): Promise<void> => {
  while (trail.pending.length > 0) {
    const batch = trail.pending.splice(0)
    const files = new Map<string, { directory: string; day: string; lines: string[] }>()
    for (const { directory, day, line } of batch) {
      const key = `${directory}\n${day}`
      const file = files.get(key) ?? { directory, day, lines: [] }
      file.lines.push(line)
      files.set(key, file)
    }
    for (const { directory, day, lines } of files.values()) {
      await appendLines($, directory, day, lines).catch((error: unknown) => warnOnce($, trail, error))
    }
  }
}

/** Starts writing if nothing is, and resolves when the lines waiting now are on disk. */
const flush = ($: EngineInterface, trail: Trail): Promise<void> => {
  trail.writing ??= drain($, trail).finally(() => {
    trail.writing = undefined
  })
  return trail.writing
}

/** Queues one line. The write itself runs from a timer, so a tool call never waits for the disk. */
const record = async ($: EngineInterface, trail: Trail, settings: Settings, fields: Fields): Promise<void> => {
  try {
    const now = await $.clock.now()
    trail.sessionId ??= await $.session.id()
    const entry = { ts: new Date(now).toISOString(), session: trail.sessionId, ...fields }
    trail.pending.push({ directory: await resolveDirectory($, settings.directory), day: localDay(now), line: JSON.stringify(entry) })
    if (trail.isScheduled) return
    trail.isScheduled = true
    $.clock.after(0, () => {
      trail.isScheduled = false
      void flush($, trail)
    })
  } catch (error) {
    warnOnce($, trail, error)
  }
}

type DayTotals = { entries: number; kinds: Record<string, number>; denied: number; errors: number; paths: string[] }

/** Counts today's entries across all of the day's parts. */
const readDay = async ($: EngineInterface, directory: string, day: string): Promise<DayTotals> => {
  const totals: DayTotals = { entries: 0, kinds: {}, denied: 0, errors: 0, paths: [] }
  const names = await $.fs.list(directory).then(
    found => found.map(entry => entry.name),
    () => [],
  )
  const parts = names.filter(name => name.startsWith(`${day}.`) && name.endsWith('.jsonl')).sort()
  for (const name of parts) {
    const path = `${directory}/${name}`
    const text = await $.fs.read(path).catch(() => '')
    totals.paths.push(path)
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      totals.entries += 1
      try {
        const entry = JSON.parse(line) as { kind?: string; outcome?: string }
        const kind = entry.kind ?? 'other'
        totals.kinds[kind] = (totals.kinds[kind] ?? 0) + 1
        if (entry.outcome === 'denied') totals.denied += 1
        if (entry.outcome === 'error') totals.errors += 1
      } catch {
        totals.kinds.unreadable = (totals.kinds.unreadable ?? 0) + 1
      }
    }
  }
  return totals
}

const describeDay = (day: string, directory: string, totals: DayTotals): string => {
  if (totals.entries === 0) return `Nothing logged yet today. Entries go to ${directory}/${fileName(day, 1)}.`
  const detail = [
    `${totals.kinds.tool ?? 0} tool calls (${totals.denied} denied, ${totals.errors} failed)`,
    `${totals.kinds.prompt ?? 0} prompts`,
    `${totals.kinds.turn ?? 0} turns`,
    ...(totals.kinds.event === undefined ? [] : [`${totals.kinds.event} mods-hub events`]),
  ].join(' · ')
  return [`${totals.entries} entries logged today (${day}): ${detail}`, ...totals.paths].join('\n')
}

// ── mods-hub: everything on the bus goes in the log too ─────────────────────────────────────────────

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
const ownVersion = async ($: EngineInterface): Promise<string> => {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** With mods-hub installed: hello, and the bus read into the log every 10 seconds. */
const greetHub = async ($: EngineInterface, trail: Trail, settings: Settings): Promise<void> => {
  trail.hasHub = (await hubMode($)) !== undefined
  if (!trail.hasHub) return
  trail.eventsSeenAt = await $.clock.now()
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: ['*', 'risk.blocked'] })
  $.clock.every(EVENT_POLL_MS, () => void logEvents($, trail, settings))
}

/**
 * The bus's events since the last look, one line each (`kind: event`): topic, the mod that published it (stamped
 * by the hub), and its payload masked and cut to one line. A guard's `risk.blocked` keeps the guard, the severity
 * and the reason as fields of their own, with the outcome `denied`.
 */
const logEvents = async ($: EngineInterface, trail: Trail, settings: Settings): Promise<void> => {
  if (!trail.hasHub) return
  let events
  try {
    events = await $.mods.recent({ since: trail.eventsSeenAt, limit: MAX_EVENTS_READ })
  } catch {
    return
  }
  for (const event of events) {
    trail.eventsSeenAt = Math.max(trail.eventsSeenAt, event.at)
    const data = (typeof event.data === 'object' && event.data !== null ? event.data : {}) as Record<string, unknown>
    const field = (key: string): string | undefined => (typeof data[key] === 'string' ? clip(redact(String(data[key])), MAX_SUMMARY_LENGTH) : undefined)
    const guarded = event.topic === 'risk.blocked' ? { guard: field('guard'), severity: field('severity'), reason: field('reason'), outcome: 'denied' } : {}
    await record($, trail, settings, {
      kind: 'event',
      topic: event.topic,
      source: event.source,
      summary: clip(redact(JSON.stringify(event.data)), MAX_SUMMARY_LENGTH),
      ...guarded,
    })
  }
}

export const register: Register = (on, options) => {
  const settings: Settings = { directory: String(options.directory ?? DEFAULT_DIRECTORY), prompts: modeOf(options.prompts) }
  const trail: Trail = { pending: [], isScheduled: false, writing: undefined, sessionId: undefined, hasWarned: false, hasHub: false, eventsSeenAt: 0 }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'audit', description: "Shows how many actions today's audit log holds, and where it is." })
    await greetHub($, trail, settings)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const tool = String(e.tool)
    await record($, trail, settings, {
      kind: 'tool',
      tool,
      summary: summarize(tool, e, MAX_SUMMARY_LENGTH),
      outcome: outcomeOf(ran),
      agent: e.agentId,
      // A call another mod made with its own `$.tool.call`, not one the model asked for.
      by: next.origin.plugin === 'engine' ? undefined : next.origin.plugin,
    })
    return ran
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    await record($, trail, settings, {
      kind: 'prompt',
      origin: e.origin.kind,
      outcome: result.drop === undefined ? 'ok' : 'denied',
      ...promptFields(e.text, settings.prompts),
    })
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await record($, trail, settings, {
      kind: 'turn',
      outcome: e.reason === 'answer' ? 'ok' : e.reason,
      durationMs: e.durationMs,
      agent: e.agentId,
      ...tokensOf(e.usage),
    })
    return result
  })

  // A session that ends has about a second and a half; the lines still waiting are written before it closes.
  on('session.end', async ($, e, next) => {
    await logEvents($, trail, settings)
    await flush($, trail)
    return next(e)
  })

  on('command.run', { command: 'audit' }, async $ => {
    await logEvents($, trail, settings)
    await flush($, trail)
    const directory = await resolveDirectory($, settings.directory)
    const day = localDay(await $.clock.now())
    return { text: describeDay(day, directory, await readDay($, directory, day)) }
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
