/** Lines worth keeping from the part of an output that is cut. */
const NOTEWORTHY = /error|fail|warn|exception|traceback|panic|fatal/i
/** Kept lines from the cut part, at most. */
const MAX_NOTEWORTHY = 60
/** A longer line is clipped, so a minified blob cannot flood the excerpt either. */
const MAX_LINE_CHARS = 400

export type TrimShape = { headLines: number; tailLines: number }

const count = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

const clip = (line: string): string =>
  line.length <= MAX_LINE_CHARS ? line : `${line.slice(0, MAX_LINE_CHARS)}… [+${count(line.length - MAX_LINE_CHARS)} chars]`

/**
 * Keeps the first and last lines of `text` and, from the middle, every distinct
 * line that mentions an error or a warning, numbered; says what was cut.
 */
export const trimOutput = (text: string, { headLines, tailLines }: TrimShape, fullOutputAt?: string): string => {
  const lines = text.split('\n')

  if (lines.length <= headLines + tailLines) return lines.map(clip).join('\n')

  const firstCut = headLines
  const lastCut = lines.length - tailLines
  const seen = new Set<string>()
  const noteworthy: string[] = []
  let mentions = 0

  for (let index = firstCut; index < lastCut; index += 1) {
    const line = (lines[index] ?? '').trim()
    if (!NOTEWORTHY.test(line)) continue
    mentions += 1
    if (seen.has(line) || noteworthy.length >= MAX_NOTEWORTHY) continue
    seen.add(line)
    noteworthy.push(`${index + 1}: ${clip(line)}`)
  }

  const cut = lastCut - firstCut
  const listed =
    mentions === 0
      ? 'None of them mention errors or warnings.'
      : noteworthy.length === mentions
        ? `The ${count(mentions)} that mention errors or warnings follow, numbered.`
        : `${count(noteworthy.length)} of the ${count(mentions)} that mention errors or warnings follow, numbered (repeats and the rest left out).`
  const whole = fullOutputAt === undefined ? 'Add "# no-trim" to the command for the whole output.' : `The whole output is saved at ${fullOutputAt}.`

  return [
    ...lines.slice(0, firstCut).map(clip),
    `[output-trimmer: ${count(cut)} lines cut (lines ${count(firstCut + 1)}-${count(lastCut)}). ${listed} ${whole}]`,
    ...noteworthy,
    ...(noteworthy.length > 0 ? [`[output-trimmer: the last ${count(tailLines)} lines follow]`] : []),
    ...lines.slice(lastCut).map(clip),
  ].join('\n')
}
