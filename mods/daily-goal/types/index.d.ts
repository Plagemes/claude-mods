/** One day's goal in one project. */
export type DailyGoalEntry = {
  /** The local date it is for, `YYYY-MM-DD`. */
  date: string
  text: string
  /** When it was set, in milliseconds since the epoch. */
  setAt: number
  status: 'open' | 'done' | 'missed'
  /** When it was marked done or missed. */
  closedAt?: number
  /** True once the evening question was answered "not yet": it is asked again the next day. */
  isAsked?: boolean
}

/** The question the band asks: did you reach this goal? */
export type DailyGoalQuestion = { date: string; text: string; isToday: boolean }

declare module 'claude-code' {
  interface PluginState {
    'daily-goal': {
      today: DailyGoalEntry | null
      question: DailyGoalQuestion | null
      isHidden: boolean
    }
  }
}
