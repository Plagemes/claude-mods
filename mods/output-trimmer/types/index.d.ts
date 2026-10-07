/** What trimming saved this session: characters kept out of the context, and how many outputs. */
export type OutputTrimmerSaved = { chars: number; outputs: number }

declare module 'claude-code' {
  interface PluginState {
    'output-trimmer': { saved: OutputTrimmerSaved }
  }
}
