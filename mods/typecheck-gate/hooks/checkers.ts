import { resolveFrom } from './project'

export type Checker = 'tsc' | 'pyright' | 'mypy'

/** One type error, its file absolute ('' for a project-wide error). */
export type Finding = { file: string; line: number; column: number; code: string; message: string }

/** What one checker run came to: its errors, or why it could not check. */
export type CheckResult = { checker: Checker; findings: Finding[] } | { checker: Checker; failure: string }

export const TS_EXTENSIONS = new Set(['ts', 'tsx', 'mts', 'cts'])
export const PY_EXTENSIONS = new Set(['py', 'pyi'])

const MAX_FAILURE_LENGTH = 160
const TSC_LOCATED = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/
const TSC_GLOBAL = /^error (TS\d+): (.*)$/
const MYPY_LINE = /^(.+?):(\d+):(?:(\d+):)? error: (.*?)(?:\s+\[([\w-]+)\])?$/

const firstLine = (text: string, fallback: string): string =>
  text.split('\n').find(line => line.trim() !== '')?.trim().slice(0, MAX_FAILURE_LENGTH) ?? fallback

/** `tsc --pretty false` output: `file(line,col): error TS1234: message` lines, run in `cwd`. */
export const parseTsc = (output: string, cwd: string, exitCode: number): CheckResult => {
  const findings = output.split('\n').flatMap((line): Finding[] => {
    const located = TSC_LOCATED.exec(line.trim())
    if (located !== null) {
      return [
        {
          file: resolveFrom(cwd, located[1] ?? ''),
          line: Number(located[2]),
          column: Number(located[3]),
          code: located[4] ?? '',
          message: located[5] ?? '',
        },
      ]
    }
    const global = TSC_GLOBAL.exec(line.trim())
    return global === null ? [] : [{ file: '', line: 0, column: 0, code: global[1] ?? '', message: global[2] ?? '' }]
  })
  if (exitCode !== 0 && findings.length === 0) return { checker: 'tsc', failure: firstLine(output, `exit code ${exitCode}`) }
  return { checker: 'tsc', findings }
}

/** `pyright --outputjson` output: its error diagnostics (warnings and information left out). */
export const parsePyright = (stdout: string, exitCode: number): CheckResult => {
  let report: unknown
  try {
    report = JSON.parse(stdout)
  } catch {
    return { checker: 'pyright', failure: firstLine(stdout, `exit code ${exitCode}`) }
  }
  const diagnostics =
    typeof report === 'object' && report !== null && 'generalDiagnostics' in report && Array.isArray(report.generalDiagnostics)
      ? (report.generalDiagnostics as unknown[])
      : []
  const findings = diagnostics.flatMap((diagnostic): Finding[] => {
    if (typeof diagnostic !== 'object' || diagnostic === null) return []
    const { file, severity, message, rule, range } = diagnostic as Record<string, unknown>
    if (severity !== 'error' || typeof message !== 'string') return []
    const start = (range as { start?: { line?: number; character?: number } } | undefined)?.start
    return [
      {
        file: typeof file === 'string' ? file : '',
        line: (start?.line ?? 0) + 1,
        column: (start?.character ?? 0) + 1,
        code: typeof rule === 'string' ? rule : 'error',
        message: message.split('\n')[0] ?? message,
      },
    ]
  })
  return { checker: 'pyright', findings }
}

/** mypy output: `file:line:col: error: message  [code]` lines, run in `cwd`. */
export const parseMypy = (output: string, cwd: string, exitCode: number): CheckResult => {
  const findings = output.split('\n').flatMap((line): Finding[] => {
    const match = MYPY_LINE.exec(line.trim())
    if (match === null) return []
    return [
      {
        file: resolveFrom(cwd, match[1] ?? ''),
        line: Number(match[2]),
        column: Number(match[3] ?? 1),
        code: match[5] ?? 'error',
        message: match[4] ?? '',
      },
    ]
  })
  if (exitCode > 1 || (exitCode !== 0 && findings.length === 0)) {
    return { checker: 'mypy', failure: firstLine(output, `exit code ${exitCode}`) }
  }
  return { checker: 'mypy', findings }
}

/**
 * The list Claude reads: at most `limit` errors, each `file:line:col  CODE  message`,
 * paths shown by `show`, and a line saying how many more there are.
 */
export const listFindings = (findings: readonly Finding[], limit: number, show: (file: string) => string): string[] => {
  const lines = findings
    .slice(0, limit)
    .map(finding =>
      finding.file === ''
        ? `  ${finding.code}  ${finding.message}`
        : `  ${show(finding.file)}:${finding.line}:${finding.column}  ${finding.code}  ${finding.message}`,
    )
  return findings.length > limit ? [...lines, `  … and ${findings.length - limit} more`] : lines
}
