/** Whether learning mode is on for this session. */
export type LearningSwitch = boolean

declare module 'claude-code' {
  interface PluginState {
    'learning-mode': { isOn: LearningSwitch }
  }
}
