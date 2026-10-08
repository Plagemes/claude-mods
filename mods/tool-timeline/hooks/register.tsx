import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput } from 'claude-code'

import type { ToolTimelineCall, ToolTimelineOutcome } from '../types'
import { describeTurn, durationBar, durationOf, fit, formatDuration, formatOffset, summarize, toolLabel, turnEnds, turnMarksOf } from './format'
import { hubTabBelow, paneFailure } from './shared/render-safe'

const PANE = 'timeline'
/** The hub's shared panel, and this mod's tab in it (order 270: after Tasks). */
const HUB_PANE = 'claude-mods'
const TAB = { id: 'timeline', title: 'Timeline', order: 270, command: 'timeline' } as const
const COMMAND = 'timeline'
const MAX_CALLS = 300
const COMPACT_COLUMNS = 64
const DURATION_WIDTH = 6

const GLYPHS: Record<ToolTimelineOutcome, string> = { running: '◌', ok: '✓', error: '✗', denied: '⊘' }
const COLORS: Record<ToolTimelineOutcome, string> = { running: 'warning', ok: 'success', error: 'error', denied: 'inactive' }

const calls = atom({ plugin: 'tool-timeline', key: 'calls' } as const, [])
const origin = atom({ plugin: 'tool-timeline', key: 'origin' } as const, null)
const isErrorsOnly = atom({ plugin: 'tool-timeline', key: 'isErrorsOnly' } as const, false)

let root: string | undefined

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** With mods-hub installed: hello (this mod reads `turn.finished`, to mark where each turn ended) and the Timeline tab in its panel. */
async function greetHub($: EngineInterface): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: ['turn.finished'] }, TAB)
}

/** The turns the hub saw end this session. Read while drawing, so the timeline redraws when one ends; empty without a hub. */
async function hubTurns($: EngineInterface) {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'feed' })
  return turnMarksOf(value ?? [])
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    root = e.cwd
    await registerCommand($, { name: COMMAND, description: 'Show every tool call of the session on a timeline' })
    afterStart($, 'tool-timeline', () => greetHub($))
    const now = await $.clock.now()
    await update($, origin, value => value ?? now)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      const now = await $.clock.now()
      await update($, calls, () => [])
      await update($, origin, () => now)
    }
    return next(e)
  })

  // `/timeline`: the Timeline tab of the hub's panel when the hub is installed, this mod's own pane otherwise.
  on('command.run', { command: COMMAND }, async $ => {
    const isTab = await hubShowTab($, TAB.id)
    if (!isTab) await $.ui.open({ id: PANE, title: 'Timeline' })
    await followNewest($, isTab ? HUB_PANE : PANE)
    return {}
  })

  on('tool.call', async ($, e, next) => {
    root ??= await $.session.cwd().catch(() => '')
    const startedAt = await $.clock.now()
    const call: ToolTimelineCall = {
      id: e.tool_use_id || crypto.randomUUID(),
      tool: String(e.tool),
      summary: summarize(e, root),
      startedAt,
      endedAt: null,
      outcome: 'running',
      ...(e.agentId === undefined ? {} : { agentId: e.agentId }),
    }
    await update($, origin, value => value ?? startedAt)
    await update($, calls, list => [...list, call].slice(-MAX_CALLS))

    let outcome: ToolTimelineOutcome = 'error'
    try {
      const ran = await next(e)
      outcome = ran.deny !== undefined ? 'denied' : ran.isError === true ? 'error' : 'ok'
      return ran
    } finally {
      const endedAt = await $.clock.now()
      await update($, calls, list => list.map(one => (one.id === call.id ? { ...one, endedAt, outcome } : one)))
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawTimeline($, e, false)).catch(async ($, e, next) =>
    next.error.kind === 're-entry'
      ? next(e)
      : paneFailure($.ui.resolve(e), { title: 'tool-timeline', failure: next.error, below: await next(e).catch(() => null), onRetry: () => $.ui.invalidate('ui.render') }),
  )

  // The Timeline tab: drawn beneath the hub's tab strip when it is the tab shown; any other tab passes through.
  on('ui.render', { component: 'Pane', requestId: HUB_PANE }, async ($, e, next) => {
    if (!(await hubTabIs($, TAB.id))) return next(e)
    const { Box } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {hubTabBelow(await next(e))}
        {await drawTimeline($, e, true)}
      </Box>
    )
  }).catch(async ($, e, next) =>
    next.error.kind === 're-entry'
      ? next(e)
      : paneFailure($.ui.resolve(e), { title: 'tool-timeline', failure: next.error, below: await next(e).catch(() => null), onRetry: () => $.ui.invalidate('ui.render') }),
  )
}

/** The timeline: this mod's own pane, or the Timeline tab of the hub's panel (`isTab`). */
async function drawTimeline($: EngineInterface, e: RenderInput<'Pane'>, isTab: boolean): Promise<RenderElement> {
  const { Box, Button, Text } = $.ui.resolve(e)
  const all = await read($, calls)
  const errorsOnly = await read($, isErrorsOnly)
  const start = (await read($, origin)) ?? all[0]?.startedAt ?? 0

  const shown = errorsOnly ? all.filter(call => call.outcome === 'error' || call.outcome === 'denied') : all
  const isCompact = e.props.bodyColumns < COMPACT_COLUMNS
  const barWidth = isCompact ? 6 : 12
  const toolWidth = isCompact ? 10 : 16
  const longest = Math.max(0, ...shown.map(call => durationOf(call) ?? 0))
  const failed = all.filter(call => call.outcome === 'error').length
  const running = all.filter(call => call.outcome === 'running').length
  const busyMs = all.reduce((sum, call) => sum + (durationOf(call) ?? 0), 0)
  // With the hub: where each turn ended, under its last call (left out while only failed calls are listed).
  const ends = isTab && !errorsOnly ? turnEnds(all, await hubTurns($)) : new Map()

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" marginBottom={1} gap={1}>
        <Box flexDirection="row" gap={2}>
          <Text bold>
            {all.length} {all.length === 1 ? 'call' : 'calls'}
          </Text>
          {failed > 0 && <Text color="error">{failed} failed</Text>}
          {running > 0 && <Text color="warning">{running} running</Text>}
          {!isCompact && <Text dimColor>{formatDuration(busyMs)} in tools</Text>}
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button
            key="filter"
            label={errorsOnly ? 'Show all' : 'Errors only'}
            hotkey="e"
            onPress={() => void update($, isErrorsOnly, value => !value)}
          />
          <Button key="latest" label="Latest" hotkey="l" onPress={() => void followNewest($, isTab ? HUB_PANE : PANE)} />
          <Button key="clear" label="Clear" hotkey="c" onPress={() => void update($, calls, () => [])} />
        </Box>
      </Box>
      {shown.length === 0 && <Text dimColor>{errorsOnly ? 'No failed calls.' : 'No tool calls yet.'}</Text>}
      {shown.map(call => {
        const duration = durationOf(call)
        const turn = ends.get(call.id)
        const row = (
          <Box flexDirection="row" gap={1}>
            {!isCompact && <Text dimColor>{formatOffset(call.startedAt - start)}</Text>}
            <Text color={COLORS[call.outcome]}>{GLYPHS[call.outcome]}</Text>
            <Text bold={call.outcome === 'running'}>{fit(toolLabel(call.tool), toolWidth)}</Text>
            <Text color={COLORS[call.outcome]}>{fit(durationBar(duration ?? 0, longest, barWidth), barWidth)}</Text>
            <Text dimColor>{(duration === null ? '…' : formatDuration(duration)).padStart(DURATION_WIDTH)}</Text>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-end">
                {call.agentId === undefined ? '' : '↳ '}
                {call.summary}
              </Text>
            </Box>
          </Box>
        )
        return turn === undefined ? (
          row
        ) : (
          <Box flexDirection="column">
            {row}
            <Box key={`turn:${call.id}`}>
              <Text dimColor>{`─── ${describeTurn(turn)}`}</Text>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

/**
 * Scrolls the pane to its newest row. The engine keeps an `end` scroll there
 * as rows are added, until the person scrolls away.
 */
const followNewest = async ($: EngineInterface, pane: string = PANE): Promise<void> => {
  await $.ui.scroll({ in: pane, to: 'end' }).catch(() => undefined)
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
