export type SecondOpinionAgreement = 'agree' | 'partly' | 'disagree' | 'unclear'

/** What the reviewing model said, read from its reply. */
export type SecondOpinionVerdict = {
  agreement: SecondOpinionAgreement
  summary: string
  concerns: { severity: 'high' | 'medium' | 'low'; text: string }[]
  suggestions: string[]
}

/** The latest second opinion asked for in this session. */
export type SecondOpinionReview = {
  status: 'running' | 'done' | 'failed'
  /** The reviewer's model, and the model whose answer it reviews. */
  model: string
  reviewedModel: string
  focus: string
  /** The start of the prompt the reviewed answer answered. */
  question: string
  /** How many file changes of that turn went along. */
  changes: number
  startedAt: number
  verdict?: SecondOpinionVerdict
  /** The reply as written, when it was not the JSON asked for. */
  raw?: string
  error?: string
  tokens?: { input: number; output: number }
}

declare module 'claude-code' {
  interface PluginState {
    'second-opinion': { review: SecondOpinionReview | null }
  }
}
