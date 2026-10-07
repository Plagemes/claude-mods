export type RecallHit = {
  source: string
  title: string
  line: number
  snippet: string
  score: number
}

export type RecallMemory = {
  id: string
  text: string
  /** The project root it was saved in; null for a memory every project shares. */
  project: string | null
  createdAt: number
}

export type RecallResults = {
  query: string
  hits: RecallHit[]
  /** What was searched, in words ("12 files, 4 memories"). */
  searched: string
}

declare module 'claude-code' {
  interface PluginState {
    recall: {
      results: RecallResults | null
      memories: RecallMemory[]
      isBusy: boolean
    }
  }
}
