// Pure parts of the self-check: the question asked of the fork, reading its verdict, and the fix prompt. No `$` here.

const REQUEST_CHARS = 4_000
const ANSWER_CHARS = 3_000
const FILES_LISTED = 30
const GAP_CHARS = 240
export const MAX_GAPS = 5

export type Verdict = { isComplete: boolean; gaps: string[] }

const cut = (text: string, chars: number): string => (text.length > chars ? `${text.slice(0, chars)}\n[…cut]` : text)

/** The one question the fork answers over the conversation it already holds. */
export function checkPrompt(request: string, answer: string, files: readonly string[]): string {
  const listed = files.slice(0, FILES_LISTED).join(', ') + (files.length > FILES_LISTED ? `, and ${files.length - FILES_LISTED} more` : '')
  return [
    'Pause before the user reviews the turn that just ended, and double-check it honestly. Judge what was actually done',
    'in this conversation (the edits and the command results above), not what was claimed.',
    '',
    "The user's request for that turn:",
    '"""',
    cut(request.trim(), REQUEST_CHARS),
    '"""',
    '',
    'Your final message for that turn:',
    '"""',
    cut(answer.trim() || '(none)', ANSWER_CHARS),
    '"""',
    '',
    `Files edited in that turn: ${listed || 'none'}`,
    '',
    'Check:',
    '1. Each explicit requirement of the request: is it fully done?',
    '2. Unfinished work: TODOs, placeholders, stubs, half-done edits, code that was meant to be removed or replaced.',
    '3. Verification: when code changed, were the relevant tests, build or type check run, and did they pass? If the project has none, or they could not be run, that is not a gap unless the user asked for it.',
    '4. Claims in the final message that the edits do not support.',
    '',
    'Report only real, specific gaps you can point to; do not propose improvements beyond what was asked.',
    'Reply with JSON only, no prose and no code fence:',
    '{"complete": true or false, "gaps": ["one short, actionable sentence per gap"]}',
    `"complete" is true with an empty "gaps" list when everything asked for is done. At most ${MAX_GAPS} gaps.`,
  ].join('\n')
}

const clean = (gap: string): string => {
  const line = gap.replace(/\s+/g, ' ').replace(/^[-*•\d.)\s]+/, '').trim()
  return line.length > GAP_CHARS ? `${line.slice(0, GAP_CHARS - 1)}…` : line
}

/** The fork's reply as a verdict; undefined when it holds no readable JSON verdict. */
export function parseVerdict(reply: string): Verdict | undefined {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { complete, gaps } = parsed as { complete?: unknown; gaps?: unknown }
  if (typeof complete !== 'boolean') return undefined
  const listed = Array.isArray(gaps) ? gaps.filter((gap): gap is string => typeof gap === 'string').map(clean).filter(Boolean) : []
  // A verdict of "incomplete" that names nothing to fix gives the person nothing to act on: it counts as complete.
  return { isComplete: listed.length === 0, gaps: listed.slice(0, MAX_GAPS) }
}

/** The prompt that sends the gaps back to Claude, in the person's words. */
export function fixPrompt(gaps: readonly string[]): string {
  return [
    'A self-check of your last turn found these gaps against my request:',
    ...gaps.map((gap, index) => `${index + 1}. ${gap}`),
    '',
    'Please close them (skip any that turn out not to be real, and say why), then summarise what you changed.',
  ].join('\n')
}

/** A request as one short line. */
export function oneLine(text: string, width: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > width ? `${line.slice(0, Math.max(1, width - 1))}…` : line
}
