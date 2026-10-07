import type { EngineInterface, Register } from 'claude-code'

type Rule = { label: string; pattern: RegExp; isDirective?: true }

const RULES: Rule[] = [
  { label: ': any', pattern: /:\s*any\b/ },
  { label: 'as any', pattern: /\bas\s+any\b/ },
  { label: '<any>', pattern: /[<,]\s*any\s*[>,]/ },
  { label: '@ts-ignore', pattern: /@ts-ignore\b/, isDirective: true },
  { label: '@ts-nocheck', pattern: /@ts-nocheck\b/, isDirective: true },
  { label: 'eslint-disable', pattern: /\beslint-disable/, isDirective: true },
]

const TYPESCRIPT_FILE = /\.(ts|tsx|mts|cts)$/
const STRING_LITERAL = /(['"`])(?:\\.|(?!\1).)*\1/g
const TRAILING_COMMENT = /(^|\s)\/\/.*$/
const BLOCK_COMMENT_LINE = /^\s*(\/\*|\*)/
const ALLOW_MARKER = 'no-any: allow'
const BLOCK = 'block'

/** What the `any` rules should read: the line without string contents or comments. */
const codeOf = (line: string): string =>
  BLOCK_COMMENT_LINE.test(line) ? '' : line.replace(STRING_LITERAL, '""').replace(TRAILING_COMMENT, '')

const countLines = (text: string): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const line of text.split('\n')) {
    const key = line.trim()
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/** Lines of `after` that `before` does not have, compared as a multiset of trimmed lines. */
const newLines = (before: string, after: string): string[] => {
  const available = countLines(before)
  return after.split('\n').filter(line => {
    const key = line.trim()
    const left = available.get(key) ?? 0
    available.set(key, left - 1)
    return left <= 0
  })
}

/** One label per escape hatch found, so two `as any` on a line count twice. */
const escapeHatches = (lines: string[]): string[] =>
  lines
    .filter(line => !line.includes(ALLOW_MARKER))
    .flatMap(line => {
      const code = codeOf(line)
      return RULES.filter(rule => rule.pattern.test(rule.isDirective ? line : code)).map(rule => rule.label)
    })

const summarize = (labels: string[]): string => {
  const counts = new Map<string, number>()
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1)
  return [...counts].map(([label, n]) => (n === 1 ? label : `${label} x${n}`)).join(', ')
}

const readLocal = async ($: EngineInterface, path: string): Promise<string> => {
  try {
    return await $.fs.read(path)
  } catch {
    return ''
  }
}

export const register: Register = (on, options) => {
  const isBlocking = options.mode === BLOCK

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    if (!TYPESCRIPT_FILE.test(e.file_path)) return next(e)

    const before =
      e.tool === 'Edit' ? e.old_string : e._host === undefined ? await readLocal($, e.file_path) : ''
    const after = e.tool === 'Edit' ? e.new_string : e.content

    const found = escapeHatches(newLines(before, after))
    if (found.length === 0) return next(e)

    const summary = summarize(found)
    if (isBlocking) {
      return {
        deny:
          `no-any: blocked, this change adds ${summary} to ${e.file_path}. ` +
          `Use a precise type or unknown and fix the underlying error instead. ` +
          `If it is truly unavoidable, put "${ALLOW_MARKER}" and the reason on that line.`,
      }
    }

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran

    $.ui.toast(`no-any: ${summary} added to ${e.file_path.split('/').pop()}`)
    const note =
      `no-any: this edit added ${summary} to ${e.file_path}. Replace it with a precise type, ` +
      `unknown plus a narrowing check, or fix the underlying type error. ` +
      `If it is truly unavoidable, put "${ALLOW_MARKER}" and the reason on that line.`
    return { ...ran, context: [...(ran.context ?? []), note] }
  })
}
