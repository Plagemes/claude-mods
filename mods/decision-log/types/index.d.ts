/** Where a draft stands: the fork is writing it, it awaits Save, it was written, or the fork failed. */
export type DraftPhase = 'drafting' | 'ready' | 'saved' | 'failed'

/** The ADR being prepared in the pane. */
export type Draft = {
  /** Identifies one /decide run, so a stale fork never overwrites a newer draft. */
  id: string
  title: string
  /** The number the ADR will get (the next free one when it is saved). */
  number: number
  /** YYYY-MM-DD, the day /decide ran. */
  date: string
  phase: DraftPhase
  /** The sections the fork wrote, from `## Context` on. */
  body: string
  /** Why drafting failed, when `phase` is `failed`. */
  error: string
  /** The written file, relative to the project root, when `phase` is `saved`. */
  path: string
}

declare module 'claude-code' {
  interface PluginState {
    'decision-log': { draft: Draft | null }
  }
}
