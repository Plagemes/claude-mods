import type { PromptHistoryEntry } from '../types'

/** Prompts kept, newest first. */
export const MAX_ENTRIES = 1_000
/** A longer prompt is kept up to this many characters. */
export const MAX_TEXT_CHARS = 4_000
/** Characters kept in all, well inside the store's 4 MiB. */
const MAX_TOTAL_CHARS = 2_500_000

const isEntry = (value: unknown): value is PromptHistoryEntry =>
  typeof value === 'object' &&
  value !== null &&
  'text' in value &&
  typeof value.text === 'string' &&
  'at' in value &&
  typeof value.at === 'number' &&
  'project' in value &&
  typeof value.project === 'string'

export const asEntries = (value: unknown): PromptHistoryEntry[] => (Array.isArray(value) ? value.filter(isEntry) : [])

/** Puts `entry` first, drops an older copy of the same text, and keeps the list within its caps. */
export const withEntry = (entries: readonly PromptHistoryEntry[], entry: PromptHistoryEntry): PromptHistoryEntry[] => {
  const kept: PromptHistoryEntry[] = []
  let chars = 0

  for (const one of [entry, ...entries.filter(old => old.text !== entry.text)]) {
    chars += one.text.length + one.project.length
    if (kept.length >= MAX_ENTRIES || chars > MAX_TOTAL_CHARS) break
    kept.push(one)
  }

  return kept
}

/** The entries holding every word of `query` (any case), newest first, within the scope. */
export const search = (
  entries: readonly PromptHistoryEntry[],
  query: string,
  project: string | undefined,
): PromptHistoryEntry[] => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)

  return entries.filter(
    entry =>
      (project === undefined || entry.project === project) &&
      words.every(word => entry.text.toLowerCase().includes(word)),
  )
}
