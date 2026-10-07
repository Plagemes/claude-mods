export type RecentFilesEntry = {
  path: string
  isRead: boolean
  isEdited: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'recent-files': { files: RecentFilesEntry[] }
  }
}
