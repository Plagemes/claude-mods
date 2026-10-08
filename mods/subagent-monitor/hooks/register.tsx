import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register, Timer } from 'claude-code'

import type { AgentRow, AgentRowStatus } from '../types'
import { paneFailure } from './shared/render-safe'

const PANE = 'subagent-monitor'
const COMMAND = 'agents-live'
const POLL_MS = 2000
const MAX_LISTED = 40
const ACTIVITY_CHARS = 120
const DEFAULT_KEEP_FINISHED = 20
/** How long a freshly spawned agent may be missing from `$.agent.list()` before it counts as ended. */
const LIST_GRACE_MS = 10_000

const agents = atom({ plugin: 'subagent-monitor', key: 'agents' } as const, [])
const now = atom({ plugin: 'subagent-monitor', key: 'now' } as const, 0)

const LIVE: ReadonlySet<AgentRowStatus> = new Set(['pending', 'running', 'waiting', 'idle'])

const STATUS_LOOK: Record<AgentRowStatus, { glyph: string; color: string }> = {
  pending: { glyph: '○', color: 'inactive' },
  running: { glyph: '●', color: 'claude' },
  waiting: { glyph: '◔', color: 'warning' },
  idle: { glyph: '◌', color: 'suggestion' },
  completed: { glyph: '✓', color: 'success' },
  failed: { glyph: '✗', color: 'error' },
  killed: { glyph: '■', color: 'inactive' },
  ended: { glyph: '✓', color: 'inactive' },
}

/** Input fields that best describe a tool call, most telling first. */
const SUMMARY_FIELDS = ['command', 'file_path', 'pattern', 'url', 'query', 'description', 'path', 'skill']

const isLive = (row: AgentRow): boolean => LIVE.has(row.status)

const summarizeCall = (tool: string, input: Readonly<Record<string, unknown>>): string => {
  const field = SUMMARY_FIELDS.map(name => input[name]).find(value => typeof value === 'string' && value !== '')
  const detail = typeof field === 'string' ? ` ${field.replace(/\s+/g, ' ').trim()}` : ''
  return `${tool}${detail}`.slice(0, ACTIVITY_CHARS)
}

const formatDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

const formatTokens = (tokens: number): string =>
  tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(1)}M`
    : tokens >= 1000
      ? `${(tokens / 1000).toFixed(1)}k`
      : String(tokens)

const fit = (text: string, width: number): string =>
  width <= 0 ? '' : text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`

const statusOfTurn = (reason: string): AgentRowStatus =>
  reason === 'answer' ? 'completed' : reason === 'aborted' ? 'killed' : 'failed'

/** Live agents first (newest first), then finished ones, newest first, capped. */
const ordered = (rows: readonly AgentRow[], keepFinished: number): AgentRow[] => {
  const newest = (a: AgentRow, b: AgentRow) => b.startedAt - a.startedAt
  const live = rows.filter(isLive).sort(newest)
  const finished = rows.filter(row => !isLive(row)).sort(newest).slice(0, keepFinished)
  return [...live, ...finished].slice(0, MAX_LISTED)
}

/** Folds the engine's list into the rows: new agents appear, statuses follow, vanished ones end. */
const mergeListed = (rows: readonly AgentRow[], listed: readonly AgentInfo[], at: number): AgentRow[] => {
  const seen = new Set(listed.map(agent => agent.id))
  const byId = new Map(rows.map(row => [row.id, row]))
  for (const agent of listed) {
    const previous = byId.get(agent.id)
    const status: AgentRowStatus = agent.status
    byId.set(agent.id, {
      ...(previous ?? { id: agent.id, startedAt: at, toolCount: 0 }),
      type: agent.type,
      description: agent.description || previous?.description || '',
      status,
      name: agent.name ?? previous?.name,
      endedAt: LIVE.has(status) ? undefined : (previous?.endedAt ?? at),
    })
  }
  const hasVanished = (row: AgentRow) => !seen.has(row.id) && isLive(row) && at - row.startedAt > LIST_GRACE_MS
  return [...byId.values()].map(row => (hasVanished(row) ? { ...row, status: 'ended', endedAt: at } : row))
}

const blankRow = (id: string, at: number): AgentRow => ({
  id,
  type: 'agent',
  description: '',
  status: 'running',
  startedAt: at,
  toolCount: 0,
})

// ── mods-hub: smart-router's routing, and finished agents on the bus ────────────────────────────────

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Says hello to mods-hub when it is installed. */
async function greetHub($: EngineInterface): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: ['agent.finished'], consumes: ['agent.routed'] })
}

/** The agents smart-router routed this session (its `agent.routed`), by agent id: their tier. Empty without the hub. */
async function routedTiers($: EngineInterface): Promise<Map<string, string>> {
  const tiers = new Map<string, string>()
  try {
    for (const event of await $.mods.recent({ topic: 'agent.routed', limit: 50 })) {
      const { agentId, tier } = event.data as { agentId?: unknown; tier?: unknown }
      if (typeof agentId === 'string' && typeof tier === 'string') tiers.set(agentId, tier)
    }
  } catch {
    // No hub: nothing was routed.
  }
  return tiers
}

/** Puts the routed tier on the rows that have one (the pane shows it). */
async function foldRoutes($: EngineInterface): Promise<Map<string, string>> {
  const tiers = await routedTiers($)
  if (tiers.size > 0) await change($, rows => rows.map(row => (tiers.has(row.id) && row.tier === undefined ? { ...row, tier: tiers.get(row.id) } : row)))
  return tiers
}

/**
 * A finished subagent on the hub's bus as `agent.finished` (workflow-studio, mission-control). An agent
 * smart-router routed is left out: the router reports it itself, with its cost.
 */
async function publishFinished($: EngineInterface, row: AgentRow, reason: string, at: number): Promise<void> {
  const tiers = await foldRoutes($)
  if (tiers.has(row.id)) return
  await hubPublish($, {
    topic: 'agent.finished',
    data: { agentType: row.type, outcome: reason === 'answer' ? 'ok' : 'failed', durationMs: Math.max(0, at - row.startedAt), agentId: row.id },
  })
}

const settings = { showStatus: true, keepFinished: DEFAULT_KEEP_FINISHED }
let poll: Timer | undefined
let hasResumed = false
/** The status line last set; null until the first set, so a reload always writes it once. */
let shownStatus: string | undefined | null = null

function showRunning($: EngineInterface, rows: readonly AgentRow[]): void {
  if (!settings.showStatus) return
  const running = rows.filter(isLive).length
  const text = running === 0 ? undefined : `◐ ${running} subagent${running === 1 ? '' : 's'} running · /${COMMAND}`
  if (text !== shownStatus) {
    shownStatus = text
    $.ui.status(text)
  }
}

async function change($: EngineInterface, fn: (rows: AgentRow[]) => AgentRow[]): Promise<AgentRow[]> {
  const rows = await update($, agents, fn)
  showRunning($, rows)
  return rows
}

async function isPaneOpen($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE)
}

function stopPolling(): void {
  poll?.cancel()
  poll = undefined
}

/** One poll: fold in `$.agent.list()`, tick the clock the durations read, stop when nobody watches. */
async function refresh($: EngineInterface): Promise<void> {
  try {
    const at = await $.clock.now()
    const listed = await $.agent.list()
    const rows = await change($, list => ordered(mergeListed(list, listed, at), settings.keepFinished))
    await update($, now, () => at)
    if (rows.some(row => row.tier === undefined)) await foldRoutes($)
    if (!rows.some(isLive) && !(await isPaneOpen($))) stopPolling()
  } catch (error) {
    $.ui.log(`subagent-monitor: poll failed: ${String(error)}`, { to: 'debug' })
  }
}

function startPolling($: EngineInterface): void {
  if (poll !== undefined) return
  poll = $.clock.every(POLL_MS, () => void refresh($))
  void refresh($)
}

/** After a hot reload the pane may still be open with no timer behind it: pick polling back up once. */
async function resume($: EngineInterface): Promise<void> {
  if (hasResumed) return
  hasResumed = true
  const rows = await read($, agents)
  if (rows.some(isLive) || (await isPaneOpen($))) startPolling($)
}

export const register: Register = (on, options) => {
  settings.showStatus = options.showStatus !== false
  settings.keepFinished =
    typeof options.keepFinished === 'number' && options.keepFinished >= 0
      ? Math.floor(options.keepFinished)
      : DEFAULT_KEEP_FINISHED

  on('session.start', async ($, e, next) => {
    hasResumed = true
    await registerCommand($, {
      name: COMMAND,
      description: 'Open a live pane of running subagents (type, status, duration, last activity)',
      argumentHint: '[close|clear]',
    })
    afterStart($, 'subagent-monitor', () => greetHub($))
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Pane closed.' }
    }
    if (arg === 'clear') {
      await change($, rows => rows.filter(isLive))
      return { text: 'Cleared finished subagents.' }
    }
    const opened = await $.ui.open({ id: PANE, title: 'Subagents' })
    startPolling($)
    return {
      text: opened.isPlaced
        ? 'Watching subagents live.'
        : `The pane waits for room (${opened.reason}).`,
    }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    const rows = await read($, agents)
    if (!rows.some(isLive)) stopPolling()
    return closed
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.deny !== undefined || spawned.agentId === undefined) return spawned
    const id = spawned.agentId
    const at = await $.clock.now()
    await change($, rows => [
      {
        ...blankRow(id, at),
        type: e.subagentType,
        description: e.description,
        model: spawned.model,
      },
      ...rows.filter(row => row.id !== id),
    ])
    hasResumed = true
    startPolling($)
    return spawned
  })

  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId === undefined) return next(e)
    const record = async () => {
      await resume($)
      const at = await $.clock.now()
      const activity = summarizeCall(e.tool, e as unknown as Readonly<Record<string, unknown>>)
      const touch = (row: AgentRow): AgentRow => ({
        ...row,
        lastActivity: activity,
        lastActivityAt: at,
        toolCount: row.toolCount + 1,
      })
      await change($, rows =>
        rows.some(row => row.id === agentId)
          ? rows.map(row => (row.id === agentId ? touch(row) : row))
          : [touch(blankRow(agentId, at)), ...rows],
      )
    }
    const [ran] = await Promise.all([next(e), record()])
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId === undefined) return next(e)
    const at = await $.clock.now()
    const usage = e.usage
    const tokens =
      usage === undefined
        ? undefined
        : usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
    const finished = (await read($, agents)).find(row => row.id === agentId)
    await change($, rows =>
      rows.map(row =>
        row.id === agentId
          ? {
              ...row,
              status: statusOfTurn(e.reason),
              endedAt: at,
              tokens: tokens === undefined ? row.tokens : (row.tokens ?? 0) + tokens,
              lastActivityAt: at,
              lastActivity: row.lastActivity ?? (e.reason === 'answer' ? 'answered' : `ended: ${e.reason}`),
            }
          : row,
      ),
    )
    if (finished !== undefined) {
      const reason = e.reason
      $.clock.after(0, () => void publishFinished($, finished, reason, at))
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const rows = await read($, agents)
    const at = Math.max(await read($, now), ...rows.map(row => row.lastActivityAt ?? row.startedAt))
    const width = Math.max(20, e.props.bodyColumns)
    const running = rows.filter(isLive).length
    const finished = rows.length - running

    const header = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>Subagents</Text>
        <Text dimColor>
          {running} running · {finished} finished
        </Text>
      </Box>
    )

    if (rows.length === 0) {
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor>No subagents yet. They show up here as soon as Claude delegates a task.</Text>
        </Box>
      )
    }

    const items = rows.map(row => {
      const look = STATUS_LOOK[row.status]
      const live = isLive(row)
      const right = `${row.status} ${formatDuration((row.endedAt ?? at) - row.startedAt)}`
      const head = row.name ?? row.type
      const roomLeft = width - right.length - 1
      const description = row.description === '' ? '' : ` · ${row.description}`
      const title = fit(`${head}${description}`, roomLeft - 2)
      const counts = [
        row.tier,
        `${row.toolCount} tool${row.toolCount === 1 ? '' : 's'}`,
        row.tokens === undefined ? undefined : `${formatTokens(row.tokens)} tok`,
      ]
        .filter(fact => fact !== undefined)
        .join(' · ')
      const ago = row.lastActivityAt === undefined ? '' : ` (${formatDuration(at - row.lastActivityAt)} ago)`
      const activity = fit(`  ↳ ${row.lastActivity ?? 'starting…'}${ago}`, width - counts.length - 1)
      return (
        <Box key={`agent:${row.id}`} flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Text wrap="truncate-end">
              <Text color={look.color}>{look.glyph} </Text>
              <Text bold>{title.slice(0, head.length)}</Text>
              <Text>{title.slice(head.length)}</Text>
            </Text>
            <Text color={live ? look.color : undefined} dimColor={!live}>
              {right}
            </Text>
          </Box>
          <Box flexDirection="row" justifyContent="space-between">
            <Text dimColor wrap="truncate-end">
              {activity}
            </Text>
            <Text dimColor>{counts}</Text>
          </Box>
        </Box>
      )
    })

    return (
      <Box flexDirection="column">
        {header}
        <Box flexDirection="column" marginTop={1} gap={1}>
          {items}
        </Box>
        <Box flexDirection="row" gap={1} marginTop={1}>
          {finished > 0 && (
            <Button key="clear" hotkey="c" onPress={() => void change($, list => list.filter(isLive))}>
              Clear finished
            </Button>
          )}
          <Button key="close" role="dismiss" hotkey="x" onPress={() => void $.ui.close({ id: PANE })}>
            Close
          </Button>
        </Box>
      </Box>
    )
  }).catch(async ($, e, next) =>
    next.error.kind === 're-entry'
      ? next(e)
      : paneFailure($.ui.resolve(e), { title: 'subagent-monitor', failure: next.error, below: await next(e).catch(() => null), onRetry: () => $.ui.invalidate('ui.render') }),
  )
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
