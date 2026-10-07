/** Whether offline mode is on for this session. */
export type OfflineModeState = { isOn: boolean }

declare module 'claude-code' {
  interface PluginState {
    'offline-mode': { offline: OfflineModeState }
  }
}
