/** How much model a prompt needs, cheapest first. */
export type ModelAdvisorTier = 'light' | 'standard' | 'heavy'

/** A suggestion on show: the model alias to switch to and why. */
export type ModelAdvisorHint = { tier: ModelAdvisorTier; model: string; reason: string; prompt: number }

declare module 'claude-code' {
  interface PluginState {
    'model-advisor': {
      hint: ModelAdvisorHint | null
      /** Prompts classified this session, to space out repeated suggestions. */
      prompts: number
      /** The prompt number each model alias was last suggested at. */
      lastSuggested: Record<string, number>
      isMuted: boolean
    }
  }
}
