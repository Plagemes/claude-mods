import type { DiffPaneFile } from '../types'

/** The tree git compares an unborn branch against. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
export const DIFF_LIMIT = 60_000

const STATUSES = new Set(['M', 'A', 'D', 'T'])

/** Joins `git diff --numstat -z` and `--name-status -z` output into one entry per file, sorted by path. */
export const parseTracked = (numstat: string, nameStatus: string): DiffPaneFile[] => {
  const statusOf = new Map<string, DiffPaneFile['status']>()
  const fields = nameStatus.split('\0')
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const code = (fields[i] as string).trim().charAt(0)
    statusOf.set(fields[i + 1] as string, (STATUSES.has(code) ? code : 'M') as DiffPaneFile['status'])
  }
  const files: DiffPaneFile[] = []
  for (const record of numstat.split('\0')) {
    const match = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(record)
    if (match === null) continue
    const [, adds = '0', dels = '0', path = ''] = match
    const isBinary = adds === '-'
    files.push({ path, status: statusOf.get(path) ?? 'M', adds: isBinary ? 0 : Number(adds), dels: isBinary ? 0 : Number(dels), isBinary })
  }
  return files
}

export const parseUntracked = (lsFiles: string): string[] => lsFiles.split('\0').filter(path => path !== '')

/** Counts the lines of an untracked file's text; a NUL byte marks it binary. */
export const untrackedEntry = (path: string, text: string | undefined): DiffPaneFile => {
  if (text === undefined || text.includes('\0')) return { path, status: '?', adds: 0, dels: 0, isBinary: text !== undefined }
  const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  return { path, status: '?', adds: lines, dels: 0, isBinary: false }
}

/** Cuts a unified diff at the last whole hunk before `limit`, so it still parses as hunks. */
export const cutDiff = (diff: string, limit = DIFF_LIMIT): { text: string; isCut: boolean } => {
  if (diff.length <= limit) return { text: diff, isCut: false }
  const lastHunk = diff.lastIndexOf('\n@@', limit)
  // One hunk longer than the limit: cut at a line (the surface then draws it as plain code).
  const end = lastHunk > 0 ? lastHunk : diff.lastIndexOf('\n', limit)
  return { text: diff.slice(0, end > 0 ? end + 1 : limit), isCut: true }
}

/** Splits `adds` and `dels` over `width` cells, in proportion to the largest change in the list. */
export const barCells = (adds: number, dels: number, largest: number, width: number): { plus: number; minus: number } => {
  const total = adds + dels
  if (total === 0 || largest === 0) return { plus: 0, minus: 0 }
  const cells = Math.max(1, Math.round((total / largest) * width))
  if (adds === 0 || dels === 0 || cells === 1) return adds >= dels ? { plus: cells, minus: 0 } : { plus: 0, minus: cells }
  const plus = Math.min(cells - 1, Math.max(1, Math.round((adds / total) * cells)))
  return { plus, minus: cells - plus }
}

/** `…/components/Button.tsx` for a path wider than `width`. */
export const shortPath = (path: string, width: number): string =>
  path.length <= width ? path : `…${path.slice(path.length - Math.max(1, width - 1))}`
