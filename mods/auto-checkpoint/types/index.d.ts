/** One snapshot of the work tree, kept as refs/claude-checkpoints/<n>. */
export type AutoCheckpointEntry = {
  n: number
  sha: string
  tree: string
  at: number
  prompt: string
}

/** A one-line outcome the pane shows above the list. */
export type AutoCheckpointNotice = { text: string; tone: 'info' | 'success' | 'error' }

/** What the /checkpoints pane draws. */
export type AutoCheckpointView = {
  repo: string | null
  items: AutoCheckpointEntry[]
  confirming: number | null
  notice: AutoCheckpointNotice | null
}

declare module 'claude-code' {
  interface PluginState {
    'auto-checkpoint': { view: AutoCheckpointView }
  }
}
