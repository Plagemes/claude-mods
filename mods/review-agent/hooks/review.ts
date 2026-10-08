// Pure parts of the review: the reviewer's brief, the read-only Bash rule, and reading its report. No `$` here.

export const SEVERITIES = ['critical', 'major', 'minor', 'nit'] as const
export type Severity = (typeof SEVERITIES)[number]
export type SeverityCounts = Record<Severity, number>

export const REVIEWER_PROMPT = `You are a meticulous senior code reviewer. You review a change set for the problems that matter and report them. You never modify anything: you read code with Read, Grep and Glob, and you may run read-only git commands through Bash (git diff, git log, git show, git blame, git status, git grep). Any other command is refused.

How to review:
1. Start from the diff in your task (run the git diff command it names when the diff is cut or missing). Read enough of the surrounding code to understand each change: its callers, the functions it calls, the types, and the tests.
2. Look for, in this order:
   - Correctness: logic errors, off-by-one, null/undefined handling, error paths, concurrency and ordering, resource leaks, broken invariants, contract changes that break callers.
   - Security: injection (SQL, shell, path traversal), missing authentication or authorization checks, secrets in code, unsafe deserialization, SSRF, XSS, unvalidated input.
   - Tests: is the changed behaviour covered? Which edge cases are missing? Do the tests assert anything meaningful?
   - Readability and maintainability: misleading names, dead code, duplication, needless complexity, but only where it genuinely hurts.
3. Verify every finding against the code before you report it. No speculation: when unsure, say exactly what to check. Skip what a linter or formatter would catch.

Report in Markdown, in exactly this shape and with nothing before it:

## Summary
One or two sentences: what the change does, and your verdict: Ship it, Ship with fixes, or Needs work.

## Findings
Most severe first. For each:
### [severity] Short title
\`path/to/file.ext:line\`: what is wrong and why it matters.
**Fix:** the concrete change.

Severity is one of [critical] (data loss, security hole, crash on a main path), [major] (wrong behaviour, missing error handling, risky untested logic), [minor] (edge cases, small bugs, unclear code) or [nit] (naming, style). When nothing is worth raising, write "No issues found." under Findings and say what you checked.

## Tests
Which tests cover the change, and which to add (one line each).`

export const REVIEWER_DESCRIPTION =
  'Independent, read-only review of a git diff for correctness, security, tests and readability; findings are labelled ' +
  '[critical], [major], [minor] or [nit]. Use it when the user asks for a review. Say which diff to review (e.g. "git diff main...HEAD").'

const READ_ONLY_GIT = /^\s*git\s+(?:--no-pager\s+)?(diff|log|show|status|blame|merge-base|rev-parse|ls-files|grep|shortlog|describe|cat-file)(\s|$)/
const SHELL_SYNTAX = /[;&|`$<>(){}\n\\]/
/**
 * Options that write files or run programs. `git grep -O<cmd>` / `--open-files-in-pager=<cmd>` (any `--op…` abbreviation,
 * or `-O` inside a cluster such as `-iO`) runs a command on every matching file.
 */
const WRITING_OPTION = /(^|\s)(--output(=|\s|$)|--ext-diff|--textconv|-o\s|-[a-zA-Z]*O|--op)/

/** Why a reviewer's Bash command is refused, or undefined when it is a plain read-only git command. */
export const whyNotReadOnly = (command: string): string | undefined => {
  if (SHELL_SYNTAX.test(command)) return 'no shell operators, redirections or substitutions'
  // The shell drops quotes, so `"--output=x"` and `-O'rm'` must be read as git sees them.
  const unquoted = command.replace(/["']/g, '')
  if (!READ_ONLY_GIT.test(unquoted)) return 'only git diff, log, show, status, blame and grep'
  if (WRITING_OPTION.test(unquoted)) return 'no output files or external programs'
  return undefined
}

/** A ref the person typed after /review, safe to hand to git as an argument. */
export const isSafeRef = (ref: string): boolean => /^[\w./@^~{}-]+$/.test(ref) && !ref.startsWith('-') && !ref.includes('..')

export const countSeverities = (report: string): SeverityCounts => {
  const counts: SeverityCounts = { critical: 0, major: 0, minor: 0, nit: 0 }
  for (const match of report.matchAll(/^#{2,4}\s*\[(critical|major|minor|nit)\]/gim)) {
    const severity = match[1]?.toLowerCase() as Severity | undefined
    if (severity !== undefined) counts[severity] += 1
  }
  return counts
}

/** "1 critical, 2 major" (only the severities found), or "no issues". */
export const describeCounts = (counts: SeverityCounts): string => {
  const parts = SEVERITIES.filter(s => counts[s] > 0).map(s => `${counts[s]} ${s}`)
  return parts.length === 0 ? 'no issues' : parts.join(', ')
}
