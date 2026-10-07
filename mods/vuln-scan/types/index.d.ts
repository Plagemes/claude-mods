export type VulnSeverity = 'critical' | 'high' | 'moderate' | 'low' | 'info' | 'unknown'

/** One advisory affecting one package. */
export type VulnFinding = {
  package: string
  /** The installed version(s), where the auditor says. */
  version?: string
  severity: VulnSeverity
  /** GHSA, PYSEC, RUSTSEC or the auditor's own id. */
  id: string
  aliases?: string[]
  title: string
  url?: string
  /** The version range or upgrade that fixes it, where known. */
  fix?: string
  /** The vulnerable range, where the auditor says. */
  range?: string
  isDirect?: boolean
}

/** One auditor run over one project folder. */
export type VulnScan = {
  /** `npm audit`, `pip-audit`, ... */
  tool: string
  manager: 'npm' | 'pnpm' | 'yarn' | 'pip' | 'cargo'
  /** The folder audited, relative to the session's folder ('' for it). */
  dir: string
  at: number
  findings: VulnFinding[]
  /** Why the auditor could not run or report. */
  error?: string
}

/** What the /vulns pane and the status line draw. */
export type VulnReport = {
  scans: VulnScan[]
  /** The auditor running now, if any. */
  running: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'vuln-scan': { report: VulnReport }
  }
}
