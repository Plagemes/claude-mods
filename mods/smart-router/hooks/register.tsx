import { atom, read, update } from 'claude-code'
import type { AgentSpawnInput, AgentSpawnResult, ElementTable, EngineInterface, PluginOptions, Register, RenderElement, RenderInput, RenderSurface, Timer, TurnCompleteInput } from 'claude-code'

import type {
  SmartRouterAudit,
  SmartRouterDecision,
  SmartRouterFamily,
  SmartRouterMode,
  SmartRouterPlan,
  SmartRouterProfile,
  SmartRouterProject,
  SmartRouterRule,
  SmartRouterSection,
  SmartRouterSubtask,
  SmartRouterTotals,
  SmartRouterTweaks,
} from '../types'
import { CLASSIFIER_SYSTEM, TIERS, classifierPrompt, classify, keywordsOf, matchRule, tierFromReply, tierRank, tierUp } from './classify'
import type { TaskInput, Tier, Verdict } from './classify'
import { EMPTY_PROJECT, NOTHING_FLUSHED, TEST_COMMAND, dateOf, isUnreliable, mergeDaily, opusShareOf, recordOutcome, sessionFigures, weakSpots } from './learning'
import type { Flushed } from './learning'
import { PLANNER_SYSTEM, buildPlan, parseSubtasks, planText, plannerPrompt, runPrompt, titleOf, workflowPrompt } from './plan'
import type { TierResolver } from './plan'
import { costOf, familyOf, freshTokensOf, pricesWith } from './shared/prices'
import type { PriceTable } from './shared/prices'
import { INHERIT, PROFILE_NAMES, ROUTABLE_TYPES, budgetAlertOf, decideRoute, guidanceText, tuningFor, withEffort } from './routing'
import type { Attempt, RouteDecision, RouteSettings, Streak, Tuning } from './routing'
import {
  FAMILIES,
  FAMILY_TIER,
  TIER_COLOR,
  TIER_GLYPH,
  barCells,
  callsOf,
  elapsed,
  familyColor,
  familyGlyph,
  money,
  packCells,
  savingsLine,
  segmentsOf,
  sparkCells,
  sparkText,
  statusText,
  tokens,
  tokensByFamily,
  truncate,
} from './view'
import type { Segment } from './view'

const PANE = 'smart-router'
const PANE_TITLE = 'Router'
/** The hub's shared panel, and the Router's tab in it (order 20, after the Advisor). */
const HUB_PANE = 'claude-mods'
const TAB = { id: 'router', title: 'Router', order: 20, command: 'router' } as const
/** How much of a decision's reason goes into an `agent.routed` event. */
const EVENT_REASON_CHARS = 300
/** The dock width the pane asks for: a sidebar. */
const PANE_COLUMNS = 52
/** From this many body columns, a plan's stages sit side by side. */
const WIDE_COLUMNS = 90
const SECTION_ID = 'smart-router:routing'
const POLL_MS = 2_000
const LOG_SIZE = 50
const SAVINGS_POINTS = 30
/** How much of a spawn's prompt a decision keeps, for its detail, a correction and Copy prompt. */
const EXCERPT_CHARS = 2_000
const EXCERPT_SHOWN = 240
const CLASSIFY_TIMEOUT_MS = 4_000
const PLAN_TIMEOUT_MS = 25_000
const PLAN_MAX_TOKENS = 2_000
const CACHE_SIZE = 200
const TRACKED_AGENTS = 300
const MAX_RULES = 50
const MAX_AUDITS = 5
const MAX_PARALLEL_LIMIT = 8
/** A same-prompt re-spawn this soon after a success is a redo of work that did not satisfy. */
const REDO_WINDOW_MS = 5 * 60_000
/** A test run that fails this soon after an agent's edits counts against that agent's tier. */
const BLAME_WINDOW_MS = 15 * 60_000
/** The summary files are written this long after the last change, not on every one. */
const FLUSH_MS = 5_000
const RULES_KEY = 'rules:'
const PROJECT_KEY = 'project:'
const FILES_DIR = '.claude/claude-mods/smart-router'
const AUDIT_MARK = /\[smart-router audit ([\w-]+)\]/
const AUDIT_VERDICT = /AUDIT:\s*(PASS|FAIL)/i
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])
const DEFAULT_MODELS: Record<Tier, string> = { light: 'haiku', standard: 'sonnet', deep: 'opus' }
const MODES: readonly SmartRouterMode[] = ['auto', 'suggest', 'off']
const MODE_LABEL: Record<SmartRouterMode, string> = { auto: 'Auto', suggest: 'Suggest', off: 'Off' }
const PROFILE_LABEL: Record<SmartRouterProfile, string> = { saver: 'Saver', balanced: 'Balanced', fast: 'Fast', max: 'Max quality' }
const PROFILE_HOTKEY: Record<SmartRouterProfile, string> = { saver: 'v', balanced: 'n', fast: 'f', max: 'q' }
const FINISHED: ReadonlySet<string> = new Set(['completed', 'failed', 'killed'])
const FIX_HOTKEY: Record<Tier, string> = { light: 'l', standard: 'm', deep: 'd' }
const RUN_LABEL: Record<SmartRouterPlan['mode'], string> = {
  inline: 'Run here',
  single: 'Run with one agent',
  parallel: 'Run in parallel',
  sequential: 'Run in order',
  workflow: 'Run in parallel',
}
const MODE_WORDS: Record<SmartRouterPlan['mode'], string> = {
  inline: 'Inline',
  single: 'One subagent',
  parallel: 'Parallel subagents',
  sequential: 'In order',
  workflow: 'Workflow (needs your OK)',
}
const SECTIONS: readonly { id: SmartRouterSection; title: string; hotkey: string }[] = [
  { id: 'live', title: 'Live now', hotkey: '1' },
  { id: 'mix', title: 'Mix', hotkey: '2' },
  { id: 'log', title: 'Decisions', hotkey: '3' },
  { id: 'plan', title: 'Plan', hotkey: '4' },
  { id: 'rules', title: 'Rules & settings', hotkey: '5' },
]
const ROUTE_USAGE = 'Usage: /route <task> drafts a plan: subtasks, tiers, parallel stages and how to run them.'
const ROUTER_USAGE = 'Usage: /router [auto | suggest | off | reset]'
const NO_TOTALS: SmartRouterTotals = { usd: 0, subagentUsd: 0, baselineUsd: 0, agents: 0, mainModel: '' }

const modeOverride = atom({ plugin: 'smart-router', key: 'modeOverride' } as const, null)
const tweaksAtom = atom({ plugin: 'smart-router', key: 'tweaks' } as const, {})
const collapsedAtom = atom({ plugin: 'smart-router', key: 'collapsed' } as const, { rules: true })
const totalsAtom = atom({ plugin: 'smart-router', key: 'totals' } as const, NO_TOTALS)
const mixAtom = atom({ plugin: 'smart-router', key: 'mix' } as const, { models: {}, savings: [], cacheRead: 0, cacheInput: 0 })
const liveAtom = atom({ plugin: 'smart-router', key: 'live' } as const, { agents: [], polledAt: 0 })
const logAtom = atom({ plugin: 'smart-router', key: 'log' } as const, [])
const selectedAtom = atom({ plugin: 'smart-router', key: 'selected' } as const, null)
const planAtom = atom({ plugin: 'smart-router', key: 'plan' } as const, null)
const rulesAtom = atom({ plugin: 'smart-router', key: 'rules' } as const, [])
const projectAtom = atom({ plugin: 'smart-router', key: 'project' } as const, EMPTY_PROJECT)
const auditsAtom = atom({ plugin: 'smart-router', key: 'audits' } as const, [])

type Settings = {
  mode: SmartRouterMode
  profile: SmartRouterProfile
  override: 'never' | 'always'
  /** The configuration's tuning: what the Balanced profile runs with. */
  base: Tuning
  useModel: boolean
  useEffort: boolean
  workflowThreshold: number
  prices: PriceTable
  autoOpen: boolean
  writeFiles: boolean
}

/** One subagent this load saw start, by its id. */
type Tracked = { decisionId: string; key: string; category: string; tier: Tier; tierRan: Tier; family: SmartRouterFamily; parentModel: string; didEdit: boolean; description: string; agentType: string; startedAt: number }
type LastRun = Attempt & { prompt: string; finishedAt: number; wasRedo: boolean; category: string }

/** What this load keeps outside `$.state`: nothing here is drawn. */
type Context = {
  agents: Map<string, Tracked>
  /** The last run of each task, by its description. */
  attempts: Map<string, LastRun>
  /** Successes in a row, by kind of task. */
  streaks: Map<string, Streak>
  /** The model check's answers, by task text. */
  verdicts: Map<string, Tier>
  /** Tool calls of the running subagents, published by the poll. */
  tools: Map<string, number>
  /** Agent calls the effort lever set to effort high, by tool_use_id. */
  effortCalls: Map<string, true>
  /** Review agents started from a quality check: agent id → audit id. */
  auditAgents: Map<string, string>
  /** The last agent that changed files and finished, for a test run that fails after it. */
  lastEditor: { category: string; tier: Tier; at: number; isBlamed: boolean } | undefined
  lastTestOk: boolean | undefined
  isRegression: boolean
  pendingSavings: number
  poller: Timer | undefined
  flushTimer: Timer | undefined
  flushed: Flushed
  hasWorkflow: boolean | undefined
  /** Whether mods-hub answered this session's hello: the Router is then a tab of its panel. */
  hasHub: boolean
  /** The newest `test.result` from the hub's bus already counted. */
  lastTestAt: number
}

type Spawn = { verdict: Verdict; decision: RouteDecision; key: string; prompt: string; subagentType: string; isRedo: boolean; redone: LastRun | undefined }
type PaneInput = RenderInput<'Pane'>
/** The elements a drawing uses; `isTab` when it is the hub panel's tab, whose strip owns the digit hotkeys. */
type Common = Pick<ElementTable, 'Box' | 'Text' | 'Button'> & { isTab?: boolean }

const text = (value: unknown, fallback: string): string => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)
const whole = (value: unknown, fallback: number, low: number, high: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(high, Math.max(low, Math.round(value))) : fallback

function settingsOf(options: PluginOptions): Settings {
  return {
    mode: MODES.find(mode => mode === options.mode) ?? 'auto',
    profile: PROFILE_NAMES.find(profile => profile === options.profile) ?? 'balanced',
    override: options.override === 'always' ? 'always' : 'never',
    base: {
      models: { light: text(options.lightModel, DEFAULT_MODELS.light), standard: text(options.standardModel, DEFAULT_MODELS.standard), deep: text(options.deepModel, DEFAULT_MODELS.deep) },
      protectDeep: options.protectDeep !== false,
      maxParallel: whole(options.maxParallel, 5, 1, MAX_PARALLEL_LIMIT),
      budgetBias: typeof options.budgetBias === 'number' && options.budgetBias > 0 ? options.budgetBias : 0,
      opusShare: whole(options.opusShare, 0, 0, 100),
      auditRate: whole(options.auditRate, 10, 0, 100),
    },
    useModel: options.useModel === true,
    useEffort: options.useEffort === true,
    workflowThreshold: whole(options.workflowThreshold, 6, 2, 50),
    prices: pricesWith(typeof options.prices === 'string' ? options.prices : ''),
    autoOpen: options.autoOpen === true,
    writeFiles: options.writeFiles !== false,
  }
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The agent type a spawn names: `subagentType`, or the Agent tool's own `subagent_type` spelling. */
const typeOf = (e: AgentSpawnInput): string => {
  const spelled = (e as unknown as Record<string, unknown>).subagent_type
  return e.subagentType ?? (typeof spelled === 'string' ? spelled : 'general-purpose')
}

const keyOf = (description: string, prompt: string): string => (description.trim() !== '' ? description : prompt.slice(0, 120)).toLowerCase().replace(/\s+/g, ' ').trim()
const promptKey = (prompt: string): string => prompt.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 500)
const newId = (now: number): string => `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const tierOfModel = (model: string, fallback: Tier): Tier => (familyOf(model) === 'other' ? fallback : FAMILY_TIER[familyOf(model)])

function remember<V>(map: Map<string, V>, key: string, value: V, limit: number): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > limit) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
}

// Settings in force: the configuration, then the profile, then the pane's toggles.

async function modeNow($: EngineInterface, settings: Settings): Promise<SmartRouterMode> {
  return (await read($, modeOverride)) ?? settings.mode
}

const profileOf = (tweaks: SmartRouterTweaks, settings: Settings): SmartRouterProfile => tweaks.profile ?? settings.profile

/** The tuning before the pane's on/off toggles: what the toggles show against. */
const presetOf = (tweaks: SmartRouterTweaks, settings: Settings): Tuning => tuningFor(settings.base, profileOf(tweaks, settings))

function tuningOf(tweaks: SmartRouterTweaks, settings: Settings): Tuning {
  const preset = presetOf(tweaks, settings)
  return {
    ...preset,
    protectDeep: tweaks.protectDeep ?? preset.protectDeep,
    maxParallel: tweaks.maxParallel ?? preset.maxParallel,
    budgetBias: tweaks.isBudgetBiasOn === false ? 0 : preset.budgetBias,
  }
}

async function tuningNow($: EngineInterface, settings: Settings): Promise<Tuning> {
  return tuningOf(await read($, tweaksAtom), settings)
}

/** The small model for the classifier check and the planner: the light tier's, or haiku. */
const smallModel = (tuning: Tuning): string => (tuning.models.light === INHERIT ? DEFAULT_MODELS.light : tuning.models.light)

async function showStatus($: EngineInterface, settings: Settings): Promise<void> {
  const mode = await modeNow($, settings)
  $.ui.status(mode === 'off' ? undefined : statusText(await read($, mixAtom), mode === 'suggest'))
}

// Per-project memory: learned rules, outcome learning and the quota's token counts.

async function storeKey($: EngineInterface, prefix: string): Promise<string> {
  return `${prefix}${await $.session.root()}`
}

async function saveRules($: EngineInterface, rules: SmartRouterRule[]): Promise<void> {
  try {
    await $.store.set(await storeKey($, RULES_KEY), rules)
  } catch (error) {
    $.ui.log(`smart-router: could not save the learned rules: ${errorText(error)}`, { to: 'debug' })
  }
}

async function saveProject($: EngineInterface, project: SmartRouterProject): Promise<void> {
  try {
    await $.store.set(await storeKey($, PROJECT_KEY), project)
  } catch (error) {
    $.ui.log(`smart-router: could not save the project's outcomes: ${errorText(error)}`, { to: 'debug' })
  }
}

async function loadMemory($: EngineInterface): Promise<void> {
  try {
    const rules = await $.store.get(await storeKey($, RULES_KEY))
    if (Array.isArray(rules)) await update($, rulesAtom, () => rules as SmartRouterRule[])
    const project = (await $.store.get(await storeKey($, PROJECT_KEY))) as Partial<SmartRouterProject> | undefined
    if (project !== undefined && project !== null && typeof project === 'object') {
      await update($, projectAtom, () => ({ reliability: project.reliability ?? {}, tokens: project.tokens ?? {} }))
    }
  } catch (error) {
    $.ui.log(`smart-router: could not read the project's memory: ${errorText(error)}`, { to: 'debug' })
  }
}

/** One outcome for a kind of task on a tier, kept for this project. */
async function learnOutcome($: EngineInterface, category: string, tier: Tier, isOk: boolean): Promise<void> {
  const now = await $.clock.now()
  await saveProject($, await update($, projectAtom, project => recordOutcome(project, category, tier, isOk, now)))
}

// Routing a spawn

/** Asks the small model about a borderline task, once per task text; the local verdict when it does not answer. */
async function checkWithModel($: EngineInterface, ctx: Context, tuning: Tuning, input: TaskInput, local: Verdict): Promise<Verdict> {
  const cacheKey = `${input.description ?? ''}\n${input.prompt.slice(0, 1_500)}`
  let tier = ctx.verdicts.get(cacheKey)
  if (tier === undefined) {
    try {
      const reply = await $.model.complete({ model: smallModel(tuning), system: CLASSIFIER_SYSTEM, prompt: classifierPrompt(input), maxTokens: 5, timeoutMs: CLASSIFY_TIMEOUT_MS })
      tier = reply.isAnswered ? tierFromReply(reply.text) : undefined
    } catch (error) {
      $.ui.log(`smart-router: the model check failed: ${errorText(error)}`, { to: 'debug' })
    }
    if (tier === undefined) return local
    remember(ctx.verdicts, cacheKey, tier, CACHE_SIZE)
  }
  if (tier === local.tier) return { ...local, isBorderline: false, signals: [...local.signals, 'model check'] }
  return { ...local, tier, tag: 'model check', reason: `rated ${tier} by ${smallModel(tuning)} (the local rules said ${local.tier})`, signals: [...local.signals, 'model check'], isBorderline: false, isDeepCategory: false, isScoped: false }
}

async function planSpawn($: EngineInterface, ctx: Context, settings: Settings, e: AgentSpawnInput): Promise<Spawn> {
  const subagentType = typeOf(e)
  const input: TaskInput = { prompt: e.prompt, description: e.description, subagentType }
  const tuning = await tuningNow($, settings)
  let verdict = classify(input, await read($, rulesAtom))
  if (settings.useModel && verdict.isBorderline) verdict = await checkWithModel($, ctx, tuning, input, verdict)
  const key = keyOf(e.description, e.prompt)
  const prompt = promptKey(e.prompt)
  const now = await $.clock.now()
  const last = ctx.attempts.get(key)
  // A failed run is retried one tier up; so is the same prompt again soon after a success, once.
  const isRedo = last !== undefined && last.outcome === 'ok' && !last.wasRedo && last.prompt === prompt && now - last.finishedAt <= REDO_WINDOW_MS
  const previous = last !== undefined && (last.outcome === 'failed' || isRedo) ? last : undefined
  const project = await read($, projectAtom)
  await readTestResults($, ctx)
  const budgetAlert = await readBudgetAlert($, ctx)
  const route: RouteSettings = { mode: await modeNow($, settings), override: settings.override, models: tuning.models, protectDeep: tuning.protectDeep, budgetBias: tuning.budgetBias, opusShare: tuning.opusShare }
  const decided = decideRoute(
    verdict,
    { subagentType, model: e.model, parentModel: e.parentModel, isFork: e.fork, isWorkflow: e.workflow !== undefined, isTeammate: e.isTeammate === true },
    route,
    {
      previous,
      streak: ctx.streaks.get(verdict.tag),
      spentUsd: (await read($, totalsAtom)).usd,
      isUnreliable: isUnreliable(project, verdict.tag, verdict.tier, now),
      isRegression: ctx.isRegression,
      opusShare: opusShareOf(project.tokens),
      ...(budgetAlert === undefined ? {} : { budgetAlert }),
    },
  )
  const decision = settings.useEffort && ctx.effortCalls.has(e.tool_use_id) ? withEffort(decided, verdict, tuning.models) : decided
  return { verdict, decision, key, prompt, subagentType, isRedo, redone: isRedo ? last : undefined }
}

/** The model a decision leaves the agent on, before core resolves it. */
const intendedModel = (decision: RouteDecision, e: AgentSpawnInput): string =>
  decision.action === 'routed' ? decision.model ?? e.parentModel : decision.action === 'kept' ? decision.model ?? e.model ?? e.parentModel : e.model ?? e.parentModel

async function recordSpawn($: EngineInterface, ctx: Context, settings: Settings, e: AgentSpawnInput, spawn: Spawn, started: AgentSpawnResult): Promise<void> {
  if (started.deny !== undefined) return
  const { verdict, decision } = spawn
  const now = await $.clock.now()
  const ranOn = started.model ?? intendedModel(decision, e)
  const family = familyOf(ranOn)
  const tierRan = tierOfModel(ranOn, decision.tier)
  const id = newId(now)
  const entry: SmartRouterDecision = {
    id,
    at: now,
    agentType: spawn.subagentType,
    description: e.description.trim() || titleOf(e.prompt),
    excerpt: e.prompt.slice(0, EXCERPT_CHARS),
    tier: decision.tier,
    model: decision.action === 'suggested' ? decision.model ?? INHERIT : ranOn,
    action: decision.action,
    tag: decision.tag,
    category: verdict.tag,
    reason: decision.reason,
    signals: verdict.signals,
    mainModel: e.parentModel,
    ...(started.agentId === undefined ? {} : { agentId: started.agentId }),
    ...(decision.tag === 'effort' ? { effort: 'high' as const } : {}),
  }
  await update($, logAtom, list => [entry, ...list].slice(0, LOG_SIZE))
  await update($, mixAtom, mix => {
    const before = mix.models[family] ?? { calls: 0, tokens: 0, usd: 0, baselineUsd: 0 }
    return { ...mix, models: { ...mix.models, [family]: { ...before, calls: before.calls + 1 } } }
  })
  await update($, totalsAtom, totals => ({ ...totals, agents: totals.agents + 1 }))
  if (decision.tag === 'regression↑') ctx.isRegression = false
  // Doing the same task again soon after counts against the run it redoes.
  if (spawn.redone !== undefined) await learnOutcome($, spawn.redone.category, spawn.redone.tier, false)
  const last = ctx.attempts.get(spawn.key)
  remember(ctx.attempts, spawn.key, { tier: tierRan, failures: last?.failures ?? 0, outcome: 'running', prompt: spawn.prompt, finishedAt: 0, wasRedo: spawn.isRedo, category: verdict.tag }, CACHE_SIZE)
  if (started.agentId !== undefined) {
    const agentId = started.agentId
    remember(ctx.agents, agentId, { decisionId: id, key: spawn.key, category: verdict.tag, tier: verdict.tier, tierRan, family, parentModel: e.parentModel, didEdit: false, description: entry.description, agentType: spawn.subagentType, startedAt: now }, TRACKED_AGENTS)
    const audit = AUDIT_MARK.exec(e.prompt)?.[1]
    if (audit !== undefined) remember(ctx.auditAgents, agentId, audit, CACHE_SIZE)
    await update($, liveAtom, live => ({ ...live, agents: [...live.agents.filter(one => one.agentId !== agentId), { agentId, tier: tierRan, family, description: entry.description, startedAt: now, tools: 0 }] }))
  }
  await showStatus($, settings)
  await ensurePolling($, ctx)
  if (ctx.hasHub) {
    await hubPublish($, {
      topic: 'agent.routed',
      data: { agentType: spawn.subagentType, tier: decision.tier, model: entry.model, reason: truncate(decision.reason, EVENT_REASON_CHARS), ...(started.agentId === undefined ? {} : { agentId: started.agentId }) },
    })
  }
}

// Accounting and outcomes

async function finishAudit($: EngineInterface, auditId: string, answer: string): Promise<void> {
  const audit = (await read($, auditsAtom)).find(one => one.id === auditId)
  if (audit === undefined) return
  await update($, auditsAtom, list => list.filter(one => one.id !== auditId))
  const verdict = AUDIT_VERDICT.exec(answer)?.[1]?.toUpperCase()
  if (verdict === undefined) return
  await learnOutcome($, audit.category, audit.tier, verdict === 'PASS')
  const line = `Quality check of “${truncate(audit.description, 40)}”: ${verdict === 'PASS' ? 'pass' : 'issues found'}`
  try {
    await $.mods.notify({ level: verdict === 'PASS' ? 'success' : 'warning', title: line, topic: 'agent.finished' })
  } catch {
    $.ui.toast(line)
  }
}

/** Sometimes offers a quick review, one tier up, of a light or standard agent that changed files. */
async function maybeOfferAudit($: EngineInterface, settings: Settings, tracked: Tracked, agentId: string): Promise<void> {
  const tuning = await tuningNow($, settings)
  if (!tracked.didEdit || tracked.tierRan === 'deep' || Math.random() * 100 >= tuning.auditRate) return
  const reviewer = tuning.models[tierUp(tracked.tierRan)]
  const audit: SmartRouterAudit = { id: newId(await $.clock.now()), agentId, description: tracked.description, category: tracked.category, tier: tracked.tierRan, reviewer, at: await $.clock.now() }
  await update($, auditsAtom, list => [audit, ...list].slice(0, MAX_AUDITS))
}

async function account($: EngineInterface, ctx: Context, settings: Settings, e: TurnCompleteInput): Promise<void> {
  const usage = e.usage
  const costed = usage === undefined ? undefined : costOf(usage, usage.model, settings.prices)
  const cost = costed?.usd ?? 0
  if (e.agentId === undefined) {
    await readTestResults($, ctx)
    const saved = ctx.pendingSavings
    ctx.pendingSavings = 0
    const totals = await update($, totalsAtom, before => ({ ...before, usd: before.usd + cost, mainModel: usage?.model ?? before.mainModel }))
    if (totals.agents > 0) await update($, mixAtom, mix => ({ ...mix, savings: [...mix.savings, saved].slice(-SAVINGS_POINTS) }))
    scheduleFlush($, ctx, settings)
    return
  }
  const tracked = ctx.agents.get(e.agentId)
  if (tracked === undefined) {
    await update($, totalsAtom, before => ({ ...before, usd: before.usd + cost }))
    return
  }
  const agentId = e.agentId
  const now = await $.clock.now()
  const baseline = usage === undefined ? 0 : costOf(usage, tracked.parentModel, settings.prices).usd
  const family = usage === undefined ? tracked.family : familyOf(usage.model)
  const used = usage === undefined ? 0 : freshTokensOf(usage)
  const input = usage === undefined ? 0 : usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  const cacheShare = usage === undefined || input === 0 ? undefined : usage.cache_read_input_tokens / input
  const isOk = e.reason === 'answer' && e.answer.trim() !== ''
  ctx.pendingSavings += baseline - cost
  const totals = await update($, totalsAtom, before => ({ ...before, usd: before.usd + cost, subagentUsd: before.subagentUsd + cost, baselineUsd: before.baselineUsd + baseline }))
  await update($, mixAtom, mix => {
    const before = mix.models[family] ?? { calls: 0, tokens: 0, usd: 0, baselineUsd: 0 }
    return {
      ...mix,
      models: { ...mix.models, [family]: { ...before, tokens: before.tokens + used, usd: before.usd + cost, baselineUsd: before.baselineUsd + baseline } },
      cacheRead: mix.cacheRead + (usage?.cache_read_input_tokens ?? 0),
      cacheInput: mix.cacheInput + input,
    }
  })
  await update($, logAtom, list =>
    list.map(entry =>
      entry.id === tracked.decisionId
        ? { ...entry, usd: (entry.usd ?? 0) + cost, baselineUsd: (entry.baselineUsd ?? 0) + baseline, outcome: isOk ? 'ok' : 'failed', ...(cacheShare === undefined ? {} : { cacheShare }) }
        : entry,
    ),
  )
  await update($, liveAtom, live => ({ ...live, agents: live.agents.filter(one => one.agentId !== agentId) }))
  ctx.tools.delete(agentId)
  const project = await update($, projectAtom, before =>
    recordOutcome({ ...before, tokens: { ...before.tokens, [family]: (before.tokens[family] ?? 0) + used } }, tracked.category, tracked.tierRan, isOk, now),
  )
  await saveProject($, project)
  const attempt = ctx.attempts.get(tracked.key)
  if (attempt !== undefined) {
    remember(ctx.attempts, tracked.key, { ...attempt, outcome: isOk ? 'ok' : 'failed', failures: isOk ? 0 : attempt.failures + 1, finishedAt: now }, CACHE_SIZE)
  }
  const streak = ctx.streaks.get(tracked.category)
  if (!isOk) ctx.streaks.delete(tracked.category)
  else remember(ctx.streaks, tracked.category, streak?.tier === tracked.tier ? { tier: tracked.tier, successes: streak.successes + 1 } : { tier: tracked.tier, successes: 1 }, CACHE_SIZE)
  if (isOk && tracked.didEdit) ctx.lastEditor = { category: tracked.category, tier: tracked.tierRan, at: now, isBlamed: false }
  if (ctx.hasHub) {
    await hubPublish($, { topic: 'agent.finished', data: { agentType: tracked.agentType, outcome: isOk ? 'ok' : 'failed', durationMs: now - tracked.startedAt, agentId, usd: cost } })
    if (usage !== undefined && costed !== undefined) {
      await hubPublish($, { topic: 'cost.update', data: { turnUsd: cost, sessionUsd: totals.usd, model: usage.model, tokens: costed.tokens, isEstimate: !costed.isKnownModel } })
    }
  }
  const auditId = ctx.auditAgents.get(agentId)
  if (auditId !== undefined) await finishAudit($, auditId, e.answer)
  else if (isOk) await maybeOfferAudit($, settings, tracked, agentId)
  scheduleFlush($, ctx, settings)
}

/** A test run: a failure soon after an agent's edits counts against it, and a pass-then-fail is a regression. */
async function noteTests($: EngineInterface, ctx: Context, hasPassed: boolean): Promise<void> {
  if (hasPassed) {
    ctx.lastTestOk = true
    ctx.isRegression = false
    return
  }
  if (ctx.lastTestOk === true) ctx.isRegression = true
  ctx.lastTestOk = false
  const editor = ctx.lastEditor
  if (editor !== undefined && !editor.isBlamed && (await $.clock.now()) - editor.at <= BLAME_WINDOW_MS) {
    editor.isBlamed = true
    await learnOutcome($, editor.category, editor.tier, false)
  }
}

// mods-hub: what other mods publish that routing uses, and what the Router shares

/** Test runs other mods published (test-watch's own runs); the hub's sensor mirrors the Bash runs counted above. */
async function readTestResults($: EngineInterface, ctx: Context): Promise<void> {
  if (!ctx.hasHub) return
  try {
    const events = (await $.mods.recent({ topic: 'test.result', since: ctx.lastTestAt })).filter(event => event.source !== 'mods-hub' && event.source !== 'smart-router')
    for (const event of events) {
      ctx.lastTestAt = Math.max(ctx.lastTestAt, event.at)
      const outcome = (event.data as { outcome?: unknown } | null)?.outcome
      if (outcome === 'passed' || outcome === 'failed') await noteTests($, ctx, outcome === 'passed')
    }
  } catch {
    // The hub went away: Bash test runs still count.
  }
}

/** The latest budget alert on the hub's bus (token-budget, daily-spend), in words, when it is at the alert line. */
async function readBudgetAlert($: EngineInterface, ctx: Context): Promise<string | undefined> {
  if (!ctx.hasHub) return undefined
  try {
    return budgetAlertOf((await $.mods.latest({ topic: 'budget.threshold' }))?.data)
  } catch {
    return undefined
  }
}

/** The fact `smart-router.policy` other mods read (subagent-cap, model-advisor, workflow-studio). */
async function sharePolicy($: EngineInterface, ctx: Context, settings: Settings): Promise<void> {
  if (!ctx.hasHub) return
  const tweaks = await read($, tweaksAtom)
  const tuning = tuningOf(tweaks, settings)
  try {
    await $.mods.share({
      name: 'policy',
      value: {
        mode: await modeNow($, settings),
        profile: profileOf(tweaks, settings),
        models: { ...tuning.models },
        maxParallel: tuning.maxParallel,
        protectDeep: tuning.protectDeep,
        budgetBias: tuning.budgetBias,
        opusShare: tuning.opusShare,
      },
    })
  } catch {
    // Not shared this time; the next change tries again.
  }
}

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** With mods-hub installed: hello, the Router tab in its panel, and the routing policy on its blackboard. */
async function greetHub($: EngineInterface, ctx: Context, settings: Settings): Promise<void> {
  ctx.hasHub = (await hubMode($)) !== undefined
  if (!ctx.hasHub) return
  ctx.lastTestAt = await $.clock.now()
  await hubHello(
    $,
    { version: await ownVersion($), publishes: ['agent.routed', 'agent.finished', 'cost.update'], consumes: ['budget.threshold', 'test.result'] },
    TAB,
  )
  await sharePolicy($, ctx, settings)
}

// The summary files other mods read

function scheduleFlush($: EngineInterface, ctx: Context, settings: Settings): void {
  if (!settings.writeFiles || ctx.flushTimer !== undefined) return
  ctx.flushTimer = $.clock.after(FLUSH_MS, () => {
    ctx.flushTimer = undefined
    void flushFiles($, ctx, settings)
  })
}

/** Writes daily.json (today's totals across sessions) and stats.json (this session) under ~/.claude/claude-mods/smart-router. */
async function flushFiles($: EngineInterface, ctx: Context, settings: Settings): Promise<void> {
  try {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
    if (home === undefined || home === '') return
    const folder = `${home.replace(/[\\/]+$/, '')}/${FILES_DIR}`
    const now = await $.clock.now()
    const totals = await read($, totalsAtom)
    const mix = await read($, mixAtom)
    const project = await read($, projectAtom)
    const figures = sessionFigures(mix, totals.baselineUsd - totals.subagentUsd, totals.usd)
    const previous = await $.fs.read(`${folder}/daily.json`).then(raw => JSON.parse(raw) as unknown, () => undefined)
    const daily = mergeDaily(previous, dateOf(now), figures, ctx.flushed)
    await $.fs.write(`${folder}/daily.json`, `${JSON.stringify(daily, null, 2)}\n`)
    ctx.flushed = figures
    const tweaks = await read($, tweaksAtom)
    const stats = {
      version: 1,
      updatedAt: new Date(now).toISOString(),
      project: await $.session.root(),
      mode: await modeNow($, settings),
      profile: profileOf(tweaks, settings),
      mainModel: totals.mainModel,
      agents: totals.agents,
      spent: totals.usd,
      subagentSpent: totals.subagentUsd,
      saved: figures.saved,
      byModel: figures.byModel,
      cacheReuse: mix.cacheInput > 0 ? mix.cacheRead / mix.cacheInput : null,
      opusShare: opusShareOf(project.tokens),
      weakSpots: weakSpots(project, now),
    }
    await $.fs.write(`${folder}/stats.json`, `${JSON.stringify(stats, null, 2)}\n`)
  } catch (error) {
    $.ui.log(`smart-router: could not write the summary files: ${errorText(error)}`, { to: 'debug' })
  }
}

// The pane: opening, the live poll, the presses

/** The Router tab of the hub's panel when the hub is installed, this mod's own pane otherwise. */
async function openPane($: EngineInterface, ctx: Context): Promise<boolean> {
  const isPlaced = ctx.hasHub
    ? await hubShowTab($, TAB.id)
    : (await $.ui.open({ id: PANE, title: PANE_TITLE, columns: PANE_COLUMNS }).catch(() => undefined))?.isPlaced === true
  if (isPlaced) await ensurePolling($, ctx)
  return isPlaced
}

/** Whether the Router is on screen: its own pane, or the hub's panel open on the Router tab. */
async function isRouterOpen($: EngineInterface): Promise<boolean> {
  const panes = await $.ui.panes().catch(() => [])
  return panes.some(pane => pane.id === PANE) || (panes.some(pane => pane.id === HUB_PANE) && (await hubTabIs($, TAB.id)))
}

/** Polls the running subagents every 2 s, only while the pane is open. */
async function ensurePolling($: EngineInterface, ctx: Context): Promise<void> {
  if (ctx.poller !== undefined) return
  if (await isRouterOpen($)) ctx.poller = $.clock.every(POLL_MS, () => void pollLive($, ctx))
}

async function pollLive($: EngineInterface, ctx: Context): Promise<void> {
  try {
    if (!(await isRouterOpen($))) {
      ctx.poller?.cancel()
      ctx.poller = undefined
      return
    }
    if ((await read($, liveAtom)).agents.length === 0) return
    const listed = await $.agent.list().catch(() => [])
    const finished = new Set(listed.filter(agent => FINISHED.has(agent.status)).map(agent => agent.id))
    const now = await $.clock.now()
    await update($, liveAtom, live => ({
      agents: live.agents.filter(agent => !finished.has(agent.agentId)).map(agent => ({ ...agent, tools: ctx.tools.get(agent.agentId) ?? agent.tools })),
      polledAt: now,
    }))
  } catch (error) {
    $.ui.log(`smart-router: the live poll failed: ${errorText(error)}`, { to: 'debug' })
  }
}

async function setMode($: EngineInterface, ctx: Context, settings: Settings, mode: SmartRouterMode): Promise<void> {
  await update($, modeOverride, () => mode)
  await showStatus($, settings)
  await ensurePolling($, ctx)
  await sharePolicy($, ctx, settings)
}

/** A profile chip: its presets replace the pane's toggles. */
async function setProfile($: EngineInterface, ctx: Context, settings: Settings, profile: SmartRouterProfile): Promise<void> {
  await update($, tweaksAtom, () => ({ profile }))
  await ensurePolling($, ctx)
  await sharePolicy($, ctx, settings)
}

async function toggleSection($: EngineInterface, ctx: Context, section: SmartRouterSection): Promise<void> {
  await update($, collapsedAtom, folded => ({ ...folded, [section]: folded[section] !== true }))
  await ensurePolling($, ctx)
}

async function changeTweaks($: EngineInterface, ctx: Context, settings: Settings, change: (tweaks: SmartRouterTweaks) => SmartRouterTweaks): Promise<void> {
  await update($, tweaksAtom, change)
  await sharePolicy($, ctx, settings)
}

async function copyText($: EngineInterface, value: string, surface: RenderSurface, done: string): Promise<void> {
  const copied = await $.ui.copy({ text: value, surface })
  $.ui.toast(copied.isCopied ? done : `Could not copy (${copied.reason})`)
}

/** "Should be <tier>": learns a rule from the task's keywords for this project; a tier too low also counts as a failure. */
async function correct($: EngineInterface, decision: SmartRouterDecision, tier: Tier): Promise<void> {
  const keywords = keywordsOf(decision.description, decision.excerpt)
  if (keywords.length === 0) {
    $.ui.toast('No keywords to learn from in this task')
    return
  }
  const now = await $.clock.now()
  const rule: SmartRouterRule = { id: newId(now), keywords, tier, example: truncate(decision.description, 80), createdAt: now }
  const same = keywords.join(' ')
  const rules = await update($, rulesAtom, list => [rule, ...list.filter(one => one.keywords.join(' ') !== same)].slice(0, MAX_RULES))
  await update($, logAtom, list => list.map(entry => (entry.id === decision.id ? { ...entry, correctedTo: tier } : entry)))
  await saveRules($, rules)
  const ran = tierOfModel(decision.model, decision.tier)
  if (decision.action !== 'suggested' && tierRank(tier) > tierRank(ran)) await learnOutcome($, decision.category, ran, false)
  $.ui.toast(`Learned: ${keywords.join(' + ')} → ${tier}`)
}

async function deleteRule($: EngineInterface, id: string): Promise<void> {
  await saveRules($, await update($, rulesAtom, list => list.filter(rule => rule.id !== id)))
}

async function forgetOutcomes($: EngineInterface): Promise<void> {
  await saveProject($, await update($, projectAtom, project => ({ ...project, reliability: {} })))
}

async function resetStats($: EngineInterface, ctx: Context, settings: Settings): Promise<void> {
  ctx.pendingSavings = 0
  await update($, totalsAtom, totals => ({ ...NO_TOTALS, mainModel: totals.mainModel }))
  await update($, mixAtom, () => ({ models: {}, savings: [], cacheRead: 0, cacheInput: 0 }))
  await update($, logAtom, () => [])
  await update($, selectedAtom, () => null)
  ctx.flushed = NOTHING_FLUSHED
  await showStatus($, settings)
}

async function submitPlan($: EngineInterface, settings: Settings, plan: SmartRouterPlan, asWorkflow: boolean): Promise<void> {
  const tuning = await tuningNow($, settings)
  const prompt = asWorkflow ? workflowPrompt(plan, tuning.models) : runPrompt(plan, tuning.models)
  await $.prompt.submit({ text: prompt, asUser: true })
  $.ui.toast(asWorkflow ? 'Sent: run as a workflow' : 'Sent to Claude')
}

/** A quality check: asks Claude for one review agent, one tier up, that ends with AUDIT: PASS or AUDIT: FAIL. */
async function runAudit($: EngineInterface, audit: SmartRouterAudit): Promise<void> {
  const text = [
    `Quick quality check (sampled by smart-router): start one subagent with model: ${audit.reviewer} and description "Audit: ${truncate(audit.description, 50)}".`,
    `Its task: review the changes the subagent "${audit.description}" just made (git diff of the files it touched) for bugs, missed requirements and broken tests. Read only; do not change files.`,
    'It must end its answer with one line: AUDIT: PASS, or AUDIT: FAIL followed by the issues. Then tell me briefly what it found.',
    `[smart-router audit ${audit.id}]`,
  ].join('\n')
  await $.prompt.submit({ text, asUser: true })
}

async function dismissAudit($: EngineInterface, id: string): Promise<void> {
  await update($, auditsAtom, list => list.filter(one => one.id !== id))
}

/** Switches the main model, only when the person presses for it: `/model <alias>`, or typed for them to send. */
async function switchMain($: EngineInterface, alias: string): Promise<void> {
  try {
    await $.command.run({ command: 'model', args: alias })
  } catch {
    const filled = await $.prompt.fill({ text: `/model ${alias}` })
    if (!filled.isFilled) $.ui.toast(`Type /model ${alias} to switch`)
  }
}

// /route

async function draftPlan($: EngineInterface, ctx: Context, settings: Settings, task: string): Promise<SmartRouterPlan> {
  const rules = await read($, rulesAtom)
  const tuning = await tuningNow($, settings)
  const mainModel = await $.session.model().catch(() => '')
  const resolveTier: TierResolver = (title, prompt, proposed) => matchRule(`${title}\n${prompt}`, rules)?.tier ?? proposed ?? classify({ prompt, description: title }).tier
  let subtasks: SmartRouterSubtask[] | undefined
  try {
    const reply = await $.model.complete({ model: smallModel(tuning), system: PLANNER_SYSTEM, prompt: plannerPrompt(task), maxTokens: PLAN_MAX_TOKENS, timeoutMs: PLAN_TIMEOUT_MS })
    subtasks = reply.isAnswered ? parseSubtasks(reply.text, resolveTier) : undefined
  } catch (error) {
    $.ui.log(`smart-router: the planner failed: ${errorText(error)}`, { to: 'debug' })
  }
  const oneStep: SmartRouterSubtask = { title: titleOf(task), tier: classify({ prompt: task }, rules).tier, prompt: task, dependsOn: [], writes: [] }
  const plan = buildPlan(task, subtasks ?? [oneStep], {
    workflowThreshold: settings.workflowThreshold,
    maxParallel: tuning.maxParallel,
    models: tuning.models,
    mainModel,
    isFallback: subtasks === undefined,
    now: await $.clock.now(),
    prices: settings.prices,
  })
  return ctx.hasWorkflow === false && plan.isWorkflowEligible ? { ...plan, notes: [...plan.notes, 'The Workflow tool is not available in this session.'] } : plan
}

const routeSummary = (plan: SmartRouterPlan): string =>
  `Plan: ${plan.subtasks.length} subtask${plan.subtasks.length === 1 ? '' : 's'} in ${plan.stages.length} stage${plan.stages.length === 1 ? '' : 's'} · ${MODE_WORDS[plan.mode]}. ${plan.reason} The Router pane has the buttons to run it.`

// Drawing

const shortModel = (model: string): string => (model === INHERIT ? 'main' : familyOf(model) === 'other' ? truncate(model, 10) : familyOf(model))
const percent = (share: number): string => `${Math.round(share * 100)}%`

function sectionHeader($: EngineInterface, ctx: Context, el: Common, section: (typeof SECTIONS)[number], isOpen: boolean, suffix: string): RenderElement {
  const { Button } = el
  return (
    <Button
      key={`section-${section.id}`}
      plain
      {...(el.isTab === true ? {} : { hotkey: section.hotkey })}
      label={`${isOpen ? '▾' : '▸'} ${section.title}${isOpen && suffix !== '' ? ` · ${suffix}` : ''}`}
      onPress={() => void toggleSection($, ctx, section.id)}
    />
  )
}

/** A stacked bar: a Raster on the terminal, colored blocks elsewhere. */
function barOf($: EngineInterface, e: PaneInput, key: string, segments: readonly Segment[]): RenderElement {
  if (e.surface === 'terminal') {
    const { Raster } = $.ui.resolve(e)
    const cells = barCells(segments)
    return <Raster key={key} columns={cells.length} rows={1} cells={packCells(cells)} />
  }
  const { Box, Text } = $.ui.resolve(e)
  return (
    <Box key={key} flexDirection="row">
      {segments.map(segment => (
        <Text color={familyColor(segment.family)}>{'█'.repeat(segment.cells)}</Text>
      ))}
    </Box>
  )
}

function sparkOf($: EngineInterface, e: PaneInput, values: readonly number[]): RenderElement {
  if (e.surface === 'terminal') {
    const { Raster } = $.ui.resolve(e)
    return <Raster key="savings-spark" columns={values.length} rows={1} cells={packCells(sparkCells(values))} />
  }
  const { Box, Text } = $.ui.resolve(e)
  return (
    <Box key="savings-spark">
      <Text color="success">{sparkText(values)}</Text>
    </Box>
  )
}

async function drawHeader($: EngineInterface, ctx: Context, el: Common, settings: Settings): Promise<RenderElement> {
  const { Box, Button, Text } = el
  const mode = await modeNow($, settings)
  const profile = profileOf(await read($, tweaksAtom), settings)
  const totals = await read($, totalsAtom)
  const saved = savingsLine(totals)
  return (
    <Box key="header" flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Text bold color="claude">
          ⇄ Router
        </Text>
        {MODES.map(one => (
          <Button
            key={`mode-${one}`}
            hotkey={one.charAt(0)}
            label={MODE_LABEL[one]}
            {...(one === mode ? { variant: 'primary' as const } : {})}
            onPress={() => void setMode($, ctx, settings, one)}
          />
        ))}
      </Box>
      <Box key="profiles" flexDirection="row" flexWrap="wrap" columnGap={1}>
        {PROFILE_NAMES.map(one => (
          <Button
            key={`profile-${one}`}
            plain
            hotkey={PROFILE_HOTKEY[one]}
            dimColor={one !== profile}
            label={`${one === profile ? '●' : '○'} ${PROFILE_LABEL[one]}`}
            onPress={() => void setProfile($, ctx, settings, one)}
          />
        ))}
      </Box>
      <Box key="savings">
        <Text bold color={saved.color}>
          {saved.text}
        </Text>
      </Box>
      <Box key="spent">
        <Text dimColor wrap="truncate-end">
          {`spent ${money(totals.subagentUsd)} · ${totals.agents} agent${totals.agents === 1 ? '' : 's'} · session ${money(totals.usd)}`}
        </Text>
      </Box>
      <Text dimColor wrap="truncate-end">
        {`main ${totals.mainModel === '' ? '?' : shortModel(totals.mainModel)} · ${mode === 'auto' ? 'routing on' : mode === 'suggest' ? 'suggestions only' : 'routing off'}`}
      </Text>
    </Box>
  )
}

async function drawLive($: EngineInterface, ctx: Context, el: Common, isOpen: boolean): Promise<RenderElement> {
  const { Box, Button, Text } = el
  const section = SECTIONS[0] as (typeof SECTIONS)[number]
  if (!isOpen) return <Box key="live">{sectionHeader($, ctx, el, section, false, '')}</Box>
  const { agents } = await read($, liveAtom)
  const audits = await read($, auditsAtom)
  const now = await $.clock.now()
  return (
    <Box key="live" flexDirection="column">
      {sectionHeader($, ctx, el, section, true, agents.length === 0 ? 'idle' : `${agents.length} running`)}
      {agents.length === 0 ? (
        <Text dimColor>  Idle</Text>
      ) : (
        agents.map(agent => (
          <Box key={`live-${agent.agentId}`} flexDirection="column" paddingLeft={2}>
            <Box flexDirection="row" gap={1}>
              <Text color={familyColor(agent.family)}>{familyGlyph(agent.family)}</Text>
              <Text>{agent.family}</Text>
              <Text wrap="truncate-end">{agent.description}</Text>
            </Box>
            <Text dimColor>{`  ${elapsed(now - agent.startedAt)} · ${agent.tools} tool call${agent.tools === 1 ? '' : 's'}`}</Text>
          </Box>
        ))
      )}
      {audits.map((audit, at) => (
        <Box key={`audit-${audit.id}`} flexDirection="column" paddingLeft={2}>
          <Text color="warning" wrap="truncate-end">{`? check “${audit.description}” (${audit.tier})`}</Text>
          <Box flexDirection="row" columnGap={1}>
            <Button key={`audit-run-${audit.id}`} {...(at === 0 ? { hotkey: 'u' } : {})} label={`Review with ${shortModel(audit.reviewer)}`} onPress={() => void runAudit($, audit)} />
            <Button key={`audit-skip-${audit.id}`} plain dimColor label="Skip" onPress={() => void dismissAudit($, audit.id)} />
          </Box>
        </Box>
      ))}
    </Box>
  )
}

async function drawMix($: EngineInterface, ctx: Context, e: PaneInput, el: Common, settings: Settings, isOpen: boolean, columns: number): Promise<RenderElement> {
  const { Box, Text } = el
  const section = SECTIONS[1] as (typeof SECTIONS)[number]
  if (!isOpen) return <Box key="mix">{sectionHeader($, ctx, el, section, false, '')}</Box>
  const mix = await read($, mixAtom)
  const project = await read($, projectAtom)
  const tuning = await tuningNow($, settings)
  const calls = callsOf(mix)
  const totalCalls = calls.reduce((sum, [, count]) => sum + count, 0)
  const width = Math.max(8, Math.min(32, columns - 16))
  const used = FAMILIES.filter(family => (mix.models[family]?.calls ?? 0) > 0 || (mix.models[family]?.tokens ?? 0) > 0)
  const totalTokens = tokensByFamily(mix).reduce((sum, [, count]) => sum + count, 0)
  const share = opusShareOf(project.tokens)
  const isOverQuota = tuning.opusShare > 0 && share * 100 >= tuning.opusShare
  const gauge = Math.round(share * 10)
  return (
    <Box key="mix" flexDirection="column">
      {sectionHeader($, ctx, el, section, true, `${totalCalls} call${totalCalls === 1 ? '' : 's'}`)}
      {totalCalls === 0 ? (
        <Text dimColor>  No subagents yet.</Text>
      ) : (
        <Box flexDirection="column" paddingLeft={2}>
          <Box flexDirection="row" gap={1}>
            <Text dimColor>calls </Text>
            {barOf($, e, 'calls-bar', segmentsOf(calls, width))}
            <Text dimColor>{String(totalCalls)}</Text>
          </Box>
          {totalTokens > 0 && (
            <Box flexDirection="row" gap={1}>
              <Text dimColor>tokens</Text>
              {barOf($, e, 'tokens-bar', segmentsOf(tokensByFamily(mix), width))}
              <Text dimColor>{tokens(totalTokens)}</Text>
            </Box>
          )}
          {used.map(family => {
            const stats = mix.models[family] ?? { calls: 0, tokens: 0, usd: 0, baselineUsd: 0 }
            return (
              <Box key={`family-${family}`} flexDirection="row" gap={1}>
                <Text color={familyColor(family)}>{familyGlyph(family)}</Text>
                <Text wrap="truncate-end">{`${family} ${stats.calls} · ${tokens(stats.tokens)} tok · ${money(stats.usd)}`}</Text>
              </Box>
            )
          })}
          <Box flexDirection="row" gap={1}>
            <Text dimColor>saved/turn</Text>
            {mix.savings.length === 0 ? <Text dimColor>no turns yet</Text> : sparkOf($, e, mix.savings.slice(-Math.max(4, Math.min(SAVINGS_POINTS, columns - 14))))}
          </Box>
          {mix.cacheInput > 0 && (
            <Box key="cache-reuse">
              <Text dimColor>{`cache reuse ${percent(mix.cacheRead / mix.cacheInput)} of subagent input`}</Text>
            </Box>
          )}
        </Box>
      )}
      <Box key="quota" flexDirection="row" gap={1} paddingLeft={2}>
        <Text dimColor>opus share</Text>
        <Text color={isOverQuota ? 'warning' : 'claude'}>{`${'▰'.repeat(gauge)}${'▱'.repeat(10 - gauge)}`}</Text>
        <Text dimColor={!isOverQuota} color={isOverQuota ? 'warning' : undefined}>{`${percent(share)}${tuning.opusShare > 0 ? ` / ${tuning.opusShare}% max` : ' · no quota'}`}</Text>
      </Box>
    </Box>
  )
}

function drawDetail($: EngineInterface, el: Common, decision: SmartRouterDecision): RenderElement {
  const { Box, Button, Text } = el
  const cost =
    decision.usd === undefined
      ? 'cost: known when it finishes'
      : `cost ${money(decision.usd)} · on the main model (${shortModel(decision.mainModel)}) ≈ ${money(decision.baselineUsd ?? 0)}${decision.cacheShare === undefined ? '' : ` · cache ${percent(decision.cacheShare)}`}`
  const verb = decision.action === 'routed' ? 'routed' : decision.action === 'suggested' ? 'suggested' : 'kept'
  return (
    <Box key={`detail-${decision.id}`} flexDirection="column" paddingLeft={2}>
      <Text dimColor wrap="wrap">{`“${truncate(decision.excerpt, EXCERPT_SHOWN)}”`}</Text>
      <Text wrap="wrap">{`${verb}: ${decision.tier} → ${shortModel(decision.model)}${decision.effort === undefined ? '' : ' (effort high)'} · ${decision.agentType}${decision.outcome === undefined ? '' : ` · ${decision.outcome}`}`}</Text>
      <Text dimColor wrap="wrap">{decision.reason}</Text>
      {decision.signals.length > 0 && <Text dimColor wrap="wrap">{`signals: ${decision.signals.join(' · ')}`}</Text>}
      <Text dimColor wrap="wrap">{cost}</Text>
      {decision.correctedTo !== undefined && <Text color="success">{`corrected → ${decision.correctedTo} (a learned rule)`}</Text>}
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {TIERS.map(tier => (
          <Button key={`fix-${tier}`} hotkey={FIX_HOTKEY[tier]} label={`Should be ${tier}`} dimColor={tier === decision.tier} onPress={() => void correct($, decision, tier)} />
        ))}
        <Button key="copy-prompt" hotkey="y" label="Copy prompt" onPress={press => void copyText($, decision.excerpt, press.surface, 'Prompt copied')} />
        <Button key="detail-close" label="Close" onPress={() => void update($, selectedAtom, () => null)} />
      </Box>
    </Box>
  )
}

async function drawLog($: EngineInterface, ctx: Context, el: Common, isOpen: boolean, columns: number): Promise<RenderElement> {
  const { Box, Button, Text } = el
  const section = SECTIONS[2] as (typeof SECTIONS)[number]
  if (!isOpen) return <Box key="log">{sectionHeader($, ctx, el, section, false, '')}</Box>
  const log = await read($, logAtom)
  const selected = await read($, selectedAtom)
  return (
    <Box key="log" flexDirection="column">
      {sectionHeader($, ctx, el, section, true, `${log.length}`)}
      {log.length === 0 && <Text dimColor>  No routing decisions yet.</Text>}
      {log.map(decision => (
        <Box key={`decision-${decision.id}`} flexDirection="column">
          <Box flexDirection="row" gap={1} paddingLeft={2}>
            <Text color={TIER_COLOR[decision.tier]}>{TIER_GLYPH[decision.tier]}</Text>
            <Text dimColor={decision.action !== 'routed'}>{shortModel(decision.model).padEnd(6)}</Text>
            <Button
              key={`pick-${decision.id}`}
              plain
              dimColor={decision.id !== selected}
              label={truncate(decision.description, Math.max(8, columns - 14 - decision.tag.length))}
              onPress={() => void update($, selectedAtom, current => (current === decision.id ? null : decision.id))}
            />
            <Text dimColor>{decision.tag}</Text>
          </Box>
          {decision.id === selected && drawDetail($, el, decision)}
        </Box>
      ))}
    </Box>
  )
}

/** The main-model switch a plan offers: only for work done here (inline) whose tier's model differs from the main one. */
const mainSwitchFor = (plan: SmartRouterPlan, tuning: Tuning): string | undefined => {
  const wanted = tuning.models[plan.tier]
  if (plan.mode !== 'inline' || wanted === INHERIT || plan.mainModel === '') return undefined
  return familyOf(wanted) === familyOf(plan.mainModel) ? undefined : wanted
}

async function drawPlan($: EngineInterface, ctx: Context, el: Common, settings: Settings, isOpen: boolean, columns: number): Promise<RenderElement> {
  const { Box, Button, Text } = el
  const section = SECTIONS[3] as (typeof SECTIONS)[number]
  if (!isOpen) return <Box key="plan">{sectionHeader($, ctx, el, section, false, '')}</Box>
  const plan = await read($, planAtom)
  if (plan === null) {
    return (
      <Box key="plan" flexDirection="column">
        {sectionHeader($, ctx, el, section, true, '')}
        <Text dimColor>  No plan yet: /route &lt;task&gt; drafts one.</Text>
      </Box>
    )
  }
  const tuning = await tuningNow($, settings)
  const isWide = columns >= WIDE_COLUMNS
  const switchTo = mainSwitchFor(plan, tuning)
  const { forecast } = plan
  const runCost = plan.mode === 'inline' ? forecast.inline : forecast.parallel
  return (
    <Box key="plan" flexDirection="column">
      {sectionHeader($, ctx, el, section, true, `${plan.subtasks.length} subtask${plan.subtasks.length === 1 ? '' : 's'}`)}
      <Box flexDirection="column" paddingLeft={2}>
        <Text bold wrap="wrap">
          {truncate(plan.task, 200)}
        </Text>
        <Box key="plan-mode">
          <Text color={plan.mode === 'workflow' ? 'warning' : 'suggestion'} wrap="wrap">{`${MODE_WORDS[plan.mode]}: ${plan.reason}`}</Text>
        </Box>
        <Box key="plan-stages" flexDirection={isWide ? 'row' : 'column'} gap={isWide ? 2 : 0}>
          {plan.stages.map((stage, at) => (
            <Box key={`stage-${at}`} flexDirection="column">
              <Text dimColor>{`Stage ${at + 1}${stage.length > 1 ? ` · ${stage.length} in parallel` : ''}${at > 0 ? ' · then' : ''}`}</Text>
              {stage.map(index => {
                const subtask = plan.subtasks[index]
                if (subtask === undefined) return null
                return (
                  <Box key={`task-${index}`} flexDirection="column">
                    <Box flexDirection="row" gap={1}>
                      <Text color={TIER_COLOR[subtask.tier]}>{TIER_GLYPH[subtask.tier]}</Text>
                      <Text wrap="truncate-end">{`${index + 1}. ${subtask.title}`}</Text>
                      <Text dimColor>{shortModel(tuning.models[subtask.tier])}</Text>
                    </Box>
                    {subtask.writes.length > 0 && <Text dimColor wrap="truncate-end">{`   writes ${subtask.writes.join(', ')}`}</Text>}
                  </Box>
                )
              })}
            </Box>
          ))}
        </Box>
        {plan.notes.map(note => (
          <Text dimColor wrap="wrap">{note}</Text>
        ))}
        <Box key="plan-forecast">
          <Text dimColor wrap="wrap">{`≈ inline ${money(forecast.inline.usd)} · subagents ${money(forecast.parallel.usd)} · workflow ${money(forecast.workflow.usd)} (${tokens(forecast.parallel.tokens)} tokens as subagents)`}</Text>
        </Box>
        <Box key="plan-buttons" flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Button
            key="plan-run"
            hotkey="p"
            label={`${RUN_LABEL[plan.mode]} · ~${money(runCost.usd)}`}
            {...(plan.mode === 'workflow' ? {} : { variant: 'primary' as const })}
            onPress={() => void submitPlan($, settings, plan, false)}
          />
          {plan.isWorkflowEligible && (
            <Button
              key="plan-workflow"
              hotkey="w"
              label={`Run as workflow · ~${money(forecast.workflow.usd)}`}
              {...(plan.mode === 'workflow' ? { variant: 'primary' as const } : {})}
              onPress={() => void submitPlan($, settings, plan, true)}
            />
          )}
          <Button key="plan-copy" hotkey="c" label="Copy plan" onPress={press => void copyText($, planText(plan, tuning.models), press.surface, 'Plan copied')} />
          <Button key="plan-discard" hotkey="x" label="Discard" onPress={() => void update($, planAtom, () => null)} />
          {switchTo !== undefined && <Button key="plan-main" label={`Main → ${switchTo}`} onPress={() => void switchMain($, switchTo)} />}
        </Box>
        {!plan.isWorkflowEligible && plan.subtasks.length > 1 && (
          <Box key="plan-workflow-off">
            <Text dimColor wrap="wrap">{`Workflow: for ${settings.workflowThreshold}+ subtasks or a multi-stage pipeline.`}</Text>
          </Box>
        )}
      </Box>
    </Box>
  )
}

async function drawRules($: EngineInterface, ctx: Context, el: Common, settings: Settings, isOpen: boolean): Promise<RenderElement> {
  const { Box, Button, Text } = el
  const section = SECTIONS[4] as (typeof SECTIONS)[number]
  if (!isOpen) return <Box key="rules">{sectionHeader($, ctx, el, section, false, '')}</Box>
  const tweaks = await read($, tweaksAtom)
  const rules = await read($, rulesAtom)
  const project = await read($, projectAtom)
  const preset = presetOf(tweaks, settings)
  const tuning = tuningOf(tweaks, settings)
  const isBiasOn = tweaks.isBudgetBiasOn !== false
  const spots = weakSpots(project, await $.clock.now())
  return (
    <Box key="rules" flexDirection="column">
      {sectionHeader($, ctx, el, section, true, `${rules.length} learned`)}
      <Box flexDirection="column" paddingLeft={2}>
        <Text dimColor wrap="wrap">{`${PROFILE_LABEL[profileOf(tweaks, settings)]}: ${tuning.models.light} / ${tuning.models.standard} / ${tuning.models.deep} · audits ${tuning.auditRate}% · effort lever ${settings.useEffort ? 'on' : 'off'}`}</Text>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Button key="toggle-protect" hotkey="g" label={`Protect deep: ${tuning.protectDeep ? 'on' : 'off'}`} onPress={() => void changeTweaks($, ctx, settings, now => ({ ...now, protectDeep: !tuning.protectDeep }))} />
          {preset.budgetBias > 0 ? (
            <Button key="toggle-budget" hotkey="b" label={`Budget bias ${money(preset.budgetBias)}: ${isBiasOn ? 'on' : 'off'}`} onPress={() => void changeTweaks($, ctx, settings, now => ({ ...now, isBudgetBiasOn: !isBiasOn }))} />
          ) : (
            <Text dimColor>Budget bias: off</Text>
          )}
        </Box>
        <Box key="max-parallel" flexDirection="row" columnGap={1}>
          <Text>Max parallel</Text>
          <Button key="parallel-down" label="−" onPress={() => void changeTweaks($, ctx, settings, now => ({ ...now, maxParallel: Math.max(1, tuning.maxParallel - 1) }))} />
          <Text bold>{String(tuning.maxParallel)}</Text>
          <Button key="parallel-up" label="+" onPress={() => void changeTweaks($, ctx, settings, now => ({ ...now, maxParallel: Math.min(MAX_PARALLEL_LIMIT, tuning.maxParallel + 1) }))} />
        </Box>
        <Text dimColor>{`Learned rules (${rules.length}), this project`}</Text>
        {rules.length === 0 && <Text dimColor>  None yet: open a decision and press “Should be …”.</Text>}
        {rules.map(rule => (
          <Box key={`rule-${rule.id}`} flexDirection="row" gap={1}>
            <Text color={TIER_COLOR[rule.tier]}>{TIER_GLYPH[rule.tier]}</Text>
            <Text wrap="truncate-end">{`${rule.keywords.join(' + ')} → ${rule.tier}`}</Text>
            <Button key={`rule-delete-${rule.id}`} plain dimColor label="Delete" onPress={() => void deleteRule($, rule.id)} />
          </Box>
        ))}
        <Text dimColor>{`Reliability (outcomes), this project`}</Text>
        {spots.length === 0 && <Text dimColor>  Every kind of task is doing fine.</Text>}
        {spots.map(spot => (
          <Box key={`spot-${spot.category}-${spot.tier}`} flexDirection="row" gap={1}>
            <Text color={TIER_COLOR[spot.tier]}>{TIER_GLYPH[spot.tier]}</Text>
            <Text wrap="truncate-end" color={spot.isLow ? 'warning' : undefined}>{`${spot.category} on ${spot.tier}: ${percent(spot.score)} · ${spot.runs} run${spot.runs === 1 ? '' : 's'}${spot.isLow ? ' · routed up' : ''}`}</Text>
          </Box>
        ))}
        <Box flexDirection="row" columnGap={1}>
          <Button key="reset-stats" hotkey="r" label="Reset stats" onPress={() => void resetStats($, ctx, settings)} />
          {spots.length > 0 && <Button key="forget-outcomes" plain dimColor label="Forget outcomes" onPress={() => void forgetOutcomes($)} />}
        </Box>
      </Box>
    </Box>
  )
}

async function drawPane($: EngineInterface, ctx: Context, settings: Settings, e: PaneInput, isTab = false): Promise<RenderElement> {
  const el: Common = { ...$.ui.resolve(e), isTab }
  const { Box } = el
  const columns = Math.max(24, e.props.bodyColumns)
  const folded = await read($, collapsedAtom)
  const isOpen = (section: SmartRouterSection): boolean => folded[section] !== true
  return (
    <Box flexDirection="column" gap={1}>
      {await drawHeader($, ctx, el, settings)}
      {await drawLive($, ctx, el, isOpen('live'))}
      {await drawMix($, ctx, e, el, settings, isOpen('mix'), columns)}
      {await drawLog($, ctx, el, isOpen('log'), columns)}
      {await drawPlan($, ctx, el, settings, isOpen('plan'), columns)}
      {await drawRules($, ctx, el, settings, isOpen('rules'))}
    </Box>
  )
}

/** useEffort: marks a well-scoped deep Agent call for effort high before it spawns; nothing else ever sets effort. */
async function effortFor($: EngineInterface, ctx: Context, settings: Settings, call: { prompt: string; description: string; subagent_type?: string; model?: string; effort?: string; tool_use_id?: string }): Promise<boolean> {
  if (!settings.useEffort || call.model !== undefined || call.effort !== undefined || call.tool_use_id === undefined) return false
  const subagentType = call.subagent_type ?? 'general-purpose'
  if (!ROUTABLE_TYPES.has(subagentType) || (await modeNow($, settings)) !== 'auto') return false
  const verdict = classify({ prompt: call.prompt, description: call.description, subagentType }, await read($, rulesAtom))
  if (verdict.tier !== 'deep' || !verdict.isScoped) return false
  remember(ctx.effortCalls, call.tool_use_id, true, CACHE_SIZE)
  return true
}

export const register: Register = (on, options) => {
  const settings = settingsOf(options)
  const ctx: Context = {
    agents: new Map(),
    attempts: new Map(),
    streaks: new Map(),
    verdicts: new Map(),
    tools: new Map(),
    effortCalls: new Map(),
    auditAgents: new Map(),
    lastEditor: undefined,
    lastTestOk: undefined,
    isRegression: false,
    pendingSavings: 0,
    poller: undefined,
    flushTimer: undefined,
    flushed: NOTHING_FLUSHED,
    hasWorkflow: undefined,
    hasHub: false,
    lastTestAt: 0,
  }

  on('session.start', async ($, e, next) => {
    await registerCommand($, { name: 'route', description: 'Plan a task: subtasks, model tiers, parallel stages, cost and how to run them', argumentHint: '<task>' })
    await registerCommand($, { name: 'router', description: 'Open the Router pane: live subagents, savings, routing decisions and rules', argumentHint: '[auto | suggest | off | reset]', immediate: true })
    await loadMemory($)
    try {
      const mainModel = await $.session.model()
      await update($, totalsAtom, totals => ({ ...totals, mainModel }))
    } catch (error) {
      $.ui.log(`smart-router: could not read the main model: ${errorText(error)}`, { to: 'debug' })
    }
    await showStatus($, settings)
    afterStart($, 'smart-router', () => greetHub($, ctx, settings))
    if (settings.autoOpen) void openPane($, ctx)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (ctx.flushTimer !== undefined) {
      ctx.flushTimer.cancel()
      ctx.flushTimer = undefined
      await flushFiles($, ctx, settings)
    }
    return next(e)
  })

  // Routes each subagent (the Agent tool's, a plugin's, a workflow's) by the difficulty of its task.
  on('agent.spawn', async ($, e, next) => {
    if ((await modeNow($, settings)) === 'off') return next(e)
    const spawn = await planSpawn($, ctx, settings, e)
    const routed = spawn.decision.action === 'routed' && spawn.decision.model !== undefined ? { ...e, model: spawn.decision.model } : e
    const started = await next(routed)
    await recordSpawn($, ctx, settings, e, spawn, started)
    return started
  }).catch(($, e, next) => next(e)) // routing is never worth a failed spawn; after `next`, this replays its answer

  on('turn.complete', async ($, e, next) => {
    try {
      await account($, ctx, settings, e)
    } catch (error) {
      $.ui.log(`smart-router: could not count this turn: ${errorText(error)}`, { to: 'debug' })
    }
    return next(e)
  })

  // The effort lever (useEffort only): a well-scoped deep Agent call runs at effort high, then on the standard model.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => ((await effortFor($, ctx, settings, e)) ? next({ ...e, effort: 'high' }) : next(e))).catch(($, e, next) => next(e))

  // Test runs feed outcome learning (a failure right after an agent's edits) and the regression signal.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (TEST_COMMAND.test(e.command)) {
      try {
        await noteTests($, ctx, ran.deny === undefined && ran.isError !== true)
      } catch (error) {
        $.ui.log(`smart-router: could not note the test run: ${errorText(error)}`, { to: 'debug' })
      }
    }
    return ran
  })

  // Counts the running subagents' tool calls (published by the poll) and notes which ones changed files.
  on('tool.call', ($, e, next) => {
    const tracked = e.agentId === undefined ? undefined : ctx.agents.get(e.agentId)
    if (tracked !== undefined && e.agentId !== undefined) {
      ctx.tools.set(e.agentId, (ctx.tools.get(e.agentId) ?? 0) + 1)
      if (EDIT_TOOLS.has(String(e.tool))) tracked.didEdit = true
    }
    return next(e)
  })

  // The orchestration guidance: one session-scope section, the same all session, for the prompt cache.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    ctx.hasWorkflow = e.tools.includes('Workflow')
    if (!e.tools.includes('Agent') || e.traits.includes('bare')) return composed
    const mode = await modeNow($, settings)
    if (mode === 'off') return composed
    const tuning = await tuningNow($, settings)
    const section = { id: SECTION_ID, scope: 'session' as const, text: guidanceText({ models: tuning.models, maxParallel: tuning.maxParallel, hasWorkflow: ctx.hasWorkflow, isAuto: mode === 'auto' }) }
    return { sections: [...composed.sections.filter(one => one.id !== SECTION_ID), section] }
  })

  on('command.run', { command: 'route' }, async ($, e) => {
    const task = e.args.trim()
    if (task === '') return { text: ROUTE_USAGE }
    const plan = await draftPlan($, ctx, settings, task)
    await update($, planAtom, () => plan)
    await update($, collapsedAtom, folded => ({ ...folded, plan: false }))
    const isShown = await openPane($, ctx)
    return { text: isShown ? routeSummary(plan) : `${routeSummary(plan)}\n\n${planText(plan, (await tuningNow($, settings)).models)}` }
  })

  on('command.run', { command: 'router' }, async ($, e) => {
    const word = e.args.trim().toLowerCase()
    const mode = MODES.find(one => one === word)
    if (mode !== undefined) await setMode($, ctx, settings, mode)
    else if (word === 'reset') await resetStats($, ctx, settings)
    else if (word !== '') return { text: ROUTER_USAGE }
    await openPane($, ctx)
    const totals = await read($, totalsAtom)
    return { text: `Router: ${MODE_LABEL[await modeNow($, settings)].toLowerCase()} · ${totals.agents} subagent${totals.agents === 1 ? '' : 's'} · ${savingsLine(totals).text}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => drawPane($, ctx, settings, e))

  // The Router tab: drawn beneath the hub's tab strip when it is the tab shown; any other tab passes through.
  on('ui.render', { component: 'Pane', requestId: HUB_PANE }, async ($, e, next) => {
    if (!(await hubTabIs($, TAB.id))) return next(e)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {await next(e)}
        {await drawPane($, ctx, settings, e, true)}
      </Box>
    )
  })
}

/** Registers a slash command. A refused name (Claude Code's own, or another mod's) is reported as a notice, never thrown, so the rest of session.start still runs. */
async function registerCommand($: EngineInterface, spec: Parameters<EngineInterface['command']['register']>[0]): Promise<boolean> {
  try {
    await $.command.register(spec)
    return true
  } catch (error) {
    $.ui.log(`${$.plugin.name}: /${spec.name} was not registered (${error instanceof Error ? error.message : String(error)}).`)
    return false
  }
}

// #region @vendored shared/hub-client.ts sha256:6b153e2e759f: edit the source, then run `node scripts/sync-shared.mjs`.
// mods-hub client (docs/MOD_CONTRACT.md): uses the hub when it is installed, keeps working when it is not.

type HubMods = EngineInterface['mods']

/** Publishes an event on the hub's bus; false when there is no hub or it refused the event. */
async function hubPublish($: EngineInterface, input: Parameters<HubMods['publish']>[0]): Promise<boolean> {
  try {
    await $.mods.publish(input)
    return true
  } catch {
    return false
  }
}

/**
 * Routes a notification through the hub (channels, silent, night, presence), or shows it as a toast when there is
 * no hub: `title — body`, for `fallback.timeoutMs` when given (the toast's own option).
 */
async function hubNotify($: EngineInterface, input: Parameters<HubMods['notify']>[0], fallback: { timeoutMs?: number } = {}): Promise<void> {
  try {
    await $.mods.notify(input)
  } catch {
    const text = input.body === undefined || input.body === '' ? input.title : `${input.title} — ${input.body}`
    if (fallback.timeoutMs === undefined) $.ui.toast(text)
    else $.ui.toast(text, { timeoutMs: fallback.timeoutMs })
  }
}

/** The global mode (presence, silent, night, interaction), or undefined when there is no hub. */
async function hubMode($: EngineInterface): Promise<Awaited<ReturnType<HubMods['mode']>> | undefined> {
  try {
    return await $.mods.mode()
  } catch {
    return undefined
  }
}

/** Announces this mod to the hub, with its panel tab when it has one; call once from `session.start`. */
async function hubHello($: EngineInterface, hello: Parameters<HubMods['hello']>[0], tab?: Parameters<HubMods['registerTab']>[0]): Promise<boolean> {
  try {
    await $.mods.hello(hello)
    if (tab !== undefined) await $.mods.registerTab(tab)
    return true
  } catch {
    return false
  }
}

/** Opens the shared panel on this mod's tab; false when there is no hub (open your own pane then). */
async function hubShowTab($: EngineInterface, id: string): Promise<boolean> {
  try {
    return (await $.mods.showTab({ id })).isPlaced
  } catch {
    return false
  }
}

/**
 * Stops, pauses or resumes the automatic work (`control.stop` / `control.pause` / `control.resume`) in this session
 * or, with `scope: 'all'`, in every session; false when there is no hub (stop what you run yourself then).
 */
async function hubStop($: EngineInterface, input: Parameters<HubMods['stop']>[0]): Promise<boolean> {
  try {
    await $.mods.stop(input)
    return true
  } catch {
    return false
  }
}

/** Puts a fact on the hub's blackboard as `<this mod>.<name>`; false when there is no hub or it refused the fact. */
async function hubShareFact($: EngineInterface, input: Parameters<HubMods['share']>[0]): Promise<boolean> {
  try {
    await $.mods.share(input)
    return true
  } catch {
    return false
  }
}

/** A fact from the hub's blackboard by its full key (`stack-detector.stack`); undefined when there is no hub or no such fact. */
async function hubReadFact($: EngineInterface, key: string): Promise<Awaited<ReturnType<HubMods['read']>> | undefined> {
  try {
    return (await $.mods.read({ key })) ?? undefined
  } catch {
    return undefined
  }
}

/** Whether the shared panel shows tab `id` now; read while drawing, it subscribes the drawing. */
async function hubTabIs($: EngineInterface, id: string): Promise<boolean> {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
  return value === id
}
/**
 * Runs a mod's start-up work (the hub hello, a first scan, loading what it keeps) once `session.start` has returned,
 * after a short delay staggered by the mod's name (0.15–1.35 s), so ~200 mods sharing one hooks worker do not all wait
 * on the hub, a process or the disk inside the session.start chain (`ran past its 10s budget`). A failure is logged
 * to the debug log. Call it from `session.start` in place of `await work()`; never await the hub there
 * (scripts/check-startup.mjs).
 */
function afterStart($: EngineInterface, mod: string, work: () => Promise<unknown>): void {
  let hash = 7
  for (let i = 0; i < mod.length; i += 1) hash = (hash * 31 + mod.charCodeAt(i)) % 1_200
  $.clock.after(150 + hash, () => {
    void work().catch(error => $.ui.log(`${mod}: start-up work failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' }))
  })
}
// #endregion @vendored shared/hub-client.ts
