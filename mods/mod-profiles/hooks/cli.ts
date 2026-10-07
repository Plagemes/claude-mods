import type { ProcessRunResult } from 'claude-code'

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

/** The argument vectors of every CLI call the profiles make; never a shell. */
export const argv = {
  list: (bin: string): string[] => [bin, 'plugin', 'list', '--json'],
  enable: (bin: string, id: string, scope: string): string[] => [bin, 'plugin', 'enable', id, '--scope', scope, '--json'],
  disable: (bin: string, id: string, scope: string): string[] => [bin, 'plugin', 'disable', id, '--scope', scope, '--json'],
}

const lastLine = (text: string): string =>
  text.trim().split('\n').map(line => line.replace(/^[×✖✗]\s*/, '').trim()).filter(line => line !== '').pop() ?? ''

/** Whether a `--json` run succeeded, and what it said: its last JSON line with an `outcome`, else stderr. */
export function parseOutcome(result: ProcessRunResult): { isOk: boolean; message: string } {
  for (const line of result.stdout.trim().split('\n').reverse()) {
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof record !== 'object' || record === null || !('outcome' in record)) continue
    const { outcome, message } = record as { outcome: unknown; message?: unknown }
    return {
      isOk: outcome === 'ok' && result.exitCode === 0,
      message: typeof message === 'string' ? message : lastLine(result.stderr),
    }
  }

  return { isOk: result.exitCode === 0, message: lastLine(result.stderr) || lastLine(result.stdout) || `exit code ${result.exitCode}` }
}
