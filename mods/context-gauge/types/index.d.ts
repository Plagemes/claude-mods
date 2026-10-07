export type ContextGaugeFill = { percent: number; tokens: number; window: number }

declare module 'claude-code' {
  interface PluginState {
    'context-gauge': { fill: ContextGaugeFill | null; isHidden: boolean }
  }
}
