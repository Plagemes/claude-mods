import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register, Timer } from 'claude-code'

import type { AgentRow, AgentRowStatus } from '../types'

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
    await $.command.register({
      name: COMMAND,
      description: 'Open a live pane of running subagents (type, status, duration, last activity)',
      argumentHint: '[close|clear]',
    })
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
  })
}
