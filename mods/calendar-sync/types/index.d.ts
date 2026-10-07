/** What an event or a free stretch means for presence. */
export type CalendarKind = 'off' | 'busy' | 'free'

/** Where the person is according to the calendar, now. */
export type CalendarStatus = {
  kind: CalendarKind
  /** When this busy or out-of-office block ends; null when free. */
  until: number | null
  /** The title of the event that makes it so ('' when free). */
  title: string
  /** When the next busy or out-of-office block starts, if one is known. */
  nextAt: number | null
  nextTitle: string
}

export type CalendarSlot = { start: number; end: number }

export type CalendarRow = { time: string; title: string; kind: CalendarKind; isNow: boolean; isPast: boolean; location: string }

export type CalendarDay = { date: string; label: string; rows: CalendarRow[]; slots: CalendarSlot[]; isToday: boolean }

/** Everything the tab and the pane draw. */
export type CalendarView = {
  phase: 'unconfigured' | 'loading' | 'ready' | 'error'
  message: string
  fetchedAt: number
  zone: string
  status: CalendarStatus
  days: CalendarDay[]
  /** One line: "You're free 14:00–16:30 today (2h 30m)", or '' when there is nothing to say. */
  freeLine: string
}

declare module 'claude-code' {
  interface PluginState {
    'calendar-sync': {
      view: CalendarView
      /** How many days the view shows: 2 (today, tomorrow) or 7. */
      span: number
      /** What this mod holds in the hub right now: '' (nothing), 'meeting' or 'out-of-office'. */
      hold: string
      isLeader: boolean
    }
  }
}
