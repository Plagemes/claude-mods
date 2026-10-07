/** Masked values this session, by kind (`email`, `aws-key`, ...). */
export type RedactorCounts = Record<string, number>

declare module 'claude-code' {
  interface PluginState {
    redactor: { counts: RedactorCounts }
  }
}
