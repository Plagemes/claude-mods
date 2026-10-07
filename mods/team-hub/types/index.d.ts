/** Where a level of notification goes, from weakest to strongest: nowhere, the terminal, channels while away, channels always. */
export type TeamRoute = 'off' | 'terminal' | 'away' | 'always'

export type TeamLevel = 'info' | 'success' | 'warning' | 'error' | 'critical'

/** The guard level the team requires from guardian: nothing, the usual rules, or the strictest. */
export type TeamGuardLevel = 'off' | 'standard' | 'strict'

/** `.claude/team.json`, read and checked. Unknown keys are kept in `extra` so saving never drops them. */
export type TeamConfig = {
  version: number
  name: string
  /** The team's working conventions, plain text or markdown; added to the system prompt (capped). */
  conventions: string
  recommendedMods: string[]
  /** GitHub `owner/repo` whose marketplace the recommended mods come from. */
  marketplace: string
  /** The marketplace's name, as `mod@marketplace` spells it. */
  marketplaceName: string
  guardLevel: TeamGuardLevel
  budget: { sessionUsd?: number; sessionTokens?: number; dailyUsd?: number }
  /** The weakest route each level may have on a team member's machine. */
  notifications: Partial<Record<TeamLevel, TeamRoute>>
  /** Maintainers who may edit the file here: matched on `git config user.email` or `user.name`. */
  owners: string[]
  extra: Record<string, unknown>
}

/** One way a person's own settings differ from the team's rules. */
export type TeamDrift = {
  id: string
  title: string
  team: string
  personal: string
  /** The `/config` row and the value that brings it back in line, when this mod can set it. */
  fix?: { key: string; value: number }
  /** What to type for a setting this mod cannot change by itself. */
  hint?: string
}

export type TeamMod = { name: string; state: 'installed' | 'disabled' | 'missing'; version: string }

/** Everything the tab and the pane draw. */
export type TeamView = {
  phase: 'loading' | 'ready' | 'absent' | 'invalid'
  path: string
  /** Why the file cannot be used (`invalid`), or what in it was ignored (`ready`). */
  problems: string[]
  team: TeamConfig | null
  mods: TeamMod[]
  /** Whether `claude plugin list` could be read: false shows the mods as unknown. */
  isInstalledKnown: boolean
  drift: TeamDrift[]
  isMaintainer: boolean
  who: string
  /** The work in progress ('' when none), e.g. "Installing guardian (1/2)". */
  busy: string
  notice: { tone: 'success' | 'error' | 'info'; text: string } | null
  isEditing: boolean
  /** The editor's working copy (null outside editing). */
  draft: TeamConfig | null
}

declare module 'claude-code' {
  interface PluginState {
    'team-hub': {
      view: TeamView
    }
  }
}
