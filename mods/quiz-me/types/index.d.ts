/** One multiple-choice question: four options, the index of the right one, and why it is right. */
export type QuizQuestion = { q: string; options: string[]; answer: number; why: string }

/** The quiz in the pane. */
export type Quiz = {
  id: string
  /** What it is about: "the last turn (2 files)", "src/cart.ts", "uncommitted changes". */
  source: string
  status: 'writing' | 'asking' | 'done' | 'failed'
  questions: QuizQuestion[]
  /** The question shown. */
  index: number
  /** The option picked for each question so far (null: not answered yet). */
  picked: (number | null)[]
  error: string
}

/** One finished quiz, kept across sessions for /quiz stats. */
export type QuizScore = { at: number; source: string; correct: number; total: number }

declare module 'claude-code' {
  interface PluginState {
    'quiz-me': { quiz: Quiz | null }
  }
}
