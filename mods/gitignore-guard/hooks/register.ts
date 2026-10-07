import type { EngineInterface, Register } from 'claude-code'

import { parseShell, withNestedScripts } from './shell'
import { junkFor, matchesGlob, megabytes, parseGitAdd, parseStatus, type GitAdd, type StatusEntry } from './staging'

const STATUS_TIMEOUT_MS = 15000
const MAX_STATS = 300
const MAX_LISTED = 6
const MB = 1024 * 1024

type Finding = { label: string; ignoreLine: string }
type Candidate = { shown: string; actual: string }

/** What a broad `git add` would pick up: the repository root and the changed paths under it. */
async function pendingEntries($: EngineInterface, add: GitAdd): Promise<{ root: string; entries: StatusEntry[] } | undefined> {
  try {
    const repo = await $.session.repo()
    if (repo === null) return undefined
    const { exitCode, stdout, isStdoutTruncated } = await $.process.run(
      ['git', '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { timeoutMs: STATUS_TIMEOUT_MS },
    )
    if (exitCode !== 0) return undefined
    const cwd = await $.session.cwd()
    const folder = add.isCurrentDirectoryOnly && cwd.startsWith(`${repo.root}/`) ? `${cwd.slice(repo.root.length + 1)}/` : ''
    return { root: repo.root, entries: parseStatus(stdout, isStdoutTruncated).filter(entry => entry.path.startsWith(folder)) }
  } catch {
    return undefined
  }
}

async function sizeOf($: EngineInterface, path: string): Promise<number | undefined> {
  try {
    const stat = await $.fs.stat(path)
    return stat.kind === 'file' ? stat.size : undefined
  } catch {
    return undefined
  }
}

async function bigFiles($: EngineInterface, candidates: readonly Candidate[], maxBytes: number): Promise<Finding[]> {
  const found: Finding[] = []
  for (const { shown, actual } of candidates.slice(0, MAX_STATS)) {
    const size = await sizeOf($, actual)
    if (size !== undefined && size > maxBytes) found.push({ label: `${shown} (${megabytes(size)})`, ignoreLine: shown })
  }
  return found
}

/** One finding per kind of junk, with a count, so node_modules is a single line and not 40,000. */
function collapseByIgnoreLine(findings: readonly Finding[]): Finding[] {
  const groups = new Map<string, { first: Finding; count: number }>()
  for (const finding of findings) {
    const group = groups.get(finding.ignoreLine)
    if (group) group.count += 1
    else groups.set(finding.ignoreLine, { first: finding, count: 1 })
  }
  return [...groups.values()].map(({ first, count }) => ({
    ignoreLine: first.ignoreLine,
    label: count > 1 ? `${first.ignoreLine} (${count} files)` : first.label,
  }))
}

function report(findings: readonly Finding[]): string {
  const listed = findings.slice(0, MAX_LISTED).map(finding => `  ${finding.label}`)
  const more = findings.length > MAX_LISTED ? [`  (+${findings.length - MAX_LISTED} more)`] : []
  const ignoreLines = [...new Set(findings.map(finding => finding.ignoreLine))].slice(0, MAX_LISTED).map(line => `  ${line}`)
  return [
    'gitignore-guard: this git add would stage files that normally stay out of git:',
    ...listed,
    ...more,
    'Add to .gitignore:',
    ...ignoreLines,
    'Then stage again, or name the files you want instead of using -A / .',
  ].join('\n')
}

export const register: Register = (on, options) => {
  const maxBytes = Math.max(0, Number(options.maxFileMb ?? 5)) * MB
  const extraGlobs = String(options.extraPatterns ?? '')
    .split(',')
    .map(glob => glob.trim())
    .filter(glob => glob !== '')

  /** Unambiguous junk and the extra patterns always; build output only when asked to add everything. */
  const classify = (path: string, includeBuildOutput: boolean): Finding | undefined => {
    const junk = junkFor(path, includeBuildOutput)
    if (junk) return { label: `${path} (${junk.reason})`, ignoreLine: junk.ignoreLine }
    const glob = extraGlobs.find(candidate => matchesGlob(path, candidate))
    return glob === undefined ? undefined : { label: `${path} (matches ${glob})`, ignoreLine: glob }
  }

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!/\badd\b/.test(e.command)) return next(e)
    const add = parseGitAdd(withNestedScripts(parseShell(e.command)))
    if (add === undefined) return next(e)

    const findings = add.paths.flatMap(path => classify(path, false) ?? [])

    if (add.isBroad) {
      const pending = await pendingEntries($, add)
      if (pending) {
        const junk = pending.entries.filter(entry => entry.status === '??').flatMap(entry => classify(entry.path, true) ?? [])
        findings.push(...collapseByIgnoreLine(junk))
        if (maxBytes > 0 && junk.length === 0) {
          const files = pending.entries.filter(entry => !entry.status.includes('D') && !entry.path.endsWith('/'))
          findings.push(...(await bigFiles($, files.map(entry => ({ shown: entry.path, actual: `${pending.root}/${entry.path}` })), maxBytes)))
        }
      }
    }

    const named = add.paths.filter(path => !/[*?[]/.test(path)).map(path => ({ shown: path, actual: path }))
    if (maxBytes > 0 && findings.length === 0 && named.length > 0) findings.push(...(await bigFiles($, named, maxBytes)))

    return findings.length === 0 ? next(e) : { deny: report(findings) }
  })
}
