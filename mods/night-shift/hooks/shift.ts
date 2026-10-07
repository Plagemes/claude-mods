// Pure parts of the night shift: reading /night-shift arguments, clock times, git output and the report. No `$` here.

import type { ShiftReport, ShiftResult, ShiftRun, ShiftTask, ShiftView } from '../types'

export type ShiftCommand =
  | { kind: 'open' }
  | { kind: 'add'; text: string }
  | { kind: 'list' }
  | { kind: 'remove'; position: number }
  | { kind: 'clear' }
  | { kind: 'at'; hour: number; minute: number }
  | { kind: 'now' }
  | { kind: 'away' }
  | { kind: 'off' }
  | { kind: 'report' }
  | { kind: 'usage'; why: string }

export const EMPTY_VIEW: ShiftView = { tasks: [], at: null, run: null, last: null }

export const USAGE = '/night-shift add <task> · at <HH:MM> · away · now · off · list · remove <n> · clear · report'

const SUMMARY_CHARS = 600
const LABEL_CHARS = 72
const DAY_MS = 24 * 60 * 60 * 1000

/** `HH:MM`, `H:MM`, `2am`, `11:30pm` as a 24-hour time; undefined when it is none. */
export function parseClock(text: string): { hour: number; minute: number } | undefined {
  const found = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(text.trim())
  if (found === null) return undefined
  let hour = Number(found[1])
  const minute = Number(found[2] ?? 0)
  const half = found[3]?.toLowerCase()
  if (found[2] === undefined && half === undefined) return undefined
  if (half !== undefined) {
    if (hour < 1 || hour > 12) return undefined
    hour = (hour % 12) + (half === 'pm' ? 12 : 0)
  }
  return hour <= 23 && minute <= 59 ? { hour, minute } : undefined
}

export function parseShiftArgs(args: string): ShiftCommand {
  const text = args.trim()
  if (text === '') return { kind: 'open' }
  const [head = '', ...rest] = text.split(/\s+/)
  const word = head.toLowerCase()
  const tail = text.slice(head.length).trim()

  if (word === 'add') return tail === '' ? { kind: 'usage', why: 'nothing to add: /night-shift add <task>' } : { kind: 'add', text: tail }
  if (rest.length === 0 && (word === 'list' || word === 'ls')) return { kind: 'list' }
  if (rest.length === 0 && word === 'clear') return { kind: 'clear' }
  if (rest.length === 0 && word === 'now') return { kind: 'now' }
  if (rest.length === 0 && word === 'away') return { kind: 'away' }
  if (rest.length === 0 && (word === 'off' || word === 'cancel' || word === 'stop')) return { kind: 'off' }
  if (rest.length === 0 && word === 'report') return { kind: 'report' }
  if (word === 'remove' || word === 'rm') {
    const position = Number(tail.replace(/^#/, ''))
    return Number.isInteger(position) && position >= 1 ? { kind: 'remove', position } : { kind: 'usage', why: 'which one? /night-shift remove <n>' }
  }
  if (word === 'at') {
    const clock = parseClock(tail)
    return clock === undefined ? { kind: 'usage', why: `"${tail}" is not a time: /night-shift at 02:00 (or 2am)` } : { kind: 'at', ...clock }
  }
  return { kind: 'usage', why: USAGE }
}

/** The next moment, after `now`, the local clock reads hour:minute. */
export function nextOccurrence(now: number, hour: number, minute: number): number {
  const day = new Date(now)
  day.setHours(hour, minute, 0, 0)
  let at = day.getTime()
  if (at <= now) {
    const tomorrow = new Date(now + DAY_MS)
    tomorrow.setHours(hour, minute, 0, 0)
    at = tomorrow.getTime()
  }
  return at
}

const two = (n: number): string => String(n).padStart(2, '0')

/** `02:00`, local time. */
export function clockOf(ms: number): string {
  const day = new Date(ms)
  return `${two(day.getHours())}:${two(day.getMinutes())}`
}

/** `2026-10-07`, local time. */
export function dateOf(ms: number): string {
  const day = new Date(ms)
  return `${day.getFullYear()}-${two(day.getMonth() + 1)}-${two(day.getDate())}`
}

/** Milliseconds as `45s`, `12m`, `2h 5m`. */
export function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function oneLine(text: string, width = LABEL_CHARS): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > width ? `${line.slice(0, Math.max(1, width - 1))}…` : line
}

/** The first paragraphs of an answer, up to about 600 characters. */
export function summarize(answer: string): string {
  const text = answer.trim()
  if (text.length <= SUMMARY_CHARS) return text
  const cut = text.slice(0, SUMMARY_CHARS)
  const lastBreak = cut.lastIndexOf('\n\n')
  return `${(lastBreak > SUMMARY_CHARS / 2 ? cut.slice(0, lastBreak) : cut).trimEnd()} …`
}

/**
 * Files as `git diff --numstat -z` and `git ls-files --others -z` list them, each with a fingerprint of its change,
 * so two snapshots tell which files a task touched.
 */
export function snapshotOf(numstat: string, untracked: string): Map<string, string> {
  const files = new Map<string, string>()
  const fields = numstat.split('\0')
  for (let i = 0; i < fields.length; i += 1) {
    const record = fields[i] ?? ''
    const found = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(record)
    if (found === null) continue
    let path = found[3] ?? ''
    // A rename is `added\tremoved\t` followed by the old and new paths as two more fields.
    if (path === '') {
      path = fields[i + 2] ?? ''
      i += 2
    }
    if (path !== '') files.set(path, `${found[1]}/${found[2]}`)
  }
  for (const path of untracked.split('\0')) if (path !== '') files.set(path, `new`)
  return files
}

/** Paths whose change differs between two snapshots, sorted. */
export function changedBetween(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()])
  return [...paths].filter(path => before.get(path) !== after.get(path)).sort()
}

const GLYPHS: Record<ShiftResult['outcome'], string> = { done: '✓', interrupted: '⏹', failed: '✗', 'timed-out': '⌛' }

export const glyphOf = (outcome: ShiftResult['outcome']): string => GLYPHS[outcome]

export function countDone(results: readonly ShiftResult[]): number {
  return results.filter(result => result.outcome === 'done').length
}

/** The report written to .claude/night-shift/<date>.md, rewritten after every task so a crash leaves what ran. */
export function reportMarkdown(run: ShiftRun, opts: { endedAt: number; reason: string; overall: string; isFinal: boolean }): string {
  const { results } = run
  const counts = (['done', 'failed', 'timed-out', 'interrupted'] as const)
    .map(outcome => [outcome, results.filter(result => result.outcome === outcome).length] as const)
    .filter(([, n]) => n > 0)
    .map(([outcome, n]) => `${n} ${outcome}`)
  const notRun = run.tasks.length - results.length
  const lines = [
    `# Night shift — ${run.date}`,
    '',
    `- Started ${clockOf(run.startedAt)}${opts.isFinal ? `, ended ${clockOf(opts.endedAt)} (${span(opts.endedAt - run.startedAt)})` : ' — still running'}`,
    `- Tasks: ${counts.length > 0 ? counts.join(', ') : 'none finished'}${notRun > 0 ? `; ${notRun} not run` : ''} (of ${run.tasks.length})`,
    ...(opts.reason ? [`- ${opts.isFinal ? 'Ended' : 'Note'}: ${opts.reason}`] : []),
    ...(run.base ? [`- Base commit: \`${run.base.slice(0, 12)}\` (review everything with \`git diff ${run.base.slice(0, 12)}\`)`] : []),
  ]
  results.forEach((result, index) => {
    lines.push(
      '',
      `## ${index + 1}. ${glyphOf(result.outcome)} ${oneLine(result.text, 100)}`,
      '',
      `- ${result.outcome} after ${span(result.durationMs)}`,
      `- Files changed: ${result.files.length > 0 ? result.files.map(file => `\`${file}\``).join(', ') : 'none'}`,
    )
    if (result.text.length > 100) lines.push('', '**Task:**', '', ...result.text.split('\n').map(line => `> ${line}`))
    if (result.summary) lines.push('', '**Claude said:**', '', ...result.summary.split('\n').map(line => `> ${line}`))
  })
  const pending = run.tasks.slice(results.length)
  if (pending.length > 0) {
    lines.push('', '## Not run', '', ...pending.map(task => `- ${oneLine(task.text, 100)}`))
  }
  if (opts.overall.trim() !== '') lines.push('', '## All changes', '', '```', opts.overall.trimEnd(), '```')
  return `${lines.join('\n')}\n`
}

/** The status line: scheduled, running, or a report waiting to be read. */
export function statusText(view: ShiftView, now: number): string | undefined {
  if (view.run !== null) {
    const position = Math.min(view.run.tasks.length, view.run.results.length + 1)
    const since = view.run.current === null ? '' : ` · ${span(now - view.run.current.startedAt)}`
    return `🌙 night shift ${position}/${view.run.tasks.length}${since}`
  }
  if (view.at !== null && view.tasks.length > 0) return `🌙 night shift at ${clockOf(view.at)} · ${view.tasks.length} task${view.tasks.length === 1 ? '' : 's'}`
  if (view.isOnAway === true && view.tasks.length > 0) return `🌙 night shift when you are away · ${view.tasks.length} task${view.tasks.length === 1 ? '' : 's'}`
  if (view.last !== null && !view.last.isSeen) return '🌙 night-shift report ready'
  return undefined
}

/** `/night-shift list`. */
export function listText(view: ShiftView, now: number): string {
  const head =
    view.run !== null
      ? `🌙 Running: task ${Math.min(view.run.tasks.length, view.run.results.length + 1)} of ${view.run.tasks.length}`
      : view.at !== null
        ? `🌙 Starts at ${clockOf(view.at)} (in ${span(view.at - now)})`
        : view.isOnAway === true
          ? '🌙 Starts as soon as you are away (mods-hub)'
          : '🌙 Not scheduled: /night-shift at 02:00, or /night-shift now'
  if (view.tasks.length === 0) return `${head}\nNo tasks queued for the next shift. Add one with /night-shift add <task>.`
  return [head, ...view.tasks.map((task: ShiftTask, index) => `${index + 1}. ${oneLine(task.text)}`)].join('\n')
}

/** `/night-shift report` as text. */
export function reportText(report: ShiftReport): string {
  const head = `🌙 ${report.done}/${report.total} done (${clockOf(report.startedAt)}–${clockOf(report.endedAt)}) · ${report.reason} · ${report.path}`
  return [head, ...report.results.map(result => `${glyphOf(result.outcome)} ${oneLine(result.text, 60)} · ${span(result.durationMs)}`)].join('\n')
}
