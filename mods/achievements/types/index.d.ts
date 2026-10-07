/** Everything achievements remembers, kept in $.store across sessions and projects. */
export type AchievementsProgress = {
  /** Sum counters (prompts, commits, ...) and best values (bestStreak, sessionFiles, flags). */
  counters: Record<string, number>
  /** When each unlocked achievement was unlocked, by id, in milliseconds since the epoch. */
  unlocked: Record<string, number>
  /** Programming languages edited so far, for Polyglot. */
  languages: string[]
  /** Local dates (`YYYY-MM-DD`) with a prompt, the last 60. */
  activeDays: string[]
  /** Tool calls and failures per local date, the last 7, for Flawless day. */
  daily: Record<string, { tools: number; errors: number }>
  /** Dates that were flawless. */
  flawlessDays: string[]
}

/** What the pane shows: the progress as of the last save, and the filter picked. */
export type AchievementsView = { filter: string }

declare module 'claude-code' {
  interface PluginState {
    achievements: {
      progress: AchievementsProgress | null
      view: AchievementsView
    }
  }
}
