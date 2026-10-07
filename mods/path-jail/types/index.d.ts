/** Folders added this session with /add-dir, trusted like the project root. */
export type PathJailAddedRoots = string[]

declare module 'claude-code' {
  interface PluginState {
    'path-jail': { addedRoots: PathJailAddedRoots }
  }
}
