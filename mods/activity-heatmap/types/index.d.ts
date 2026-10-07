/** Prompt counts per weekday and hour: `counts[day * 24 + hour]`, day 0 being Sunday. */
export type Activity = {
  counts: number[]
  /** When the first prompt was counted, in milliseconds since the epoch; 0 before any. */
  since: number
}

declare module 'claude-code' {
  interface PluginState {
    'activity-heatmap': { activity: Activity }
  }
}
