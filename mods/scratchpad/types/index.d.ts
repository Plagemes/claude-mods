/** One note: its id, its text and when it was written (ms since the epoch). */
export type ScratchpadNote = { id: string; text: string; createdAt: number }

declare module 'claude-code' {
  interface PluginState {
    scratchpad: {
      /** The project root the notes belong to, and its notes, newest first. */
      board: { project: string; notes: ScratchpadNote[] } | null
      /** What the pane's field holds, so it can be emptied once a note is added. */
      draft: string
    }
  }
}
