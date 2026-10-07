export type HadolintFinding = { code: string; level: string; line: number; message: string }

const REPORTED_LEVELS = new Set(['error', 'warning', 'info'])

/** hadolint's `--format json` output; undefined when it is not that (a crash, a different tool). */
export function parseHadolint(stdout: string): HadolintFinding[] | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (!Array.isArray(parsed)) return undefined
    return parsed
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map(item => ({
        code: String(item.code ?? ''),
        level: String(item.level ?? ''),
        line: Number(item.line ?? 0),
        message: String(item.message ?? ''),
      }))
      .filter(finding => REPORTED_LEVELS.has(finding.level))
  } catch {
    return undefined
  }
}
