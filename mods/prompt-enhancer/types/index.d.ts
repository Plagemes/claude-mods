/** The draft being enhanced and where the rewrite stands. */
export type Enhancement = {
  status: 'idle' | 'working' | 'done' | 'failed'
  original: string
  enhanced: string
  /** Why there is no rewrite, when the status is `failed`. */
  error?: string
  model?: string
  /** The detected stack the rewrite was told about, for the pane's footer. */
  stack?: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-enhancer': { enhancement: Enhancement }
  }
}
