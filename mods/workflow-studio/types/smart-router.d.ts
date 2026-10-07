// The part of smart-router's public state workflow-studio reads (its last /route plan, for `/recipe save`).
// Written from mods/smart-router/types/index.d.ts; any plugin may read another's state, only its owner writes it.

export type SmartRouterPlanForRecipe = {
  task: string
  mode: 'inline' | 'single' | 'parallel' | 'sequential' | 'workflow'
  subtasks: { title: string; tier: 'light' | 'standard' | 'deep'; prompt: string; dependsOn: number[]; writes: string[] }[]
  stages: number[][]
  createdAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'smart-router': {
      plan: SmartRouterPlanForRecipe | null
    }
  }
}
