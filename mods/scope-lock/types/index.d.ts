/** The globs writes are allowed under; empty when the scope is off. */
export type ScopeLockGlobs = string[]

declare module 'claude-code' {
  interface PluginState {
    'scope-lock': { globs: ScopeLockGlobs }
  }
}
