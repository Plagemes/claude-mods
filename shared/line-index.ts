/**
 * shared/line-index.ts — offsets to line numbers, fast, for every scanner that reports `file:line`.
 *
 * Extracted from mods/contrast-checker/hooks/css.ts (`lineFinder`: one pass over the newlines, then a
 * binary search per lookup) and mods/react-doctor/hooks/scan.ts (`lineAt`: the index cached per source so
 * many findings in one file never recount). Six mods had their own copy, two of them linear per lookup.
 * Pure: no `$`, no I/O. Vendored into mods by scripts/sync-shared.mjs.
 */

/** The offsets of every `\n` in `text`, in order. */
export function newlineOffsets(text: string): number[] {
  const newlines: number[] = []
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) newlines.push(at)
  return newlines
}

const search = (newlines: readonly number[], offset: number): number => {
  let low = 0
  let high = newlines.length
  while (low < high) {
    const middle = (low + high) >> 1
    if ((newlines[middle] ?? Infinity) < offset) low = middle + 1
    else high = middle
  }
  return low + 1
}

/** A function from an offset in `text` to its 1-based line, built once per text. */
export function lineFinder(text: string): (offset: number) => number {
  const newlines = newlineOffsets(text)
  return offset => search(newlines, offset)
}

/** The last text indexed by `lineAt`, so many lookups in one file share one index. */
let indexed: { text: string; newlines: number[] } = { text: '', newlines: [] }

/** The 1-based line of `offset` in `text` (the index is cached for the last text asked about). */
export function lineAt(text: string, offset: number): number {
  if (indexed.text !== text) indexed = { text, newlines: newlineOffsets(text) }
  return search(indexed.newlines, offset)
}

/** The 1-based column of `offset` in `text`. */
export function columnAt(text: string, offset: number): number {
  return offset - (text.lastIndexOf('\n', offset - 1) + 1) + 1
}

/** The text of 1-based line `line` (without its newline); '' past the end. */
export function lineText(text: string, line: number): string {
  if (line < 1) return ''
  let start = 0
  for (let current = 1; current < line; current += 1) {
    const next = text.indexOf('\n', start)
    if (next === -1) return ''
    start = next + 1
  }
  const end = text.indexOf('\n', start)
  return text.slice(start, end === -1 ? text.length : end)
}
