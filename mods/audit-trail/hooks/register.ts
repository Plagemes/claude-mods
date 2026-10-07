import type { EngineInterface, Register, ToolCallResult, TurnUsage } from 'claude-code'

import { sha256Hex } from './sha256'
import { clip, redact, summarize } from './summary'

type PromptMode = 'hash' | 'text' | 'none'
type Settings = { directory: string; prompts: PromptMode }
type Outcome = 'ok' | 'error' | 'denied'
type Fields = Readonly<Record<string, string | number | undefined>>
type Pending = { directory: string; day: string; line: string }
/** Everything that changes while the module is loaded: lines waiting for the disk, and the write in flight. */
type Trail = { pending: Pending[]; isScheduled: boolean; writing: Promise<void> | undefined; sessionId: string | undefined; hasWarned: boolean }

const DEFAULT_DIRECTORY = '.claude/audit'
const MAX_SUMMARY_LENGTH = 200
const MAX_PROMPT_TEXT_LENGTH = 2000
/** `$.fs` refuses to read or write more than 4 MiB; a day's log moves on to a new part well before that, even in UTF-8. */
const MAX_PART_CHARS = 1_000_000
const MAX_PARTS = 100
/** Claude Code's wording when the person answers "no" at a permission prompt, or a permission rule refuses the call. */
const PERMISSION_REFUSAL = /^(?:The user doesn't want to proceed|Permission (?:to use .+|for this action) has been denied)/
const ABSOLUTE_PATH = /^(?:[\\/]|[A-Za-z]:[\\/])/

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
  ].join(' · ')
  return [`${totals.entries} entries logged today (${day}): ${detail}`, ...totals.paths].join('\n')
}

export const register: Register = (on, options) => {
  const settings: Settings = { directory: String(options.directory ?? DEFAULT_DIRECTORY), prompts: modeOf(options.prompts) }
  const trail: Trail = { pending: [], isScheduled: false, writing: undefined, sessionId: undefined, hasWarned: false }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'audit', description: "Shows how many actions today's audit log holds, and where it is." })
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
    await flush($, trail)
    return next(e)
  })

  on('command.run', { command: 'audit' }, async $ => {
    await flush($, trail)
    const directory = await resolveDirectory($, settings.directory)
    const day = localDay(await $.clock.now())
    return { text: describeDay(day, directory, await readDay($, directory, day)) }
  })
}
