/** How serious a finding is: what the pane sorts and colors by. */
export type DoctorSeverity = 'error' | 'warning' | 'info' | 'ok'

/** A CLI change the doctor can make for a finding. */
export type DoctorAction = 'update' | 'enable' | 'disable'

/** One fix button: the change, the plugin id it applies to and its install scope. */
export type DoctorFix = { action: DoctorAction; id: string; scope: string; label: string }

/** One thing the check found, with the fixes it offers. */
export type DoctorFinding = {
  /** Stable across checks: what the pane keys the finding's rows by. */
  key: string
  severity: DoctorSeverity
  title: string
  details: string[]
  fixes: DoctorFix[]
}

/** Where the versions of the claude-mods catalog came from. */
export type DoctorCatalog = {
  marketplace: string
  source: 'github' | 'cache' | 'local' | 'none'
  fetchedAt?: number
  message?: string
}

/** One finished check. */
export type DoctorReport = {
  checkedAt: number
  plugins: number
  enabled: number
  catalog: DoctorCatalog
  findings: DoctorFinding[]
}

/** The outcome of the last fix, drawn above the findings until dismissed. */
export type DoctorNotice = { tone: 'success' | 'error' | 'info'; text: string; canReload: boolean }

declare module 'claude-code' {
  interface PluginState {
    'mod-doctor': {
      report: DoctorReport | null
      isChecking: boolean
      busy: string | null
      notice: DoctorNotice | null
    }
  }
}
