// What to do with one subagent spawn, the profiles, and the orchestration guidance for the main model. Pure: no `$` here.

import type { SmartRouterAction, SmartRouterMode, SmartRouterProfile } from '../types'
import { tierDown, tierRank, tierUp } from './classify'
import type { Tier, Verdict } from './classify'
import { modelRank } from './shared/prices'

/** Agent types whose definition leaves the model to the call: the ones routed without `override: always`. */
export const ROUTABLE_TYPES: ReadonlySet<string> = new Set(['general-purpose', 'Explore', 'Plan'])
/** Successes of one kind in a row, on the same tier, before the next of that kind may run a tier lower. */
export const DEESCALATE_AFTER = 3
/** The value of a tier's model setting that leaves the model to the agent (the main model). */
export const INHERIT = 'inherit'
/** Kinds of task that change code: a fresh test regression sends the next one a tier up. */
const CHANGING_KINDS: ReadonlySet<string> = new Set(['bugfix', 'tests', 'feature', 'refactor', 'edit', 'pattern', 'default', 'performance'])

/** What a profile (or the configuration, as Balanced) sets. */
export type Tuning = {
  models: Record<Tier, string>
  protectDeep: boolean
  maxParallel: number
  /** USD of session spend past which borderline work goes a tier down; 0 is off. */
  budgetBias: number
  /** The most of a project's subagent tokens opus-class models should take, in %; 0 is off. */
  opusShare: number
  /** % of finished light and standard agents that changed files offered a quick review. */
  auditRate: number
}

/** The presets; Balanced is the configuration itself. */
export const PROFILES: Record<Exclude<SmartRouterProfile, 'balanced'>, Partial<Tuning>> = {
  saver: { models: { light: 'haiku', standard: 'sonnet', deep: 'opus' }, maxParallel: 3, budgetBias: 2, opusShare: 20, auditRate: 5 },
  fast: { models: { light: 'haiku', standard: 'sonnet', deep: 'sonnet' }, protectDeep: false, maxParallel: 8, opusShare: 0, auditRate: 0 },
  max: { models: { light: 'sonnet', standard: 'opus', deep: 'opus' }, protectDeep: true, maxParallel: 5, budgetBias: 0, opusShare: 0, auditRate: 25 },
}
export const PROFILE_NAMES: readonly SmartRouterProfile[] = ['saver', 'balanced', 'fast', 'max']

export const tuningFor = (base: Tuning, profile: SmartRouterProfile): Tuning => (profile === 'balanced' ? base : { ...base, ...PROFILES[profile] })

export type RouteSettings = Pick<Tuning, 'models' | 'protectDeep' | 'budgetBias' | 'opusShare'> & {
  mode: SmartRouterMode
  override: 'never' | 'always'
}

/** What the Agent call (or workflow) asked for, as `agent.spawn` reads it. */
export type SpawnFacts = {
  subagentType: string
  /** The model the caller set; undefined when it left it out. */
  model?: string
  parentModel: string
  isFork: boolean
  isWorkflow: boolean
  isTeammate: boolean
}

/** The last run of a task with the same description: its tier, its failures in a row and how it ended. */
export type Attempt = { tier: Tier; failures: number; outcome: 'running' | 'ok' | 'failed' }

/** Consecutive successes of one kind of task. */
export type Streak = { tier: Tier; successes: number }

export type RouteHistory = {
  /** The last run of the same task when this spawn retries it (it failed, or this redoes it). */
  previous?: Attempt
  streak?: Streak
  spentUsd: number
  /** This kind of task has been unreliable on the tier it would get, in this project. */
  isUnreliable?: boolean
  /** The tests passed before and fail now: the next change gets a stronger model. */
  isRegression?: boolean
  /** The project's opus-class share of subagent tokens, 0-1. */
  opusShare?: number
  /** A budget alert other mods raised on mods-hub's bus (`budget.threshold`), in words: "the session budget is 85% used". */
  budgetAlert?: string
}

export type RouteDecision = {
  action: SmartRouterAction
  tier: Tier
  /** The model set (routed), proposed (suggested) or standing (kept); undefined: the main model's. */
  model: string | undefined
  tag: string
  reason: string
  isRetry: boolean
}

const money = (usd: number): string => `$${usd.toFixed(2)}`

type Adjusted = { tier: Tier; tag: string; notes: string[]; isRetry: boolean }

/** The share of a budget at which a `budget.threshold` event biases borderline work down. */
export const BUDGET_ALERT_PERCENT = 80

/** A `budget.threshold` payload in words, or undefined when it is below the alert line or not one. */
export function budgetAlertOf(data: unknown): string | undefined {
  const event = (data ?? {}) as { kind?: unknown; scope?: unknown; percent?: unknown }
  if (typeof event.percent !== 'number' || event.percent < BUDGET_ALERT_PERCENT) return undefined
  const scope = event.scope === 'day' ? 'daily' : event.scope === 'week' ? 'weekly' : event.scope === 'month' ? 'monthly' : 'session'
  return `the ${scope} ${event.kind === 'tokens' ? 'token' : 'dollar'} budget is ${Math.round(event.percent)}% used`
}

/** The tier after the history: retries and trouble go up, easy streaks and spent budgets nudge borderline work down. */
function adjustTier(verdict: Verdict, settings: RouteSettings, history: RouteHistory): Adjusted {
  const notes = [verdict.reason]
  const up = (tag: string, note: string, isRetry = false): Adjusted => ({ tier: tierUp(verdict.tier), tag, notes: [...notes, note], isRetry })
  const down = (tag: string, note: string): Adjusted => ({ tier: tierDown(verdict.tier), tag, notes: [...notes, note], isRetry: false })
  const previous = history.previous
  if (previous !== undefined && previous.outcome !== 'running') {
    const needed: Tier = previous.failures >= 2 ? 'deep' : tierUp(previous.tier)
    if (tierRank(needed) > tierRank(verdict.tier)) {
      const why = previous.failures >= 2 ? 'it failed twice: deep' : previous.outcome === 'failed' ? `retry of a ${previous.tier} run that failed: one tier up` : `the same task again soon after: one tier up from ${previous.tier}`
      return { tier: needed, tag: 'retry↑', notes: [...notes, why], isRetry: true }
    }
    return { tier: verdict.tier, tag: verdict.tag, notes: [...notes, 'a retry, already above the last run’s tier'], isRetry: true }
  }
  if (verdict.tier !== 'deep' && history.isRegression === true && CHANGING_KINDS.has(verdict.tag)) return up('regression↑', 'the tests regressed after the last change: one tier up')
  if (verdict.tier !== 'deep' && history.isUnreliable === true) return up('unreliable↑', `${verdict.tag} work has often failed on ${verdict.tier} in this project: one tier up`)
  // Protect deep: the automatic nudges (an easy streak, a spent budget) never take deep work off the deep tier;
  // only the opus quota, a cap you set yourself, may.
  const isProtected = verdict.tier === 'deep' && settings.protectDeep
  const streak = history.streak
  if (streak !== undefined && streak.successes >= DEESCALATE_AFTER && streak.tier === verdict.tier && verdict.tier !== 'light' && !verdict.isDeepCategory && !isProtected) {
    return down('repeat↓', `${streak.successes} ${verdict.tag} tasks in a row went well on ${verdict.tier}: one tier down`)
  }
  if (settings.opusShare > 0 && (history.opusShare ?? 0) * 100 >= settings.opusShare && verdict.tier === 'deep' && verdict.isBorderline) {
    return down('quota↓', `opus already took ${Math.round((history.opusShare ?? 0) * 100)}% of this project's subagent tokens (quota ${settings.opusShare}%): borderline, one tier down`)
  }
  if (settings.budgetBias > 0 && history.spentUsd >= settings.budgetBias && verdict.isBorderline && verdict.tier !== 'light' && !isProtected) {
    return down('budget↓', `session spend ${money(history.spentUsd)} passed the ${money(settings.budgetBias)} budget bias: borderline, one tier down`)
  }
  if (settings.budgetBias > 0 && history.budgetAlert !== undefined && verdict.isBorderline && verdict.tier !== 'light' && !isProtected) {
    return down('budget↓', `${history.budgetAlert}: borderline, one tier down`)
  }
  return { tier: verdict.tier, tag: verdict.tag, notes, isRetry: false }
}

/** The model a tier runs on; undefined leaves it to the main model (an `inherit` setting, or deep work protected). */
function modelForTier(tier: Tier, settings: RouteSettings, parentModel: string, notes: string[]): string | undefined {
  const configured = settings.models[tier].trim()
  const target = configured === '' || configured === INHERIT ? undefined : configured
  if (tier !== 'deep' || !settings.protectDeep) return target
  const main = modelRank(parentModel)
  const chosen = target === undefined ? undefined : modelRank(target)
  if (target !== undefined && main !== undefined && chosen !== undefined && chosen >= main) return target
  notes.push('deep work stays on the main model (protect deep)')
  return undefined
}

/** Decides one spawn: route it, only suggest, or keep what stands. Mode `off` never gets here. */
export function decideRoute(verdict: Verdict, facts: SpawnFacts, settings: RouteSettings, history: RouteHistory): RouteDecision {
  const { tier, tag, notes, isRetry } = adjustTier(verdict, settings, history)
  const model = modelForTier(tier, settings, facts.parentModel, notes)
  const isOverriding = settings.override === 'always'
  const kept = (why: string, keptTag: string, standing: string | undefined): RouteDecision => ({
    action: 'kept',
    tier,
    model: standing,
    tag: keptTag,
    reason: `${why}; by difficulty: ${tier}${model === undefined ? '' : ` → ${model}`}`,
    isRetry,
  })

  if (facts.isFork) return kept('a fork always runs on the main model', 'fork', undefined)
  if (facts.model !== undefined && !isOverriding) return kept(`the caller chose ${facts.model}`, 'explicit', facts.model)
  if (facts.isWorkflow) {
    return { action: 'suggested', tier, model, tag, reason: `${notes.join('; ')}; a workflow agent's model is set in its script (opts.model), not here`, isRetry }
  }
  if ((facts.isTeammate || !ROUTABLE_TYPES.has(facts.subagentType)) && !isOverriding) {
    return kept(`${facts.isTeammate ? 'a teammate' : `the ${facts.subagentType} agent`} keeps its own model`, 'own model', undefined)
  }
  return { action: settings.mode === 'suggest' ? 'suggested' : 'routed', tier, model, tag, reason: notes.join('; '), isRetry }
}

/** useEffort: a routed, well-scoped deep task runs on the standard tier's model, the Agent call already set to effort high. */
export function withEffort(decision: RouteDecision, verdict: Verdict, models: Record<Tier, string>): RouteDecision {
  if (decision.action !== 'routed' || decision.tier !== 'deep' || !verdict.isScoped || decision.isRetry) return decision
  const model = models.standard === INHERIT ? undefined : models.standard
  return { ...decision, model, tag: 'effort', reason: `${decision.reason}; well scoped: ${model ?? 'the main model'} at effort high (useEffort)` }
}

/** The Agent tool's model values: a configured model outside them is named in full. */
const AGENT_MODELS = ['haiku', 'sonnet', 'opus', 'fable']

/** How a prompt tells Claude which model a tier gets. */
export const modelWords = (model: string): string => {
  const trimmed = model.trim()
  if (trimmed === '' || trimmed === INHERIT) return 'no model (the main one)'
  return AGENT_MODELS.includes(trimmed) ? trimmed : `"${trimmed}"`
}

/** How parallel prompts reuse the prompt cache. */
export const SHARED_OPENING =
  'Start every parallel agent\'s prompt with the same shared context block (the goal and the facts they all need), then its own task: identical openings reuse the prompt cache.'

/** How tiny light chores are batched. */
export const BATCHING = 'Many tiny chores of one kind (ten renames, a list of lookups) go to ONE light agent as a list, not one agent each.'

export type GuidanceSettings = { models: Record<Tier, string>; maxParallel: number; hasWorkflow: boolean; isAuto: boolean }

/**
 * The system-prompt section: how to split work and which model each piece gets.
 * It depends only on settings, so it stays the same all session (prompt cache).
 */
export function guidanceText(settings: GuidanceSettings): string {
  const { models, maxParallel } = settings
  const lines = [
    '# Routing work by difficulty (smart-router)',
    'Choose how to run each piece of work:',
    '- Inline, no subagent: about 3 tool calls or fewer, work that needs this conversation\'s details, or one small edit.',
    '- One subagent: a self-contained chunk that would flood this context (a broad search, many files, long logs); ask for a concise summary.',
    `- Parallel subagents: 2-${maxParallel} independent subtasks (self-contained prompts, not writing the same files): send all their Agent calls in ONE message; more than ${maxParallel} go in batches. Two that would write the same files run in order or with isolation: "worktree". After parallel writes, verify once (tests or lint) before reporting done.`,
    `- ${SHARED_OPENING}`,
    `- ${BATCHING}`,
    '- In order: dependent subtasks run in sequence; independent ones within a stage still run in parallel.',
  ]
  if (settings.hasWorkflow) {
    lines.push(
      '- Workflow (the Workflow tool): only when the user explicitly asked (a workflow, orchestration, "Run as workflow" in /route, or "ultracode") and the job is big or structured: 6+ subtasks, a multi-stage pipeline, deterministic retries or resume, or 10+ agents. Otherwise propose it with a rough cost (agents × tier) and wait; never start one on your own. In a workflow script set opts.model on each agent() by the same tiers.',
    )
  }
  lines.push(
    'Set `model` on each Agent call by difficulty:',
    `- light → ${modelWords(models.light)}: read-only exploration (search, read, summarise, find usages), reading docs, running a command and reporting its output, extracting or reformatting data, mechanical edits with exact instructions, boilerplate from a template.`,
    `- standard → ${modelWords(models.standard)} (default when unsure): a feature with a clear spec, tests, a bug with a reproduction, a refactor within one module (up to 5 files), reviewing a small diff, docs, following an existing pattern.`,
    `- deep → ${modelWords(models.deep)}: architecture trade-offs, ambiguous or conflicting requirements, cross-cutting changes (over 5 modules, or public APIs), security review, concurrency, performance or memory root causes, irreversible or production work (migrations, deploy scripts, auth, crypto), merging parallel results, any task that already failed twice.`,
    'A retry of a subtask whose agent failed goes one tier up; never retry on the same tier twice. Never set `effort` unless the user asked for it.',
  )
  if (settings.isAuto) lines.push('When you leave `model` out, smart-router picks it by these rules; a model you set is kept.')
  lines.push('You coordinate: plan, dispatch, integrate, verify. Do not redo the subagents\' work.')
  return lines.join('\n')
}
