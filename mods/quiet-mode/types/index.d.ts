/** Whether quiet mode is on, and when it ends by itself. */
export type QuietState = {
  isOn: boolean
  /** When it ends, in milliseconds since the epoch (`$.clock.now()`); null when it lasts until switched off. */
  until: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'quiet-mode': { quiet: QuietState }
  }
}
