export type CodebaseMapSaved = {
  /** The whole file as saved, stats comment included. */
  markdown: string
  files: number
  dirs: number
  generatedAt: number
  source: 'git' | 'walk'
  isTruncated: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'codebase-map': {
      map: CodebaseMapSaved | null
      isBusy: boolean
      error: string | null
    }
  }
}
