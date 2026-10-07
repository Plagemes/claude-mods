import type { ProcessRunResult } from 'claude-code'

import { dirname, extension, hasPackage, isAbsolute, join, parseJson } from './project'
import type { Project } from './project'

type Severity = 'error' | 'warning'

export type Problem = { line: number; column: number; severity: Severity; message: string; rule?: string }

/** What one run came to: the problems in the file, or why the linter itself failed. */
type Verdict = { problems: Problem[] } | { failure: string }

export type Linter = {
  /** The name shown to people and matched by the `disabled` option. */
  name: string
  extensions: ReadonlySet<string>
  /** Whether the project asks for this linter. */
  isWanted: (project: Project) => Promise<boolean>
  /** The executable, looked up under `localFolders` before PATH. */
  bin: string
  localFolders: readonly string[]
  /** The directory the linter runs in, where it finds its config. */
  cwd: (project: Project, file: string) => string
  args: (file: string, cwd: string) => string[]
  /** Reads a finished run into the problems it reports for `file`. */
  parse: (run: ProcessRunResult, file: string, cwd: string) => Verdict
}

const NODE_BIN = ['node_modules/.bin']
const PYTHON_BIN = ['.venv/bin', 'venv/bin']
const MAX_FAILURE_LENGTH = 160

const ESLINT_CONFIGS = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yaml',
  '.eslintrc.yml',
]
const GOLANGCI_CONFIGS = ['.golangci.yml', '.golangci.yaml', '.golangci.toml', '.golangci.json']

/** `path:line:col: [severity: ]message` lines, as golangci-lint, clippy and shellcheck print them. */
const LOCATED_LINE = /^(.+?):(\d+):(\d+):\s+(?:(error|warning|note|style|info)(?:\[([\w:-]+)\])?:\s+)?(.+)$/

/** The first non-empty line a run printed, to say why a linter failed. */
const firstLine = (run: ProcessRunResult): string => {
  const line = `${run.stderr}\n${run.stdout}`.split('\n').find(text => text.trim() !== '')
  return line === undefined ? `exit code ${run.exitCode}` : line.trim().slice(0, MAX_FAILURE_LENGTH)
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const numberOr = (value: unknown, fallback: number): number => (typeof value === 'number' ? value : fallback)

/** Whether a path a linter printed (relative to its cwd, or absolute) is `file`. */
const isSameFile = (reported: string, file: string, cwd: string): boolean => {
  const clean = reported.replace(/^\.\//, '')
  return (isAbsolute(clean) ? clean : join(cwd, clean)) === file || file.endsWith(`/${clean}`)
}

/** Problems from `path:line:col:` lines that name `file`; `severityOf` maps the printed level. */
const parseLocatedLines = (
  text: string,
  file: string,
  cwd: string,
  severityOf: (level: string | undefined) => Severity,
): Problem[] =>
  text.split('\n').flatMap(line => {
    const match = LOCATED_LINE.exec(line.trim())
    if (match === null || !isSameFile(match[1] ?? '', file, cwd)) return []
    const message = (match[6] ?? '').trim()
    // shellcheck ends a message with `[SC2086]`, golangci-lint with `(linter)`.
    const tail = /\s(?:\[(SC\d+)\]|\(([\w-]+)\))$/.exec(message)
    return [
      {
        line: Number(match[2]),
        column: Number(match[3]),
        severity: severityOf(match[4]),
        message: tail === null ? message : message.slice(0, tail.index),
        rule: match[5] ?? tail?.[1] ?? tail?.[2],
      },
    ]
  })

/** Every linter, in the order they are tried for a file. */
const LINTERS: readonly Linter[] = [
  {
    name: 'eslint',
    extensions: new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts']),
    isWanted: async project =>
      project.find(...ESLINT_CONFIGS) !== undefined ||
      (await hasPackage(project, 'eslint')) ||
      (await hasPackage(project, 'eslintConfig')),
    bin: 'eslint',
    localFolders: NODE_BIN,
    cwd: (project, file) => project.find(...ESLINT_CONFIGS) ?? project.find('package.json') ?? dirname(file),
    args: file => ['--format', 'json', file],
    parse: run => {
      const reports = parseJson(run.stdout)
      if (!Array.isArray(reports) || run.exitCode > 1) return { failure: firstLine(run) }
      const messages = reports.flatMap(report => (isRecord(report) && Array.isArray(report.messages) ? report.messages : []))
      return {
        problems: messages.flatMap(message => {
          if (!isRecord(message) || typeof message.message !== 'string') return []
          if (message.ruleId == null && /^File ignored/.test(message.message)) return []
          const isError = message.severity === 2 || message.fatal === true
          return [
            {
              line: numberOr(message.line, 1),
              column: numberOr(message.column, 1),
              severity: isError ? 'error' : 'warning',
              message: message.message,
              rule: typeof message.ruleId === 'string' ? message.ruleId : undefined,
            },
          ]
        }),
      }
    },
  },
  {
    name: 'ruff',
    extensions: new Set(['py', 'pyi']),
    isWanted: async () => true,
    bin: 'ruff',
    localFolders: PYTHON_BIN,
    cwd: (project, file) => project.find('ruff.toml', '.ruff.toml', 'pyproject.toml') ?? dirname(file),
    args: file => ['check', '--output-format=json', '--no-fix', file],
    parse: run => {
      const findings = parseJson(run.stdout)
      if (!Array.isArray(findings) || run.exitCode > 1) return { failure: firstLine(run) }
      return {
        problems: findings.flatMap(finding => {
          if (!isRecord(finding) || typeof finding.message !== 'string') return []
          const location = isRecord(finding.location) ? finding.location : {}
          return [
            {
              line: numberOr(location.row, 1),
              column: numberOr(location.column, 1),
              severity: 'error' as const,
              message: finding.message,
              rule: typeof finding.code === 'string' ? finding.code : 'syntax-error',
            },
          ]
        }),
      }
    },
  },
  {
    name: 'golangci-lint',
    extensions: new Set(['go']),
    isWanted: async project => project.find(...GOLANGCI_CONFIGS) !== undefined,
    bin: 'golangci-lint',
    localFolders: [],
    cwd: (project, file) => project.find('go.mod') ?? dirname(file),
    args: (file, cwd) => {
      const dir = dirname(file)
      return ['run', dir === cwd ? '.' : `./${dir.slice(join(cwd, '').length)}`]
    },
    parse: (run, file, cwd) => {
      const problems = parseLocatedLines(run.stdout, file, cwd, () => 'error')
      return run.exitCode > 1 && problems.length === 0 ? { failure: firstLine(run) } : { problems }
    },
  },
  {
    name: 'clippy',
    extensions: new Set(['rs']),
    isWanted: async project => project.find('Cargo.toml') !== undefined,
    bin: 'cargo',
    localFolders: [],
    cwd: (project, file) => project.find('Cargo.toml') ?? dirname(file),
    args: () => ['clippy', '--quiet', '--message-format=short'],
    parse: (run, file, cwd) => {
      // Clippy's lints are warnings by design: they are what the linter is for.
      const problems = parseLocatedLines(run.stderr, file, cwd, () => 'error')
      const reportedAny = run.stderr.split('\n').some(line => LOCATED_LINE.test(line.trim()))
      return run.exitCode !== 0 && !reportedAny ? { failure: firstLine(run) } : { problems }
    },
  },
  {
    name: 'shellcheck',
    extensions: new Set(['sh', 'bash']),
    isWanted: async () => true,
    bin: 'shellcheck',
    localFolders: [],
    cwd: (_project, file) => dirname(file),
    args: file => ['--format=gcc', file],
    parse: (run, file, cwd) => {
      const problems = parseLocatedLines(run.stdout, file, cwd, level =>
        level === 'error' || level === 'warning' ? 'error' : 'warning',
      )
      return run.exitCode > 1 && problems.length === 0 ? { failure: firstLine(run) } : { problems }
    },
  },
]

/** The first linter for this file's extension that the project asks for, skipping disabled ones. */
export const pickLinter = async (
  file: string,
  project: Project,
  disabled: ReadonlySet<string>,
): Promise<Linter | undefined> => {
  const ext = extension(file)
  for (const linter of LINTERS) {
    if (!linter.extensions.has(ext) || disabled.has(linter.name)) continue
    if (await linter.isWanted(project)) return linter
  }
  return undefined
}
