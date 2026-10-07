const CLAUDE = 'claude'
const CLAUDE_BINARY = /(^|[\\/])claude(\.exe)?$/i

/**
 * The `claude` executable to run: the one this session runs as when the
 * engine says so (CLAUDE_CODE_EXECPATH names a claude binary), else `claude`
 * from PATH. A path naming another program (node, under an npm install) is
 * not used, since `<node> plugin ...` would not be the CLI.
 */
export const claudeBinary = (execPath: string | undefined): string =>
  execPath !== undefined && CLAUDE_BINARY.test(execPath.trim()) ? execPath.trim() : CLAUDE

/** What `claude plugin validate --json` reported. */
export type Validation = { isOk: boolean; errors: string[]; warnings: number }

/** What `claude plugin test` printed at its end. */
export type TestRun = { passed: number; failed: number }

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const messagesOf = (section: Record<string, unknown> | undefined, field: 'errors' | 'warnings'): string[] =>
  asList(section?.[field]).flatMap(entry => {
    const message = asRecord(entry)?.message
    return typeof message === 'string' ? [message] : []
  })

/** Reads a `claude plugin validate <dir> --json` report; undefined when stdout is not one. */
export function parseValidation(stdout: string): Validation | undefined {
  let report: Record<string, unknown> | undefined
  try {
    report = asRecord(JSON.parse(stdout))
  } catch {
    return undefined
  }
  if (report === undefined || typeof report.success !== 'boolean') return undefined
  const sections = [asRecord(report.manifest), ...asList(report.contents).map(asRecord)]

  return {
    isOk: report.success,
    errors: sections.flatMap(section => messagesOf(section, 'errors')),
    warnings: sections.flatMap(section => messagesOf(section, 'warnings')).length,
  }
}

/** Reads the `N pass` / `N fail` lines `claude plugin test` ends with; undefined without them. */
export function parseTestRun(output: string): TestRun | undefined {
  const passed = /^\s*(\d+) pass\b/m.exec(output)
  const failed = /^\s*(\d+) fail\b/m.exec(output)
  if (passed === null && failed === null) return undefined

  return { passed: Number(passed?.[1] ?? 0), failed: Number(failed?.[1] ?? 0) }
}
