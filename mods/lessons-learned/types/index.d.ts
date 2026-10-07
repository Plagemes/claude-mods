/** A lesson waiting for the person to save or dismiss it. */
export type Lesson = {
  id: string
  /** The one-line lesson, as it will be written under "## Lessons learned". */
  text: string
  /** The check whose fix taught it (`npm test`, `cargo build`, ...). */
  check: string
}

declare module 'claude-code' {
  interface PluginState {
    'lessons-learned': { lessons: Lesson[] }
  }
}
