/** How hard a piece of work is: light → haiku, standard → sonnet, deep → opus (by default). */
export type SmartRouterTier = 'light' | 'standard' | 'deep'

/** auto: set the model of each spawn; suggest: only log what it would set; off: do nothing. */
export type SmartRouterMode = 'auto' | 'suggest' | 'off'

/** The model families the dashboard counts by. */
export type SmartRouterFamily = 'haiku' | 'sonnet' | 'opus' | 'fable' | 'other'

/** The collapsible sections of the Router pane. */
export type SmartRouterSection = 'live' | 'mix' | 'log' | 'plan' | 'rules'

/** One-click presets for the tier models, quota, parallelism, budget bias and audit rate. */
export type SmartRouterProfile = 'saver' | 'balanced' | 'fast' | 'max'

/** Session changes made from the pane; an absent field follows the profile, then the configuration. */
export type SmartRouterTweaks = { profile?: SmartRouterProfile; protectDeep?: boolean; isBudgetBiasOn?: boolean; maxParallel?: number }

/** Session money and agents: `usd` is every turn's cost, the rest the subagents'. */
export type SmartRouterTotals = {
  usd: number
  subagentUsd: number
  /** What the same subagent tokens would have cost on the main model. */
  baselineUsd: number
  agents: number
  mainModel: string
}

export type SmartRouterModelStats = { calls: number; tokens: number; usd: number; baselineUsd: number }

export type SmartRouterMix = {
  models: Partial<Record<SmartRouterFamily, SmartRouterModelStats>>
  /** Savings per main-loop turn, oldest first (the last 30). */
  savings: number[]
  /** Subagent input tokens served from the prompt cache, and all their input tokens. */
  cacheRead: number
  cacheInput: number
}

export type SmartRouterLiveAgent = {
  agentId: string
  tier: SmartRouterTier
  family: SmartRouterFamily
  description: string
  startedAt: number
  tools: number
}

export type SmartRouterLive = { agents: SmartRouterLiveAgent[]; polledAt: number }

/** routed: the model was set; suggested: logged only; kept: the caller's or the agent's own model stands. */
export type SmartRouterAction = 'routed' | 'suggested' | 'kept'

export type SmartRouterDecision = {
  id: string
  at: number
  agentId?: string
  agentType: string
  description: string
  /** The start of the task, for the detail view and for learning a rule. */
  excerpt: string
  tier: SmartRouterTier
  /** The model the agent runs on (or would, when suggested); `inherit` for the main model. */
  model: string
  action: SmartRouterAction
  /** A short reason tag: explore, design, retry↑, budget↓, explicit, … */
  tag: string
  /** The kind of task, as the classifier named it: what outcome learning counts by. */
  category: string
  reason: string
  signals: string[]
  mainModel: string
  usd?: number
  baselineUsd?: number
  outcome?: 'ok' | 'failed'
  correctedTo?: SmartRouterTier
  /** The share of its input the prompt cache served. */
  cacheShare?: number
  /** Set when useEffort ran a well-scoped deep task on the standard model at effort high. */
  effort?: 'high'
}

/** How reliable one kind of task has been on one tier, per project: a decaying score from 0 to 1. */
export type SmartRouterReliability = { score: number; runs: number; at: number }

/** What smart-router keeps per project: outcome learning and the subagent tokens per family (for the quota). */
export type SmartRouterProject = {
  /** By `<category>|<tier>`. */
  reliability: Record<string, SmartRouterReliability>
  tokens: Partial<Record<SmartRouterFamily, number>>
}

/** A sampled quality check offered after a light or standard agent changed files. */
export type SmartRouterAudit = { id: string; agentId: string; description: string; category: string; tier: SmartRouterTier; reviewer: string; at: number }

export type SmartRouterEstimate = { tokens: number; usd: number }

/** A correction made in the pane: prompts with these keywords get this tier, before any other rule. */
export type SmartRouterRule = { id: string; keywords: string[]; tier: SmartRouterTier; example: string; createdAt: number }

export type SmartRouterSubtask = {
  title: string
  tier: SmartRouterTier
  prompt: string
  /** Indexes (from 0) of the subtasks it needs first. */
  dependsOn: number[]
  writes: string[]
}

/** How a plan should run: here, one subagent, parallel subagents, in order, or as a workflow. */
export type SmartRouterPlanMode = 'inline' | 'single' | 'parallel' | 'sequential' | 'workflow'

export type SmartRouterPlan = {
  task: string
  tier: SmartRouterTier
  subtasks: SmartRouterSubtask[]
  /** Subtask indexes per stage, in run order; one stage's subtasks run in parallel. */
  stages: number[][]
  mode: SmartRouterPlanMode
  reason: string
  notes: string[]
  /** Rule B4: big or structured enough for the Workflow tool. */
  isWorkflowEligible: boolean
  /** The planner model gave no usable split: a one-step plan from the local rules. */
  isFallback: boolean
  mainModel: string
  createdAt: number
  /** Rough cost of each way to run it, from typical token counts per tier. */
  forecast: { inline: SmartRouterEstimate; parallel: SmartRouterEstimate; workflow: SmartRouterEstimate }
}

declare module 'claude-code' {
  interface PluginState {
    'smart-router': {
      modeOverride: SmartRouterMode | null
      tweaks: SmartRouterTweaks
      collapsed: Partial<Record<SmartRouterSection, boolean>>
      totals: SmartRouterTotals
      mix: SmartRouterMix
      live: SmartRouterLive
      log: SmartRouterDecision[]
      selected: string | null
      plan: SmartRouterPlan | null
      rules: SmartRouterRule[]
      project: SmartRouterProject
      audits: SmartRouterAudit[]
    }
  }
}
