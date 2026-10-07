export type ExplainLevelName = 'eli5' | 'normal' | 'expert'

declare module 'claude-code' {
  interface PluginState {
    'explain-level': { level: ExplainLevelName }
  }
}
