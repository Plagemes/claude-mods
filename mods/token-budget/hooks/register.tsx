import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, StateDollar } from 'claude-code'

import type { TokenBudgetLevel, TokenBudgetLimits, TokenBudgetSpend } from '../types'
import { costOf, freshTokensOf } from './shared/prices'

const NAME = 'token-budget'
const OVERRIDE = /^\s*!override\b\s*/i
const AMOUNT = /^(\$)?\s*(\d+(?:\.\d+)?)\s*([km])?\s*(\$|usd|dollars?|tok|tokens?)?$/i
const DEFAULT_BUDGET_USD = 10
const DEFAULT_WARN_AT = 80
const RAISE_FACTOR = 1.5
const BAR_CELLS = 16
/** Below this many columns the band leaves out its bar. */
const BAR_MIN_COLUMNS = 70
const TOAST_MS = 8000
const RANK: Record<TokenBudgetLevel, number> = { ok: 0, warn: 1, over: 2 }
const NOTHING_SPENT: TokenBudgetSpend = { usd: 0, tokens: 0, turns: 0 }

const spend = atom({ plugin: 'token-budget', key: 'spend' } as const, NOTHING_SPENT)
const sessionLimits = atom({ plugin: 'token-budget', key: 'limits' } as const, null)
const announced = atom({ plugin: 'token-budget', key: 'announced' } as const, 'ok')
const isBandHidden = atom({ plugin: 'token-budget', key: 'isBandHidden' } as const, false)

type Command =
  | { kind: 'status' }
  | { kind: 'reset' }
  | { kind: 'off' }
  | { kind: 'set'; unit: keyof TokenBudgetLimits; amount: number }
  | { kind: 'invalid'; text: string }

const positiveOrNull = (value: unknown, fallback: number): number | null => {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback

  return n > 0 ? n : null
}

const dollars = (n: number): string => `$${n.toFixed(2)}`

const tokens = (n: number): string =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : `${Math.round(n)}`

const hasLimit = (limits: TokenBudgetLimits): boolean => limits.usd !== null || limits.tokens !== null

/** The larger of the two shares spent, 1 meaning a limit is reached. */
const shareUsed = (spent: TokenBudgetSpend, limits: TokenBudgetLimits): number =>
  Math.max(
    limits.usd === null ? 0 : spent.usd / limits.usd,
    limits.tokens === null ? 0 : spent.tokens / limits.tokens,
  )

const describeSpend = (spent: TokenBudgetSpend, limits: TokenBudgetLimits): string =>
  [
    limits.usd === null ? dollars(spent.usd) : `${dollars(spent.usd)} of ${dollars(limits.usd)}`,
    limits.tokens === null ? `${tokens(spent.tokens)} tokens` : `${tokens(spent.tokens)} of ${tokens(limits.tokens)} tokens`,
  ].join(' · ')

const describeLeft = (spent: TokenBudgetSpend, limits: TokenBudgetLimits): string =>
  [
    limits.usd === null ? undefined : `${dollars(Math.max(0, limits.usd - spent.usd))} left of ${dollars(limits.usd)}`,
    limits.tokens === null
      ? undefined
      : `${tokens(Math.max(0, limits.tokens - spent.tokens))} of ${tokens(limits.tokens)} tokens left`,
  ]
    .filter(part => part !== undefined)
    .join(' · ')

const parseAmount = (text: string): Command => {
  const match = AMOUNT.exec(text.trim())
  const [, dollarSign, digits, multiplier, unit] = match ?? []
  const value = Number(digits) * (multiplier?.toLowerCase() === 'm' ? 1_000_000 : multiplier ? 1_000 : 1)

  if (match === null || !(value > 0)) {
    return { kind: 'invalid', text: `"${text.trim()}" is not an amount. Try /budget set 5 or /budget set 2M tokens.` }
  }

  const isTokens = unit?.toLowerCase().startsWith('tok') ?? (multiplier !== undefined && dollarSign === undefined)

  return isTokens ? { kind: 'set', unit: 'tokens', amount: Math.round(value) } : { kind: 'set', unit: 'usd', amount: value }
}

const parseCommand = (args: string): Command => {
  const [verb = '', ...rest] = args.trim().split(/\s+/)
  const word = verb.toLowerCase()

  if (word === '' || word === 'status') return { kind: 'status' }
  if (word === 'reset') return { kind: 'reset' }
  if (word === 'off' || (word === 'set' && rest.join(' ').toLowerCase() === 'off')) return { kind: 'off' }

  return parseAmount(word === 'set' ? rest.join(' ') : args)
}

type Settings = { configured: TokenBudgetLimits; warnShare: number }

const levelOf = (share: number, warnShare: number): TokenBudgetLevel =>
  share >= 1 ? 'over' : share >= warnShare ? 'warn' : 'ok'

const statusText = (spent: TokenBudgetSpend, limits: TokenBudgetLimits): string => {
  if (!hasLimit(limits)) {
    return `No budget this session (${describeSpend(spent, limits)} spent). Set one with /budget set 5 or /budget set 2M tokens.`
  }

  const share = shareUsed(spent, limits)
  const lines = [`${Math.round(share * 100)}% used · ${describeSpend(spent, limits)} · ${spent.turns} turns`]
  if (share >= 1) lines.push('New prompts are paused: prefix one with !override, or raise the budget with /budget set <amount>.')

  return lines.join('\n')
}

async function limitsNow($: StateDollar, settings: Settings): Promise<TokenBudgetLimits> {
  return (await read($, sessionLimits)) ?? settings.configured
}

/** Sets this session's limits and re-arms the warnings for them. */
async function setLimits($: StateDollar, limits: TokenBudgetLimits, settings: Settings): Promise<void> {
  await update($, sessionLimits, () => limits)
  const spent = await read($, spend)
  await update($, announced, () => levelOf(shareUsed(spent, limits), settings.warnShare))
  await update($, isBandHidden, () => false)
}

/** Raises every limit in force by half, from whichever is higher: the limit or the spend. */
async function raiseLimits($: StateDollar, settings: Settings): Promise<void> {
  const spent = await read($, spend)
  const limits = await limitsNow($, settings)
  await setLimits(
    $,
    {
      usd: limits.usd === null ? null : Math.max(limits.usd, spent.usd) * RAISE_FACTOR,
      tokens: limits.tokens === null ? null : Math.round(Math.max(limits.tokens, spent.tokens) * RAISE_FACTOR),
    },
    settings,
  )
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

/** Says hello to mods-hub when it is installed, and puts the budget on its blackboard. */
async function greetHub($: EngineInterface, settings: Settings): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: ['budget.threshold'], consumes: [] })
  await shareStatus($, settings)
}

/** The fact `token-budget.status` other mods read (smart-router, autopilot); nothing happens without the hub. */
async function shareStatus($: EngineInterface, settings: Settings): Promise<void> {
  const spent = await read($, spend)
  const limits = await limitsNow($, settings)
  const share = shareUsed(spent, limits)
  try {
    await $.mods.share({
      name: 'status',
      value: { level: levelOf(share, settings.warnShare), percent: Math.round(share * 100), usd: spent.usd, tokens: spent.tokens, turns: spent.turns, limits },
    })
  } catch {
    // No hub: the band and /budget say it all.
  }
}

/** The unit closest to its limit, as budget.threshold names it. */
const thresholdOf = (spent: TokenBudgetSpend, limits: TokenBudgetLimits) => {
  const usdShare = limits.usd === null ? -1 : spent.usd / limits.usd
  const tokenShare = limits.tokens === null ? -1 : spent.tokens / limits.tokens
  return usdShare >= tokenShare && limits.usd !== null
    ? { kind: 'usd' as const, scope: 'session' as const, used: spent.usd, limit: limits.usd, percent: Math.round(usdShare * 100) }
    : { kind: 'tokens' as const, scope: 'session' as const, used: spent.tokens, limit: limits.tokens ?? 0, percent: Math.round(tokenShare * 100) }
}

/**
 * A threshold crossed: published on the hub's bus as `budget.threshold`, and announced through the hub's
 * notifications (warning at the warning line, critical at 100%), or with this mod's own toast without the hub.
 */
async function announce($: EngineInterface, level: TokenBudgetLevel, spent: TokenBudgetSpend, limits: TokenBudgetLimits): Promise<void> {
  const share = shareUsed(spent, limits)
  const toast =
    level === 'over'
      ? `Budget reached (${describeSpend(spent, limits)}). New prompts are paused; prefix one with !override to go on.`
      : `${Math.round(share * 100)}% of the budget used · ${describeLeft(spent, limits)}`
  await hubPublish($, { topic: 'budget.threshold', data: thresholdOf(spent, limits) })
  try {
    await $.mods.notify(
      level === 'over'
        ? { level: 'critical', title: 'Session budget reached: prompts are paused', body: `${describeSpend(spent, limits)}. Prefix a prompt with !override to go on, or raise it with /budget set.`, topic: 'budget.threshold' }
        : { level: 'warning', title: `${Math.round(share * 100)}% of the session budget used`, body: describeLeft(spent, limits), topic: 'budget.threshold' },
    )
  } catch {
    $.ui.toast(toast, { timeoutMs: TOAST_MS })
  }
}

/** `/budget [status | set <amount> | off | reset]`. */
async function runBudget($: EngineInterface, args: string, settings: Settings): Promise<{ text: string }> {
  const command = parseCommand(args)
  const limits = await limitsNow($, settings)

  switch (command.kind) {
    case 'invalid':
      return { text: command.text }
    case 'status':
      return { text: statusText(await read($, spend), limits) }
    case 'off':
      await setLimits($, { usd: null, tokens: null }, settings)
      return { text: 'No budget for the rest of this session.' }
    case 'reset':
      await update($, spend, () => NOTHING_SPENT)
      await setLimits($, limits, settings)
      return { text: 'Spending counter reset to zero.' }
    case 'set': {
      const changed = { ...limits, [command.unit]: command.amount }
      await setLimits($, changed, settings)
      return { text: statusText(await read($, spend), changed) }
    }
  }
}

export const register: Register = (on, options: PluginOptions) => {
  const settings: Settings = {
    configured: {
      usd: positiveOrNull(options.budgetUsd, DEFAULT_BUDGET_USD),
      tokens: positiveOrNull(options.budgetTokens, 0),
    },
    warnShare: Math.min(99, Math.max(1, positiveOrNull(options.warnAt, DEFAULT_WARN_AT) ?? DEFAULT_WARN_AT)) / 100,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'budget',
      description: "Show or change this session's dollar and token budget",
      argumentHint: '[set <$ | tokens> | off | reset]',
      immediate: true,
    })
    await greetHub($, settings)

    return next(e)
  })

  on('command.run', { command: 'budget' }, async ($, e) => {
    const ran = await runBudget($, e.args, settings)
    await shareStatus($, settings)

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const usage = e.usage

    if (usage !== undefined) {
      const spent = await update($, spend, before => ({
        usd: before.usd + costOf(usage, usage.model).usd,
        tokens: before.tokens + freshTokensOf(usage),
        turns: before.turns + (e.agentId === undefined ? 1 : 0),
      }))
      const limits = await limitsNow($, settings)
      const share = shareUsed(spent, limits)
      const level = levelOf(share, settings.warnShare)

      if (RANK[level] > RANK[await read($, announced)]) {
        await update($, announced, () => level)
        await update($, isBandHidden, () => false)
        await announce($, level, spent, limits)
      }
      await shareStatus($, settings)
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const override = OVERRIDE.exec(e.text)

    if (override !== null) {
      const text = e.text.slice(override[0].length)

      return text.trim() === '' ? { drop: `${NAME}: write the prompt after !override.` } : next({ ...e, text })
    }

    const spent = await read($, spend)
    const limits = await limitsNow($, settings)

    if (shareUsed(spent, limits) < 1) return next(e)

    return {
      drop: `${NAME}: the session budget is spent (${describeSpend(spent, limits)}). Prefix the prompt with !override to send it anyway, or raise the budget with /budget set <amount>.`,
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isBandHidden))) return next(e)

    const spent = await read($, spend)
    const limits = await limitsNow($, settings)
    const share = shareUsed(spent, limits)
    const level = levelOf(share, settings.warnShare)

    if (level === 'ok') return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const isOver = level === 'over'
    const color = isOver ? 'error' : 'warning'
    const filled = Math.min(BAR_CELLS, Math.round(share * BAR_CELLS))
    // Other plugins' bands draw beneath this one rather than being replaced by it.
    const below = await next(e)

    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Text color={color} bold>
            {isOver ? '■ budget reached' : `▲ budget ${Math.round(share * 100)}%`}
          </Text>
          {e.props.bodyColumns >= BAR_MIN_COLUMNS && (
            <Box>
              <Text color={color}>{'█'.repeat(filled)}</Text>
              <Text dimColor>{'░'.repeat(BAR_CELLS - filled)}</Text>
            </Box>
          )}
          <Text dimColor wrap="truncate-end">
            {isOver ? describeSpend(spent, limits) : describeLeft(spent, limits)}
          </Text>
        </Box>
        <Box gap={1}>
          {isOver && <Text dimColor>Prompts paused · prefix one with !override</Text>}
          <Button key="raise" label="Raise 50%" hotkey="r" onPress={() => void raiseLimits($, settings)} />
          <Button key="hide" label="Hide" hotkey="h" onPress={() => void update($, isBandHidden, () => true)} />
        </Box>
        {below}
      </Box>
    )
  })
}

// #region @vendored shared/hub-client.ts sha256:0acb840d81b7: edit the source, then run `node scripts/sync-shared.mjs`.
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
// #endregion @vendored shared/hub-client.ts
