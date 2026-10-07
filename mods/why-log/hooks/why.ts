// Pure parts of the why-log: entries, the request for reasons, reading them back, and /why's text. No `$` here.

/** One file changed in one turn, and why. */
export type WhyEntry = {
  file: string
  /** When the turn ended (epoch ms). */
  at: number
  turnId: string
  /** The turn's request, its first 200 characters. */
  prompt: string
  /** One line: why the file was changed; '' while it is being written. */
  reason: string
  edits: number
}

/** What a turn changed in one file, gathered while it runs. */
export type Touch = { file: string; edits: number; glimpse: string }

export const PROMPT_CHARS = 200
const REASON_CHARS = 160
const GLIMPSE_CHARS = 90
const REQUEST_CHARS = 1_000
const ANSWER_CHARS = 2_500
const SHOWN = 20

export const SYSTEM =
  'You label code changes with the reason they were made, for a project change log that people read months later. ' +
  'For each file write one line of at most 20 words that starts with a verb and says why that file changed ' +
  '(for example "Round totals to cents so receipts match the payment provider"). Be specific, no file names, no filler. ' +
  'Use only what the request and the summary say; when the reason is unclear, describe what changed.'

/** The first changed line of an edit, as a hint of what it did. */
export function glimpseOf(text: string): string {
  const line = text.split('\n').map(one => one.trim()).find(one => one !== '' && !/^[{}()[\];,]+$/.test(one)) ?? ''
  return line.length > GLIMPSE_CHARS ? `${line.slice(0, GLIMPSE_CHARS - 1)}…` : line
}

const cut = (text: string, chars: number): string => (text.length > chars ? `${text.slice(0, chars)} […]` : text)

export function reasonsPrompt(request: string, answer: string, touches: readonly Touch[]): string {
  return [
    'The user asked:',
    '"""',
    cut(request.trim() || '(no prompt)', REQUEST_CHARS),
    '"""',
    '',
    "The assistant's final message:",
    '"""',
    cut(answer.trim() || '(none)', ANSWER_CHARS),
    '"""',
    '',
    'Files edited in this turn, with a glimpse of each change:',
    ...touches.map(touch => `- ${touch.file} (${touch.edits} edit${touch.edits === 1 ? '' : 's'})${touch.glimpse ? `: ${touch.glimpse}` : ''}`),
    '',
    'Reply with JSON only, no prose and no code fence: {"<path exactly as listed>": "<reason>"} with every path above.',
  ].join('\n')
}

const tidy = (reason: string): string => {
  const line = reason.replace(/\s+/g, ' ').trim().replace(/^[-*•]\s*/, '').replace(/^["“]|["”]$/g, '')
  return line.length > REASON_CHARS ? `${line.slice(0, REASON_CHARS - 1)}…` : line
}

/** The reasons of the model's reply, by file; files it skipped are left out. */
export function parseReasons(reply: string, files: readonly string[]): Map<string, string> {
  const reasons = new Map<string, string>()
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return reasons
  let parsed: unknown
  try {
    parsed = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return reasons
  }
  if (typeof parsed !== 'object' || parsed === null) return reasons
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const file = files.includes(key) ? key : files.find(one => one.endsWith(`/${key}`))
    if (file !== undefined && typeof value === 'string' && tidy(value) !== '') reasons.set(file, tidy(value))
  }
  return reasons
}

/** When no model reason came: the first sentence of Claude's own summary, marked as such. */
export function fallbackReason(answer: string): string {
  const sentence = answer.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0] ?? ''
  return sentence === '' ? '(no reason recorded)' : tidy(`Turn summary: ${sentence}`)
}

const two = (n: number): string => String(n).padStart(2, '0')
const stamp = (ms: number): string => {
  const day = new Date(ms)
  return `${day.getFullYear()}-${two(day.getMonth() + 1)}-${two(day.getDate())} ${two(day.getHours())}:${two(day.getMinutes())}`
}
const reasonOf = (entry: WhyEntry): string => entry.reason || '(writing the reason…)'
const edits = (entry: WhyEntry): string => (entry.edits > 1 ? ` (${entry.edits} edits)` : '')

/** `/why`: the files of the last turn that changed any, with their reasons. */
export function lastTurnText(entries: readonly WhyEntry[]): string {
  const last = entries.at(-1)
  if (last === undefined) return 'No changes recorded yet in this project. /why fills up as Claude edits files.'
  const turn = entries.filter(entry => entry.turnId === last.turnId)
  return [
    `Last change, ${stamp(last.at)} · asked: "${last.prompt}"`,
    ...turn.map(entry => `- ${entry.file}: ${reasonOf(entry)}${edits(entry)}`),
  ].join('\n')
}

/** The files the log knows that `query` names: the path itself, else paths ending in it. */
export function filesMatching(entries: readonly WhyEntry[], query: string): string[] {
  const wanted = query.trim().replace(/^\.\//, '')
  const known = [...new Set(entries.map(entry => entry.file))]
  if (known.includes(wanted)) return [wanted]
  return known.filter(file => file.endsWith(`/${wanted}`) || file === wanted.split('/').pop())
}

/** `/why <file>`: every recorded change of the file, newest first. */
export function historyText(entries: readonly WhyEntry[], file: string): string {
  const history = entries.filter(entry => entry.file === file).reverse()
  const lines = history.slice(0, SHOWN).flatMap(entry => [`- ${stamp(entry.at)}: ${reasonOf(entry)}${edits(entry)}`, `    asked: "${entry.prompt}"`])
  const older = history.length > SHOWN ? [`… and ${history.length - SHOWN} older`] : []
  return [`${file} · ${history.length} recorded change${history.length === 1 ? '' : 's'}`, ...lines, ...older].join('\n')
}
