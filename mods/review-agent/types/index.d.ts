export type ReviewState = {
  status: 'running' | 'done' | 'failed'
  /** The base the person named after /review ("" for uncommitted changes). */
  base: string
  /** "uncommitted changes" or "changes since main". */
  label: string
  /** git diff --shortstat, e.g. "3 files changed, 120 insertions(+), 30 deletions(-)". */
  stat: string
  /** The reviewer's Markdown report, or why it failed. */
  report: string
  startedAt: number
  agentId?: string
}

declare module 'claude-code' {
  interface PluginState {
    'review-agent': {
      review: ReviewState | null
      /** Ids of reviewer subagents, whose Bash calls are held to read-only git. */
      reviewers: string[]
    }
  }
}
