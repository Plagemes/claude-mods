import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptSubmitInput, PromptSubmitResult, Register, RenderElement, RenderInput, SessionAppendInput, SessionAppendResult, SessionCompactInput, SessionCompactResult, SessionContextUsage, Timer, ToolCallInput, ToolCallResult } from 'claude-code'

import type { ContextOptimizerContributors, ContextOptimizerPrefs, ContextOptimizerSaved } from '../types'
import { carryText, compactInstructions, decisionsIn, focusOf, isEmptyCarry, makeCarry, relativeTo, remember } from './carry'
import type { CarryOver } from './carry'
import { REASON_LABEL, detectMoment, isNewTopic, keywords, milestoneOf } from './moments'
import type { Milestone, MomentReason } from './moments'
import { MIN_DEDUPE_CHARS, checkRead, dedupeNote, readKey } from './reads'
import type { ReadEntry } from './reads'
import { describeRun, isTestCommand, summarizeRun } from './shared/test-runners'
import { isTrimmable, resultText, tokensOf, toolPatterns, trimText } from './trim'

// ── Constants ───────────────────────────────────────────────────────────────────────────────────────

const VERSION = '1.0.0'
const PANE = 'context-optimizer'
const HUB_PANE = 'claude-mods'
const TAB = { id: 'context', title: 'Context', order: 95, command: 'ctx' }
const PRESSURE_STEPS = [70, 85, 95] as const
const HUB_PRESSURE_WINDOW_MS = 60_000
const COOLDOWN_TURNS = 6
const RECENT_PROMPTS = 3
const MAX_FILES = 12
const MAX_DECISIONS = 8
const MAX_HISTORY = 10
const TOP_SHOWN = 5
const GAUGE_WIDTH = 30
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])
const WRITERS = new Set(['Edit', 'Write', 'NotebookEdit'])
const USAGE = 'Usage: /ctx [compact]'

const NO_SAVINGS: ContextOptimizerSaved = { tokens: 0, trimmed: 0, trimmedTokens: 0, deduped: 0, dedupedTokens: 0 }
const NO_CONTRIBUTORS: ContextOptimizerContributors = { byTool: {}, byFile: {} }

// ── State the tab and the band draw from ────────────────────────────────────────────────────────────

const fillAtom = atom({ plugin: 'context-optimizer', key: 'fill' } as const, null)
const savedAtom = atom({ plugin: 'context-optimizer', key: 'saved' } as const, NO_SAVINGS)
const contributorsAtom = atom({ plugin: 'context-optimizer', key: 'contributors' } as const, NO_CONTRIBUTORS)
const historyAtom = atom({ plugin: 'context-optimizer', key: 'history' } as const, [])
const suggestionAtom = atom({ plugin: 'context-optimizer', key: 'suggestion' } as const, null)
const carryAtom = atom({ plugin: 'context-optimizer', key: 'carry' } as const, null)
const pendingAtom = atom({ plugin: 'context-optimizer', key: 'isCarryPending' } as const, false)
const prefsAtom = atom({ plugin: 'context-optimizer', key: 'prefs' } as const, null)
const categoriesAtom = atom({ plugin: 'context-optimizer', key: 'categories' } as const, null)

// ── The per-load runtime ────────────────────────────────────────────────────────────────────────────

type Options = { trimAboveChars: number; patterns: RegExp[]; suggestAt: number; idleMs: number; defaults: ContextOptimizerPrefs }
type Call = { tool: string; path?: string; key?: string; repeatOf?: number }

type Runtime = {
  options: Options
  root: string
  turn: number
  /** Compactions so far: a read from an earlier epoch is no longer in the context. */
  epoch: number
  reads: Map<string, ReadEntry>
  /** Keys whose last read was replaced by a note: the next identical read comes through whole. */
  noted: Set<string>
  calls: Map<string, Call>
  milestone: Milestone | undefined
  todos: string[]
  isTodoListDone: boolean
  files: string[]
  decisions: string[]
  tests: string | undefined
  prompts: Set<string>[]
  lastSuggestedTurn: number | undefined
  idleTimer: Timer | undefined
  pressureStep: number
  isOutputTrimmer: boolean
  turnSaved: number
  /** A carry-over taken by context-optimizer's own /compact, and why it ran. */
  prepared: { carry: CarryOver; reason?: string } | undefined
  sawCompact: boolean
}

const newRuntime = (options: Options): Runtime => ({
  options,
  root: '',
  turn: 0,
  epoch: 0,
  reads: new Map(),
  noted: new Set(),
  calls: new Map(),
  milestone: undefined,
  todos: [],
  isTodoListDone: false,
  files: [],
  decisions: [],
  tests: undefined,
  prompts: [],
  lastSuggestedTurn: undefined,
  idleTimer: undefined,
  pressureStep: 0,
  isOutputTrimmer: false,
  turnSaved: 0,
  prepared: undefined,
  sawCompact: false,
})

const wholeNumber = (value: unknown, fallback: number, min = 0): number => (typeof value === 'number' && Number.isFinite(value) && value >= min ? Math.round(value) : fallback)

const formatTokens = (tokens: number): string =>
  tokens >= 1_000_000 ? `${+(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1_000 ? `${+(tokens / 1_000).toFixed(1)}k` : String(Math.round(tokens))

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

const isPersonOrigin = (origin: PromptSubmitInput['origin']): boolean => PERSON_ORIGINS.has(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)

async function effectivePrefs($: EngineInterface, rt: Runtime): Promise<ContextOptimizerPrefs> {
  return (await read($, prefsAtom)) ?? rt.options.defaults
}

// ── The hub (soft) ──────────────────────────────────────────────────────────────────────────────────

async function hubLatestPressure($: EngineInterface): Promise<{ percent: number; at: number; source: string } | undefined> {
  try {
    const event = await $.mods.latest({ topic: 'context.pressure' })
    const data = event?.data
    return event === null || typeof data !== 'object' || data === null || !('percent' in data) ? undefined : { percent: Number(data.percent), at: event.at, source: event.source }
  } catch {
    return undefined
  }
}

async function hubDecisions($: EngineInterface): Promise<string[]> {
  try {
    const events = await $.mods.recent({ topic: 'decision.recorded', limit: MAX_DECISIONS })
    return events.map(event => (typeof event.data === 'object' && event.data !== null && 'title' in event.data ? String(event.data.title) : '')).filter(title => title !== '')
  } catch {
    return []
  }
}

async function hubInstalledNames($: EngineInterface): Promise<string[] | undefined> {
  try {
    const installed = await $.mods.installed()
    return installed.listedAt === null ? undefined : installed.plugins.filter(plugin => plugin.isEnabled).map(plugin => plugin.name)
  } catch {
    return undefined
  }
}

/** output-trimmer owns Bash outputs when it is installed: from the hub's list, else the user settings' enabledPlugins. */
async function detectOutputTrimmer($: EngineInterface, rt: Runtime): Promise<void> {
  const fromHub = await hubInstalledNames($)
  if (fromHub !== undefined) {
    rt.isOutputTrimmer = fromHub.includes('output-trimmer')
    return
  }
  try {
    const settings = await $.settings.read()
    const enabled = (settings as { enabledPlugins?: unknown }).enabledPlugins
    rt.isOutputTrimmer =
      typeof enabled === 'object' && enabled !== null && Object.entries(enabled).some(([id, on]) => on === true && (id === 'output-trimmer' || id.startsWith('output-trimmer@')))
  } catch {
    rt.isOutputTrimmer = false
  }
}

// ── Watching the work: reads, edits, todos, tests, commits ──────────────────────────────────────────

async function observeCall($: EngineInterface, rt: Runtime, e: ToolCallInput, next: (e: ToolCallInput) => Promise<ToolCallResult>): Promise<ToolCallResult> {
  if (e.agentId !== undefined) return next(e)
  const call: Call = { tool: String(e.tool) }
  let stat: { mtimeMs: number; size: number } | undefined
  if (e.tool === 'Read') {
    call.path = e.file_path
    call.key = readKey(e)
    if ((await effectivePrefs($, rt)).dedupe) {
      stat = await $.fs.stat(e.file_path).catch(() => undefined)
      const verdict = stat === undefined ? { isRepeat: false as const } : checkRead(rt.reads.get(call.key), stat, { turn: rt.turn, epoch: rt.epoch }, rt.noted.has(call.key))
      if (verdict.isRepeat) call.repeatOf = verdict.turn
      else rt.noted.delete(call.key)
    }
  } else if (WRITERS.has(call.tool) && 'file_path' in e && typeof e.file_path === 'string') {
    call.path = e.file_path
  }
  rt.calls.set(e.tool_use_id, call)

  const ran = await next(e)
  if (ran.deny !== undefined || ran.isError === true) return ran

  if (call.key !== undefined && stat !== undefined && call.repeatOf === undefined) rt.reads.set(call.key, { turn: rt.turn, ...stat, epoch: rt.epoch })
  if (WRITERS.has(call.tool) && call.path !== undefined) rt.files = remember(rt.files, [relativeTo(rt.root, call.path)], MAX_FILES)
  if (e.tool === 'TodoWrite') {
    const open = e.todos.filter(todo => todo.status !== 'completed').map(todo => todo.content)
    rt.isTodoListDone = rt.isTodoListDone || (rt.todos.length > 0 && open.length === 0 && e.todos.length > 0)
    rt.todos = open
  } else if (e.tool === 'Bash') {
    const output = typeof ran.text === 'string' ? ran.text : JSON.stringify(ran.result ?? '')
    const milestone = milestoneOf(e.command, output)
    if (milestone !== undefined) rt.milestone = milestone
    if (isTestCommand(e.command)) rt.tests = describeRun(summarizeRun(e.command, output, false))
  }
  return ran
}

// ── Trimming and dedupe, where the result row is kept ───────────────────────────────────────────────

async function rewriteResults($: EngineInterface, rt: Runtime, e: SessionAppendInput, next: (e: SessionAppendInput) => Promise<SessionAppendResult>): Promise<SessionAppendResult> {
  if (e.agentId !== undefined) return next(e)
  const prefs = await effectivePrefs($, rt)
  const byTool: Record<string, number> = {}
  const byFile: Record<string, number> = {}
  const saved = { trimmed: 0, trimmedTokens: 0, deduped: 0, dedupedTokens: 0 }
  let isChanged = false

  const content = e.message.content.map(block => {
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') return block
    const call = rt.calls.get(block.tool_use_id)
    rt.calls.delete(block.tool_use_id)
    const tool = call?.tool ?? (e.origin.kind === 'tool' ? String(e.origin.tool) : 'tool')
    const text = resultText(block.content)
    if (text === undefined) return block

    let kept = text
    if (call?.repeatOf !== undefined && call.path !== undefined && prefs.dedupe && text.length >= MIN_DEDUPE_CHARS) {
      kept = dedupeNote(relativeTo(rt.root, call.path), call.repeatOf, text.length)
      saved.deduped += 1
      saved.dedupedTokens += tokensOf(text.length - kept.length)
      if (call.key !== undefined) rt.noted.add(call.key)
    } else if (prefs.trim && isTrimmable(tool, rt.options.patterns) && !(tool === 'Bash' && rt.isOutputTrimmer)) {
      const trimmed = trimText(text, { maxChars: rt.options.trimAboveChars, tool })
      if (trimmed !== undefined) {
        kept = trimmed
        saved.trimmed += 1
        saved.trimmedTokens += tokensOf(text.length - kept.length)
      }
    }
    byTool[tool] = (byTool[tool] ?? 0) + tokensOf(kept.length)
    if (call?.path !== undefined && tool === 'Read') {
      const path = relativeTo(rt.root, call.path)
      byFile[path] = (byFile[path] ?? 0) + tokensOf(kept.length)
    }
    if (kept === text) return block
    isChanged = true
    return { ...block, content: kept }
  })

  const tokens = saved.trimmedTokens + saved.dedupedTokens
  rt.turnSaved += tokens
  $.clock.after(0, () => void recordResults($, byTool, byFile, saved))
  return next(isChanged ? { ...e, message: { ...e.message, content } } : e)
}

async function recordResults($: EngineInterface, byTool: Record<string, number>, byFile: Record<string, number>, saved: Omit<ContextOptimizerSaved, 'tokens'>): Promise<void> {
  const add = (into: Record<string, number>, from: Record<string, number>): Record<string, number> => {
    const sum = { ...into }
    for (const [key, value] of Object.entries(from)) sum[key] = (sum[key] ?? 0) + value
    return sum
  }
  if (Object.keys(byTool).length > 0) await update($, contributorsAtom, current => ({ byTool: add(current.byTool, byTool), byFile: add(current.byFile, byFile) }))
  if (saved.trimmed + saved.deduped > 0) {
    await update($, savedAtom, current => ({
      tokens: current.tokens + saved.trimmedTokens + saved.dedupedTokens,
      trimmed: current.trimmed + saved.trimmed,
      trimmedTokens: current.trimmedTokens + saved.trimmedTokens,
      deduped: current.deduped + saved.deduped,
      dedupedTokens: current.dedupedTokens + saved.dedupedTokens,
    }))
  }
}

// ── Context fill and pressure ───────────────────────────────────────────────────────────────────────

async function notePressure($: EngineInterface, rt: Runtime, context: SessionContextUsage): Promise<void> {
  const percent = context.percent
  if (percent === undefined) return
  const now = await $.clock.now()
  await update($, fillAtom, () => ({ percent, tokens: context.tokens ?? 0, window: context.window, at: now }))
  const step = PRESSURE_STEPS.filter(threshold => percent >= threshold).length
  if (step > rt.pressureStep) {
    const fromHub = await hubLatestPressure($)
    const hubStep = fromHub === undefined || now - fromHub.at > HUB_PRESSURE_WINDOW_MS ? 0 : PRESSURE_STEPS.filter(threshold => fromHub.percent >= threshold).length
    if (fromHub?.source !== 'mods-hub' || hubStep < step) await hubPublish($, { topic: 'context.pressure', data: { percent, tokens: context.tokens ?? 0, window: context.window } })
  }
  rt.pressureStep = step
}

async function currentPercent($: EngineInterface): Promise<number | undefined> {
  const fill = await read($, fillAtom)
  if (fill !== null) return fill.percent
  try {
    return (await $.session.usage()).context.percent
  } catch {
    return undefined
  }
}

// ── Compaction moments, the carry-over, compacting ──────────────────────────────────────────────────

async function buildCarry($: EngineInterface, rt: Runtime): Promise<CarryOver> {
  const decisions = remember(rt.decisions, (await hubDecisions($)).reverse(), MAX_DECISIONS)
  return makeCarry({ at: await $.clock.now(), turn: rt.turn, decisions, todos: rt.todos, files: rt.files, ...(rt.tests === undefined ? {} : { tests: rt.tests }) })
}

async function suggest($: EngineInterface, rt: Runtime, reason: MomentReason): Promise<void> {
  const percent = Math.round((await currentPercent($)) ?? 0)
  const carry = await buildCarry($, rt)
  const focus = focusOf(carry)
  rt.lastSuggestedTurn = rt.turn
  await update($, suggestionAtom, () => ({ reason: REASON_LABEL[reason], focus, percent, at: carry.at }))
  await hubNotify($, { level: 'info', title: `Good moment to /compact (${percent}% full, ${REASON_LABEL[reason]})`, body: `/compact ${focus}`, audience: 'terminal' })
  if ((await effectivePrefs($, rt)).autoCompact) {
    rt.idleTimer?.cancel()
    rt.idleTimer = $.clock.after(rt.options.idleMs, () => void compactNow($, rt).catch(() => undefined))
  }
}

/** Runs /compact with the carry-over as its focus (the person's button, /ctx compact, or autoCompact when idle). */
async function compactNow($: EngineInterface, rt: Runtime): Promise<string> {
  rt.idleTimer?.cancel()
  rt.idleTimer = undefined
  const suggestion = await read($, suggestionAtom)
  const carry = await buildCarry($, rt)
  rt.prepared = { carry, ...(suggestion === null ? {} : { reason: suggestion.reason }) }
  rt.sawCompact = false
  await update($, suggestionAtom, () => null)
  const focus = focusOf(carry)
  try {
    await $.command.run({ command: 'compact', args: focus })
  } catch (error) {
    rt.prepared = undefined
    return `Could not run /compact: ${error instanceof Error ? error.message : String(error)}`
  }
  // When the engine's own /compact ran beneath this plugin's call, its session.compact skipped this hook: record it here.
  if (!rt.sawCompact && rt.prepared !== undefined) await afterCompaction($, rt, { trigger: 'plugin', carry: rt.prepared.carry, ...(rt.prepared.reason === undefined ? {} : { reason: rt.prepared.reason }) })
  rt.prepared = undefined
  return `Compacting with the focus: ${focus}`
}

async function afterCompaction($: EngineInterface, rt: Runtime, done: { trigger: SessionCompactInput['trigger']; carry: CarryOver; reason?: string; tokensBefore?: number; tokensAfter?: number }): Promise<void> {
  const prefs = await effectivePrefs($, rt)
  const hasCarry = prefs.carryOver && !isEmptyCarry(done.carry)
  rt.sawCompact = true
  rt.epoch += 1
  rt.reads.clear()
  rt.noted.clear()
  rt.pressureStep = 0
  rt.isTodoListDone = false
  rt.milestone = undefined
  await update($, contributorsAtom, () => NO_CONTRIBUTORS)
  await update($, suggestionAtom, () => null)
  await update($, historyAtom, list => [
    ...list,
    {
      at: done.carry.at,
      trigger: done.trigger,
      hasCarry,
      ...(done.reason === undefined ? {} : { reason: done.reason }),
      ...(done.tokensBefore === undefined ? {} : { tokensBefore: done.tokensBefore }),
      ...(done.tokensAfter === undefined ? {} : { tokensAfter: done.tokensAfter }),
    },
  ].slice(-MAX_HISTORY))
  if (hasCarry) {
    await update($, carryAtom, () => done.carry)
    await update($, pendingAtom, () => true)
  }
}

async function onCompact($: EngineInterface, rt: Runtime, e: SessionCompactInput, next: (e: SessionCompactInput) => Promise<SessionCompactResult>): Promise<SessionCompactResult> {
  if (e.agentId !== undefined) return next(e)
  const prefs = await effectivePrefs($, rt)
  const prepared = rt.prepared
  const carry = prepared?.carry ?? (await buildCarry($, rt))
  const suggestion = await read($, suggestionAtom)
  const extra = prefs.carryOver && !isEmptyCarry(carry) ? compactInstructions(carry) : undefined
  const ran = await next(extra === undefined ? e : { ...e, instructions: e.instructions === undefined || e.instructions === '' ? extra : `${e.instructions}\n\n${extra}` })
  if (e.trigger === 'precompute' || ran.skip !== undefined) return ran
  const reason = prepared?.reason ?? suggestion?.reason
  await afterCompaction($, rt, {
    trigger: e.trigger,
    carry,
    ...(reason === undefined ? {} : { reason }),
    ...(ran.tokensBefore === undefined ? {} : { tokensBefore: ran.tokensBefore }),
    ...(ran.tokensAfter === undefined ? {} : { tokensAfter: ran.tokensAfter }),
  })
  return ran
}

async function onPrompt($: EngineInterface, rt: Runtime, e: PromptSubmitInput, next: (e: PromptSubmitInput) => Promise<PromptSubmitResult>): Promise<PromptSubmitResult> {
  rt.idleTimer?.cancel()
  rt.idleTimer = undefined
  const context: string[] = []
  if (isPersonOrigin(e.origin)) {
    rt.decisions = remember(rt.decisions, decisionsIn(e.text), MAX_DECISIONS)
    const isTopicChange = isNewTopic(rt.prompts, e.text)
    rt.prompts = [...rt.prompts, keywords(e.text)].slice(-RECENT_PROMPTS)
    if (isTopicChange) {
      const percent = await currentPercent($)
      const moment = detectMoment({ percent, suggestAt: rt.options.suggestAt, milestone: undefined, isTodoListDone: false, isTopicChange, openTodos: 0, turn: rt.turn, lastSuggestedTurn: rt.lastSuggestedTurn, cooldownTurns: COOLDOWN_TURNS })
      if (moment !== undefined) $.clock.after(0, () => void suggest($, rt, moment))
    }
  }
  if ((await read($, pendingAtom)) && (await effectivePrefs($, rt)).carryOver) {
    const carry = await read($, carryAtom)
    if (carry !== null) context.push(carryText(carry))
    await update($, pendingAtom, () => false)
  }
  return next(context.length === 0 ? e : { ...e, context: [...(e.context ?? []), ...context] })
}

async function onTurnComplete($: EngineInterface, rt: Runtime, isAnswer: boolean): Promise<void> {
  if (rt.turnSaved > 0) {
    const saved = await read($, savedAtom)
    await hubPublish($, { topic: 'x.context-optimizer.saved', data: { tokens: rt.turnSaved, total: saved.tokens, trimmed: saved.trimmed, deduped: saved.deduped } })
    rt.turnSaved = 0
  }
  if (!isAnswer) return
  const moment = detectMoment({
    percent: await currentPercent($),
    suggestAt: rt.options.suggestAt,
    milestone: rt.milestone,
    isTodoListDone: rt.isTodoListDone,
    isTopicChange: false,
    openTodos: rt.todos.length,
    turn: rt.turn,
    lastSuggestedTurn: rt.lastSuggestedTurn,
    cooldownTurns: COOLDOWN_TURNS,
  })
  if (moment !== undefined) await suggest($, rt, moment)
}

async function resetSession($: EngineInterface, rt: Runtime): Promise<void> {
  rt.idleTimer?.cancel()
  Object.assign(rt, { ...newRuntime(rt.options), root: rt.root, isOutputTrimmer: rt.isOutputTrimmer })
  await update($, contributorsAtom, () => NO_CONTRIBUTORS)
  await update($, suggestionAtom, () => null)
  await update($, pendingAtom, () => false)
  await update($, fillAtom, () => null)
}

// ── Commands and switches ───────────────────────────────────────────────────────────────────────────

async function openView($: EngineInterface): Promise<void> {
  if (!(await hubShowTab($, TAB.id))) await $.ui.open({ id: PANE, title: 'Context' })
}

async function readCategories($: EngineInterface): Promise<void> {
  try {
    const breakdown = (await $.session.usage({ breakdown: 'summary' })).context.breakdown
    if (breakdown === undefined) return
    const used = breakdown.categories.filter(category => category.kind === 'used' && category.tokens > 0).sort((a, b) => b.tokens - a.tokens)
    await update($, categoriesAtom, () => used.slice(0, TOP_SHOWN).map(category => ({ name: category.name, tokens: category.tokens })))
  } catch {
    // No breakdown on this surface: the tab shows the per-tool estimate alone.
  }
}

async function summaryText($: EngineInterface): Promise<string> {
  const fill = await read($, fillAtom)
  const saved = await read($, savedAtom)
  const history = await read($, historyAtom)
  const suggestion = await read($, suggestionAtom)
  return [
    fill === null ? 'Context: no reading yet (after the first response).' : `Context: ${fill.percent}% full (${formatTokens(fill.tokens)} of ${formatTokens(fill.window)} tokens).`,
    `Saved: ~${formatTokens(saved.tokens)} tokens (${plural(saved.trimmed, 'result')} trimmed, ${plural(saved.deduped, 'repeated read')} left out).`,
    `Compactions this session: ${history.length}.`,
    suggestion === null ? '' : `Good moment to compact (${suggestion.reason}): /compact ${suggestion.focus}`,
  ].filter(line => line !== '').join('\n')
}

async function runCommand($: EngineInterface, rt: Runtime, args: string, origin: PromptSubmitInput['origin']): Promise<string> {
  const verb = args.trim()
  if (verb === '') {
    await readCategories($)
    await openView($)
    return summaryText($)
  }
  if (verb === 'compact') {
    if (!isPersonOrigin(origin)) return 'Only you can start a compaction from /ctx.'
    $.clock.after(0, () => void compactNow($, rt).catch(() => undefined))
    return `Compacting with the focus: ${focusOf(await buildCarry($, rt))}`
  }
  return USAGE
}

async function togglePref($: EngineInterface, rt: Runtime, key: keyof ContextOptimizerPrefs): Promise<void> {
  await update($, prefsAtom, current => {
    const prefs = current ?? rt.options.defaults
    return { ...prefs, [key]: !prefs[key] }
  })
}

// ── Drawing ─────────────────────────────────────────────────────────────────────────────────────────

const fillColor = (percent: number): 'success' | 'warning' | 'error' => (percent >= 85 ? 'error' : percent >= 60 ? 'warning' : 'success')

const bar = (percent: number, width: number): string => {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}

const top = (record: Readonly<Record<string, number>>): [string, number][] =>
  Object.entries(record)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_SHOWN)

const clock = (at: number): string => {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

async function drawBody($: EngineInterface, e: RenderInput<'Pane'>, rt: Runtime): Promise<RenderElement> {
  const { Box, Button, Text } = $.ui.resolve(e)
  const fill = await read($, fillAtom)
  const saved = await read($, savedAtom)
  const contributors = await read($, contributorsAtom)
  const history = await read($, historyAtom)
  const suggestion = await read($, suggestionAtom)
  const categories = await read($, categoriesAtom)
  const prefs = await effectivePrefs($, rt)
  const width = Math.max(30, e.props.bodyColumns)
  const gaugeWidth = Math.min(GAUGE_WIDTH, Math.max(10, width - 34))
  const tools = top(contributors.byTool)
  const files = top(contributors.byFile)
  const switches: [keyof ContextOptimizerPrefs, string][] = [
    ['trim', `Trim results over ${formatTokens(rt.options.trimAboveChars)} chars`],
    ['dedupe', 'Dedupe repeated reads'],
    ['carryOver', 'Carry-over across /compact'],
    ['autoCompact', 'Compact by itself when idle'],
  ]

  return (
    <Box key="context-body" flexDirection="column">
      <Box key="fill" flexDirection="row" columnGap={1}>
        <Text bold>Context</Text>
        {fill === null ? (
          <Text dimColor>no reading yet: it comes with the next response</Text>
        ) : (
          <Text>
            <Text color={fillColor(fill.percent)}>{bar(fill.percent, gaugeWidth)}</Text>
            {` ${fill.percent}% · ${formatTokens(fill.tokens)} of ${formatTokens(fill.window)}`}
          </Text>
        )}
      </Box>
      {suggestion === null ? null : (
        <Box key="suggestion" flexDirection="column" marginTop={1}>
          <Text color="suggestion">{`Good moment to compact: ${suggestion.reason} (${suggestion.percent}% full)`}</Text>
          <Text dimColor>{`/compact ${suggestion.focus}`}</Text>
          <Box flexDirection="row" columnGap={1}>
            <Button key="compact-now" label="Compact now" variant="primary" hotkey="c" onPress={() => compactNow($, rt).then(() => undefined)} />
            <Button key="compact-later" label="Later" onPress={() => update($, suggestionAtom, () => null).then(() => undefined)} />
          </Box>
        </Box>
      )}
      <Box key="saved" flexDirection="column" marginTop={1}>
        <Text bold>{`Saved ~${formatTokens(saved.tokens)} tokens`}</Text>
        <Text dimColor>{`${saved.trimmed} noisy results trimmed (~${formatTokens(saved.trimmedTokens)}) · ${saved.deduped} repeated reads left out (~${formatTokens(saved.dedupedTokens)})${rt.isOutputTrimmer ? ' · Bash left to output-trimmer' : ''}`}</Text>
      </Box>
      <Box key="contributors" flexDirection="column" marginTop={1}>
        <Text bold>Biggest contributors since the last compaction</Text>
        {tools.length === 0 ? <Text dimColor>No tool results yet.</Text> : null}
        {tools.map(([tool, tokens]) => (
          <Box key={`tool-${tool}`}>
            <Text>{`${tool.padEnd(18)} ~${formatTokens(tokens)}`}</Text>
          </Box>
        ))}
        {files.map(([path, tokens]) => (
          <Box key={`file-${path}`}>
            <Text dimColor>{`  ${path.length > width - 14 ? `…${path.slice(path.length - (width - 15))}` : path} ~${formatTokens(tokens)}`}</Text>
          </Box>
        ))}
        {categories === null || categories.length === 0 ? null : <Text dimColor>{`Window: ${categories.map(category => `${category.name} ${formatTokens(category.tokens)}`).join(' · ')}`}</Text>}
      </Box>
      <Box key="history" flexDirection="column" marginTop={1}>
        <Text bold>Compactions</Text>
        {history.length === 0 ? <Text dimColor>None this session.</Text> : null}
        {history.slice(-TOP_SHOWN).reverse().map((one, index) => (
          <Box key={`compaction-${index}`}>
            <Text>
              {`${clock(one.at)} ${one.trigger}`}
              {one.tokensBefore === undefined ? '' : ` · ${formatTokens(one.tokensBefore)} → ${formatTokens(one.tokensAfter ?? 0)}`}
              {one.reason === undefined ? '' : ` · ${one.reason}`}
              {one.hasCarry ? ' · carry-over kept' : ''}
            </Text>
          </Box>
        ))}
      </Box>
      <Box key="settings" flexDirection="column" marginTop={1}>
        <Text bold>Settings (this session)</Text>
        {switches.map(([key, label]) => (
          <Box key={`pref-row-${key}`} flexDirection="row" columnGap={1}>
            <Button key={`pref-${key}`} label={prefs[key] ? 'on ' : 'off'} variant={prefs[key] ? 'primary' : 'secondary'} onPress={() => togglePref($, rt, key)} />
            <Text>{label}</Text>
          </Box>
        ))}
        <Text dimColor>{`Suggests from ${rt.options.suggestAt}% full; defaults live in /config.`}</Text>
      </Box>
    </Box>
  )
}

async function drawBand($: EngineInterface, e: RenderInput<'AbovePrompt'>, next: (e: RenderInput<'AbovePrompt'>) => Promise<RenderElement>, rt: Runtime): Promise<RenderElement> {
  const suggestion = await read($, suggestionAtom)
  if (suggestion === null || e.props.hasSurvey) return next(e)
  const { Box, Button, Text } = $.ui.resolve(e)
  return (
    <Box flexDirection="column">
      {await next(e)}
      <Box key="context-band" flexDirection="row" columnGap={1}>
        <Text color="suggestion">{`◆ Good moment to /compact: ${suggestion.reason} · ${suggestion.percent}% full`}</Text>
        <Button key="band-compact" label="Compact" onPress={() => compactNow($, rt).then(() => undefined)} />
        <Button key="band-later" label="Later" onPress={() => update($, suggestionAtom, () => null).then(() => undefined)} />
      </Box>
    </Box>
  )
}

// ── Registration ────────────────────────────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  const rt = newRuntime({
    trimAboveChars: wholeNumber(options.trimAboveChars, 10_000),
    patterns: toolPatterns(typeof options.trimTools === 'string' ? options.trimTools : 'Bash,Grep,Glob,WebFetch,WebSearch,mcp__*'),
    suggestAt: wholeNumber(options.suggestAt, 55),
    idleMs: wholeNumber(options.idleSeconds, 45, 1) * 1_000,
    defaults: {
      autoCompact: options.autoCompact === true,
      trim: wholeNumber(options.trimAboveChars, 10_000) > 0,
      dedupe: options.dedupeReads !== false,
      carryOver: options.carryOver !== false,
    },
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'ctx', description: 'Context fill, what fills it, the tokens context-optimizer saved, and a /compact at the right moment', argumentHint: '[compact]' })
    await hubHello($, { version: VERSION, publishes: ['context.pressure', 'x.context-optimizer.saved'], consumes: ['context.pressure', 'decision.recorded'] }, TAB)
    rt.root = e.cwd
    $.clock.after(0, () => void detectOutputTrimmer($, rt).catch(() => undefined))
    return next(e)
  })
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await resetSession($, rt)
    return next(e)
  })

  on('command.run', { command: 'ctx' }, async ($, e) => ({ text: await runCommand($, rt, e.args, e.origin) }))

  on('turn.start', ($, e, next) => {
    rt.turn += 1
    rt.milestone = undefined
    rt.isTodoListDone = false
    return next(e)
  })
  on('prompt.submit', async ($, e, next) => onPrompt($, rt, e, next)).catch(($, e, next) => next(e))
  on('tool.call', async ($, e, next) => observeCall($, rt, e, next)).catch(($, e, next) => next(e))
  on('session.append', { door: 'tool-result' }, async ($, e, next) => rewriteResults($, rt, e, next)).catch(($, e, next) => next(e))
  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined) {
      const isAnswer = e.reason === 'answer' && e.isAborted !== true
      $.clock.after(0, () => void onTurnComplete($, rt, isAnswer).catch(() => undefined))
    }
    return ran
  })
  on('session.measure', ($, e, next) => {
    if (e.context.percent !== undefined) $.clock.after(0, () => void notePressure($, rt, e.context).catch(() => undefined))
    return next(e)
  })
  on('session.compact', async ($, e, next) => onCompact($, rt, e, next)).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => drawBand($, e, next, rt))
  on('ui.render', { component: 'Pane', requestId: HUB_PANE }, async ($, e, next) => {
    if (!(await hubTabIs($, TAB.id))) return next(e)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {await next(e)}
        {await drawBody($, e, rt)}
      </Box>
    )
  })
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawBody($, e, rt))
}

// #region @vendored shared/hub-client.ts sha256:3ade61508f36: edit the source, then run `node scripts/sync-shared.mjs`.
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

/** Routes a notification through the hub (channels, silent, night, presence), or shows a toast when there is no hub. */
async function hubNotify($: EngineInterface, input: Parameters<HubMods['notify']>[0]): Promise<void> {
  try {
    await $.mods.notify(input)
  } catch {
    $.ui.toast(input.body === undefined || input.body === '' ? input.title : `${input.title} — ${input.body}`)
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

/** Whether the shared panel shows tab `id` now; read while drawing, it subscribes the drawing. */
async function hubTabIs($: EngineInterface, id: string): Promise<boolean> {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
  return value === id
}
// #endregion @vendored shared/hub-client.ts
