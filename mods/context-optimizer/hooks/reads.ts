/**
 * Repeated reads: the same unchanged file range read again before any compaction is already in the context.
 * Pure: no `$`, no I/O.
 */

export type ReadInput = { file_path: string; offset?: number; limit?: number; pages?: string }
export type ReadEntry = { turn: number; mtimeMs: number; size: number; epoch: number }
export type ReadVerdict = { isRepeat: true; turn: number } | { isRepeat: false }

/** Reads older than this many turns may have been cleared by the engine; they are read again. */
export const MAX_AGE_TURNS = 12
/** A copy shorter than this is not worth a note. */
export const MIN_DEDUPE_CHARS = 600

export const readKey = (input: ReadInput): string => `${input.file_path}|${input.offset ?? ''}|${input.limit ?? ''}|${input.pages ?? ''}`

/**
 * Whether a read repeats an earlier one: same key, same file (mtime and size), same compaction epoch, not too old,
 * and not a second ask right after a note (Claude reading again because it no longer has the content).
 */
export function checkRead(entry: ReadEntry | undefined, stat: { mtimeMs: number; size: number }, now: { turn: number; epoch: number }, wasNoted: boolean): ReadVerdict {
  if (entry === undefined || wasNoted) return { isRepeat: false }
  const isSame = entry.mtimeMs === stat.mtimeMs && entry.size === stat.size && entry.epoch === now.epoch
  return isSame && now.turn - entry.turn <= MAX_AGE_TURNS ? { isRepeat: true, turn: entry.turn } : { isRepeat: false }
}

/** The note that stands in for the repeated copy. */
export const dedupeNote = (path: string, turn: number, chars: number): string =>
  `[context-optimizer: already read ${path} at turn ${turn}; unchanged since, so this ${chars.toLocaleString('en-US')}-character copy was left out. The earlier result is current. If you no longer have it, read the file again and it will come through whole.]`
