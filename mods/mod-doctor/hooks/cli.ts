import type { ProcessRunResult } from 'claude-code'

const CLAUDE = 'claude'
const CLAUDE_BINARY = /(^|[\\/])claude(\.exe)?$/i

/** What one `claude plugin ... --json` run said. */
export type CliOutcome = { isOk: boolean; message: string; oldVersion?: string; newVersion?: string; updateOutcome?: string }

/**
 * The `claude` executable to run: the one this session runs as when the
 * engine says so (CLAUDE_CODE_EXECPATH names a claude binary), else `claude`
 * from PATH. A path naming another program (node, under an npm install) is
 * not used, since `<node> plugin ...` would not be the CLI.
 */
export const claudeBinary = (execPath: string | undefined): string =>
  execPath !== undefined && CLAUDE_BINARY.test(execPath.trim()) ? execPath.trim() : CLAUDE

/** The argument vectors of every CLI call the doctor makes; never a shell. */
export const argv = {
  list: (bin: string): string[] => [bin, 'plugin', 'list', '--json'],
  marketplaces: (bin: string): string[] => [bin, 'plugin', 'marketplace', 'list', '--json'],
  validate: (bin: string, folder: string): string[] => [bin, 'plugin', 'validate', folder, '--json'],
  refreshMarketplace: (bin: string, marketplace: string): string[] => [bin, 'plugin', 'marketplace', 'update', marketplace, '--json'],
  update: (bin: string, id: string, scope: string): string[] => [bin, 'plugin', 'update', id, '--scope', scope, '--json'],
  enable: (bin: string, id: string, scope: string): string[] => [bin, 'plugin', 'enable', id, '--scope', scope, '--json'],
  disable: (bin: string, id: string, scope: string): string[] => [bin, 'plugin', 'disable', id, '--scope', scope, '--json'],
}

export const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

export const asText = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

const lastLine = (text: string): string =>
  text.trim().split('\n').map(line => line.replace(/^[×✖✗]\s*/, '').trim()).filter(line => line !== '').pop() ?? ''

/** Reads a `--json` run: its last JSON line with an `outcome`, else its exit code and stderr. */
export function parseOutcome(result: ProcessRunResult): CliOutcome {
  for (const line of result.stdout.trim().split('\n').reverse()) {
    let record: Record<string, unknown> | undefined
    try {
      record = asRecord(JSON.parse(line))
    } catch {
      continue
    }
    if (record === undefined || typeof record.outcome !== 'string') continue
    const oldVersion = asText(record.oldVersion)
    const newVersion = asText(record.newVersion)
    const updateOutcome = asText(record.updateOutcome)

    return {
      isOk: record.outcome === 'ok' && result.exitCode === 0,
      message: asText(record.message) ?? lastLine(result.stderr),
      ...(oldVersion === undefined ? {} : { oldVersion }),
      ...(newVersion === undefined ? {} : { newVersion }),
      ...(updateOutcome === undefined ? {} : { updateOutcome }),
    }
  }

  return { isOk: result.exitCode === 0, message: lastLine(result.stderr) || lastLine(result.stdout) || `exit code ${result.exitCode}` }
}
