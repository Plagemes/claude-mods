export type Finding = {
  /** Line, counting from 1; 0 when the problem is about the whole file. */
  line: number
  severity: 'error' | 'warn'
  message: string
}

const MOVING_REFS = new Set(['main', 'master', 'head', 'latest', 'develop', 'dev', 'trunk'])
const FULL_SHA = /^[0-9a-f]{40}$/i
const USES = /^\s*(?:-\s+)?uses:\s*(['"]?)([^\s'"#]+)\1/
const UNTRUSTED_REF = /github\.event\.pull_request\.head|github\.head_ref|pull_request\.head\.(?:sha|ref|repo)/
const PRINTS = /\b(?:echo|printf|cat|Write-Host|Write-Output)\b/

const indentOf = (line: string): number => line.length - line.trimStart().length
const isBlankOrComment = (line: string): boolean => line.trim() === '' || line.trim().startsWith('#')
/** A line without its trailing ` # comment`. */
const code = (line: string): string => line.replace(/\s+#.*$/, '')

type Job = { name: string; line: number; hasPermissions: boolean }

/** The jobs of the workflow, and whether each one has its own `permissions:`. */
function jobsOf(lines: readonly string[]): Job[] {
  const start = lines.findIndex(line => /^jobs\s*:/.test(line))
  if (start < 0) return []
  const first = lines.slice(start + 1).find(line => !isBlankOrComment(line))
  if (first === undefined) return []
  const level = indentOf(first)
  const jobs: Job[] = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] as string
    if (isBlankOrComment(line)) continue
    const indent = indentOf(line)
    if (indent < level) break
    const name = indent === level ? /^\s*([\w.-]+)\s*:/.exec(line)?.[1] : undefined
    if (name !== undefined) jobs.push({ name, line: index + 1, hasPermissions: false })
    else if (indent === level + 2 && /^\s*permissions\s*:/.test(line)) {
      const job = jobs.at(-1)
      if (job !== undefined) job.hasPermissions = true
    }
  }
  return jobs
}

/** The lines of the step (list item) that holds line `index`, or just that line when it is not in one. */
function stepAround(lines: readonly string[], index: number): string[] {
  const indent = indentOf(lines[index] as string)
  let start = index
  while (start > 0 && !(/^\s*-\s/.test(lines[start] as string) && indentOf(lines[start] as string) <= indent)) start -= 1
  if (!/^\s*-\s/.test(lines[start] as string)) return [lines[index] as string]
  const dash = indentOf(lines[start] as string)
  let end = start + 1
  while (end < lines.length && (isBlankOrComment(lines[end] as string) || indentOf(lines[end] as string) > dash)) end += 1
  return lines.slice(start, end)
}

/** Policy and syntax checks of a GitHub Actions workflow, by reading its text. */
export function checkWorkflow(text: string, options: { requireSha: boolean }): Finding[] {
  const lines = text.split(/\r?\n/)
  const findings: Finding[] = []
  const add = (line: number, severity: Finding['severity'], message: string) => findings.push({ line, severity, message })

  for (const [index, line] of lines.entries()) {
    if (/^ *\t/.test(line)) add(index + 1, 'error', 'a tab in the indentation; YAML only allows spaces, and the workflow will not parse')
  }

  for (const [index, line] of lines.entries()) {
    if (isBlankOrComment(line)) continue
    const spec = USES.exec(line)?.[2]
    if (spec === undefined || spec.startsWith('./') || spec.startsWith('docker://') || spec.includes('${{')) continue
    const at = spec.lastIndexOf('@')
    const name = at < 0 ? spec : spec.slice(0, at)
    const ref = at < 0 ? '' : spec.slice(at + 1)
    if (ref === '') add(index + 1, 'warn', `${name} has no version; pin a release tag or, better, a full commit SHA`)
    else if (MOVING_REFS.has(ref.toLowerCase())) add(index + 1, 'warn', `${name}@${ref} follows a moving branch, so a change upstream changes your CI; pin a tag or a full commit SHA`)
    else if (options.requireSha && !FULL_SHA.test(ref)) add(index + 1, 'warn', `${name}@${ref} is a tag, and tags can be moved; pin the full commit SHA (keep the tag in a comment)`)
  }

  const hasTopLevelPermissions = lines.some(line => /^permissions\s*:/.test(line))
  if (!hasTopLevelPermissions) {
    const jobs = jobsOf(lines)
    const lacking = jobs.filter(job => !job.hasPermissions)
    if (jobs.length === 0 || lacking.length === jobs.length) {
      add(0, 'warn', 'no permissions: block, so the GITHUB_TOKEN gets the repository default (often read and write); add permissions: contents: read at the top and widen per job')
    } else {
      for (const job of lacking) add(job.line, 'warn', `job ${job.name} has no permissions: block while other jobs do; it gets the wide default token`)
    }
  }

  const jobsAt = lines.findIndex(line => /^jobs\s*:/.test(line))
  const header = jobsAt < 0 ? lines : lines.slice(0, jobsAt)
  const isPullRequestTarget = header.some(line => !isBlankOrComment(line) && /\bpull_request_target\b/.test(line))
  if (isPullRequestTarget) {
    for (const [index, line] of lines.entries()) {
      if (!/uses:\s*['"]?actions\/checkout\b/.test(line)) continue
      const step = stepAround(lines, index)
      if (step.some(stepLine => /^\s*(?:ref|repository)\s*:/.test(stepLine) && UNTRUSTED_REF.test(stepLine))) {
        add(index + 1, 'error', "pull_request_target checks out the pull request's code; it then runs with a write token and secrets. Use pull_request, or check out the base branch and never run the PR's code")
      }
    }
  }

  for (const [index, line] of lines.entries()) {
    if (isBlankOrComment(line)) continue
    if (/\$\{\{\s*toJSON\(\s*secrets\s*\)/i.test(line)) add(index + 1, 'error', 'toJSON(secrets) puts every secret in one place; pass only the ones a step needs')
    else if (PRINTS.test(code(line)) && /\$\{\{\s*secrets\./.test(code(line))) add(index + 1, 'error', 'a secret is printed by this command; masking is not guaranteed, so do not echo secrets')
  }
  return findings.sort((a, b) => a.line - b.line)
}

export type ActionlintFinding = { line: number; message: string }

/** `-oneline` output: `path:line:col: message [rule]`, one problem per line. */
export function parseActionlint(stdout: string): ActionlintFinding[] {
  const found: ActionlintFinding[] = []
  for (const row of stdout.split('\n')) {
    const match = /^.*?:(\d+):\d+:\s*(.+)$/.exec(row.trim())
    if (match !== null) found.push({ line: Number(match[1]), message: match[2] as string })
  }
  return found
}
