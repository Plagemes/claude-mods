/** New component files and the stories they still lack. */
export type StorybookNudgeState = {
  /** Created in the running turn; each is checked for a story when the turn ends. */
  watching: string[]
  /** Checked at the end of a turn and still without a story: what the band offers to fix. */
  missing: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'storybook-nudge': { state: StorybookNudgeState }
  }
}
