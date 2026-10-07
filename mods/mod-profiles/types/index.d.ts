/** A saved set of mods: which installed plugins were on, and which were off. */
export type ModProfile = {
  /** Plugin ids (`name@marketplace`) that were enabled when it was saved. */
  enabled: string[]
  /** Plugin ids that were installed but disabled when it was saved. */
  disabled: string[]
  savedAt: number
}

/** One installed plugin, as `claude plugin list --json` reports it. */
export type ModProfilesPlugin = { id: string; scope: string; isEnabled: boolean }

/** The installed plugins as last listed, or why they could not be. */
export type ModProfilesCurrent =
  | { isKnown: true; plugins: ModProfilesPlugin[]; listedAt: number }
  | { isKnown: false; error: string }

/** The pane's selection and pending confirmation. */
export type ModProfilesView = { selected: string | null; confirming: string | null }

/** The last action's outcome, drawn in the pane until dismissed. */
export type ModProfilesNotice = { tone: 'success' | 'error' | 'info'; text: string }

declare module 'claude-code' {
  interface PluginState {
    'mod-profiles': {
      profiles: Record<string, ModProfile>
      active: string | null
      current: ModProfilesCurrent | null
      view: ModProfilesView
      busy: string | null
      notice: ModProfilesNotice | null
    }
  }
}
