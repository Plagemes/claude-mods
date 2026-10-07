// A small line diff: unified hunks between two texts, for the turn's before and after. No `$` here.

const CONTEXT = 3
/** The middle part of two texts is matched line by line up to this many cells; past it, it is shown replaced whole. */
const MAX_CELLS = 2_000_000

type Op = { kind: ' ' | '-' | '+'; line: string }

const linesOf = (text: string): string[] => {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** The shortest edit between `a` and `b` by longest common subsequence. */
function lcsOps(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length
  const m = b.length
  if (n === 0) return b.map(line => ({ kind: '+', line }))
  if (m === 0) return a.map(line => ({ kind: '-', line }))
  if ((n + 1) * (m + 1) > MAX_CELLS) return [...a.map((line): Op => ({ kind: '-', line })), ...b.map((line): Op => ({ kind: '+', line }))]
  const width = m + 1
  const table = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j] ? (table[(i + 1) * width + j + 1] ?? 0) + 1 : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0)
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i] ?? '' })
      i += 1
      j += 1
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      ops.push({ kind: '-', line: a[i] ?? '' })
      i += 1
    } else {
      ops.push({ kind: '+', line: b[j] ?? '' })
      j += 1
    }
  }
  while (i < n) ops.push({ kind: '-', line: a[i++] ?? '' })
  while (j < m) ops.push({ kind: '+', line: b[j++] ?? '' })
  return ops
}

export type Diff = { text: string; added: number; removed: number }

/** Unified hunks (`@@ -a,b +c,d @@`) turning `before` into `after`, three lines of context around each change. */
export function unifiedDiff(before: string, after: string): Diff {
  const a = linesOf(before)
  const b = linesOf(after)
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  let suffix = 0
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1

  const ops: Op[] = [
    ...a.slice(0, prefix).map((line): Op => ({ kind: ' ', line })),
    ...lcsOps(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix)),
    ...a.slice(a.length - suffix).map((line): Op => ({ kind: ' ', line })),
  ]
  const added = ops.filter(op => op.kind === '+').length
  const removed = ops.filter(op => op.kind === '-').length
  if (added + removed === 0) return { text: '', added, removed }

  const changed = ops.map((op, index) => (op.kind === ' ' ? -1 : index)).filter(index => index >= 0)
  const hunks: string[] = []
  let k = 0
  while (k < changed.length) {
    const first = changed[k] ?? 0
    let last = first
    while (k + 1 < changed.length && (changed[k + 1] ?? 0) - last <= CONTEXT * 2 + 1) last = changed[++k] ?? last
    k += 1
    const start = Math.max(0, first - CONTEXT)
    const end = Math.min(ops.length - 1, last + CONTEXT)
    let aLine = 1
    let bLine = 1
    for (const op of ops.slice(0, start)) {
      if (op.kind !== '+') aLine += 1
      if (op.kind !== '-') bLine += 1
    }
    const body = ops.slice(start, end + 1)
    const aCount = body.filter(op => op.kind !== '+').length
    const bCount = body.filter(op => op.kind !== '-').length
    hunks.push(`@@ -${aCount === 0 ? aLine - 1 : aLine},${aCount} +${bCount === 0 ? bLine - 1 : bLine},${bCount} @@`, ...body.map(op => `${op.kind}${op.line}`))
  }
  return { text: hunks.join('\n'), added, removed }
}

/**
 * A diff cut to about `maxLines` lines: whole hunks while they fit, and a first hunk longer than that cut with its
 * header recounted, so what is left still parses as a unified diff.
 */
export function cutDiff(text: string, maxLines: number): { text: string; isCut: boolean } {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return { text, isCut: false }
  const hunks: string[][] = []
  for (const line of lines) {
    if (line.startsWith('@@') || hunks.length === 0) hunks.push([line])
    else hunks.at(-1)?.push(line)
  }
  const kept: string[] = []
  for (const hunk of hunks) {
    if (kept.length + hunk.length > maxLines) break
    kept.push(...hunk)
  }
  if (kept.length > 0) return { text: kept.join('\n'), isCut: true }

  const [header = '', ...body] = hunks[0] ?? []
  const part = body.slice(0, Math.max(1, maxLines - 1))
  const found = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(header)
  if (found === null) return { text: lines.slice(0, maxLines).join('\n'), isCut: true }
  const aCount = part.filter(line => !line.startsWith('+')).length
  const bCount = part.filter(line => !line.startsWith('-')).length
  return { text: [`@@ -${found[1]},${aCount} +${found[2]},${bCount} @@${found[3] ?? ''}`, ...part].join('\n'), isCut: true }
}
