/** One stop of the tour: a title, the explanation (Markdown) and the files it points at. */
export type TourStep = { title: string; body: string; files: string[] }

/** The tour of the current project, as the pane shows it and the store keeps it. */
export type Tour = {
  status: 'building' | 'ready' | 'failed'
  steps: TourStep[]
  /** The step shown, 0-based. */
  index: number
  /** Every step was seen to the end. */
  isFinished: boolean
  builtAt: number
  error: string
}

declare module 'claude-code' {
  interface PluginState {
    'onboarding-tour': { tour: Tour | null }
  }
}
