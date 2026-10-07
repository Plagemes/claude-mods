import type { EngineInterface, Register } from 'claude-code'

/** `isOutput`: the language's way to print, which is a program's real output in a command-line entry point. */
type Rule = { label: string; pattern: RegExp; isOutput?: boolean }

const JAVASCRIPT: Rule[] = [
  { label: 'console.log', pattern: /\bconsole\.(log|debug|trace|dir|table)\s*\(/, isOutput: true },
  { label: 'debugger', pattern: /^\s*debugger\s*;?\s*(\/\/.*)?$/ },
]

const RULES_BY_EXTENSION: Record<string, Rule[]> = {
  js: JAVASCRIPT,
  jsx: JAVASCRIPT,
  mjs: JAVASCRIPT,
  cjs: JAVASCRIPT,
  ts: JAVASCRIPT,
  tsx: JAVASCRIPT,
  mts: JAVASCRIPT,
  cts: JAVASCRIPT,
  vue: JAVASCRIPT,
  svelte: JAVASCRIPT,
  py: [
    { label: 'print()', pattern: /^\s*print\s*\(/, isOutput: true },
    { label: 'breakpoint', pattern: /\b(breakpoint\(\)|i?pdb\.set_trace\(\))/ },
  ],
  rb: [
    { label: 'pp', pattern: /^\s*pp[\s(]/ },
    { label: 'debugger', pattern: /\b(binding\.(pry|irb)|byebug)\b/ },
  ],
  php: [{ label: 'var_dump', pattern: /(^|[^\w>:$.])(var_dump|print_r|dd|dump)\s*\(/ }],
  rs: [{ label: 'dbg!', pattern: /\bdbg!\s*[([{]/ }],
  go: [{ label: 'fmt.Println', pattern: /\bfmt\.Println\s*\(/, isOutput: true }],
  java: [
    { label: 'System.out', pattern: /\bSystem\.(out|err)\.print(ln)?\s*\(/, isOutput: true },
    { label: 'printStackTrace', pattern: /\.printStackTrace\s*\(/ },
  ],
}

/** A command-line program, whose printing is its output: a shebang, Python's __main__ guard, Go's package main, Java's main(). */
const PROGRAM = /^#!|\bif\s+__name__\s*==\s*['"]__main__['"]|^package\s+main\b|\bstatic\s+void\s+main\s*\(/m
const PROGRAM_FILE = /(^|[\\/])(__main__|manage)\.py$/

const NOT_SOURCE =
  /(^|\/)(tests?|__tests__|specs?|scripts?|fixtures?|examples?|e2e|bin)\/|\.(test|spec|stories)\.[^/]+$|(^|\/)(conftest|test_[^/]*)\.py$|_test\.(go|py)$|\.config\.[^/]+$/

const COMMENT = /^\s*(\/\/|#|\*|\/\*)/
const IGNORE_MARKER = 'debug-catcher: ignore'
const MAX_SAMPLES = 3
const MAX_SAMPLE_LENGTH = 60

const rulesFor = (path: string): Rule[] => {
  if (NOT_SOURCE.test(path)) return []
  return RULES_BY_EXTENSION[path.split('.').pop()?.toLowerCase() ?? ''] ?? []
}

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

const debugLines = (lines: string[], rules: Rule[]): string[] =>
  lines.filter(
    line =>
      !COMMENT.test(line) &&
      !line.includes(IGNORE_MARKER) &&
      rules.some(rule => rule.pattern.test(line)),
  )

const sample = (line: string): string => {
  const text = line.trim()
  return `\`${text.length > MAX_SAMPLE_LENGTH ? `${text.slice(0, MAX_SAMPLE_LENGTH)}...` : text}\``
}

const readLocal = async ($: EngineInterface, path: string): Promise<string> => {
  try {
    return await $.fs.read(path)
  } catch {
    return ''
  }
}

const plural = (n: number): string => `${n} debug statement${n === 1 ? '' : 's'}`

export const register: Register = on => {
  const pending = new Map<string, number>()

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const rules = rulesFor(e.file_path)
    if (rules.length === 0) return next(e)

    let before = ''
    let after = ''
    if (e.tool === 'Edit') {
      before = e.old_string
      after = e.new_string
    } else {
      after = e.content
      before = e._host === undefined ? await readLocal($, e.file_path) : ''
    }

    // In a program's entry point print() and console.log are the output: only debugger-style rules apply there.
    const usesOutput = rules.some(rule => rule.isOutput === true)
    const fileText = usesOutput ? (e.tool === 'Write' ? after : `${e._host === undefined ? await readLocal($, e.file_path) : ''}\n${after}`) : ''
    const isProgram = usesOutput && (PROGRAM_FILE.test(e.file_path) || PROGRAM.test(fileText))
    const checked = isProgram ? rules.filter(rule => rule.isOutput !== true) : rules
    const added = debugLines(newLines(before, after), checked)
    const removed = debugLines(newLines(after, before), checked)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran

    const net = Math.max(0, (pending.get(e.file_path) ?? 0) + added.length - removed.length)
    if (net > 0) pending.set(e.file_path, net)
    else pending.delete(e.file_path)

    const total = [...pending.values()].reduce((sum, n) => sum + n, 0)
    $.ui.status(total > 0 ? `⚠ ${plural(total)} to remove` : undefined)

    if (added.length === 0) return ran

    const samples = added.slice(0, MAX_SAMPLES).map(sample).join(', ')
    const note =
      `debug-catcher: this edit added ${plural(added.length)} to ${e.file_path}: ${samples}. ` +
      `Remove them before you finish; to keep one on purpose, add "${IGNORE_MARKER}" to its line.`
    return { ...ran, context: [...(ran.context ?? []), note] }
  })
}
