import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ToolTimelineCall, ToolTimelineOutcome } from '../types'
import { durationBar, durationOf, fit, formatDuration, formatOffset, summarize, toolLabel } from './format'

const PANE = 'timeline'
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    root = e.cwd
    await $.command.register({ name: COMMAND, description: 'Show every tool call of the session on a timeline' })
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

  on('command.run', { command: COMMAND }, async $ => {
    await $.ui.open({ id: PANE, title: 'Timeline' })
    await followNewest($)
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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
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
            <Button key="latest" label="Latest" hotkey="l" onPress={() => void followNewest($)} />
            <Button key="clear" label="Clear" hotkey="c" onPress={() => void update($, calls, () => [])} />
          </Box>
        </Box>
        {shown.length === 0 && <Text dimColor>{errorsOnly ? 'No failed calls.' : 'No tool calls yet.'}</Text>}
        {shown.map(call => {
          const duration = durationOf(call)
          return (
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
        })}
      </Box>
    )
  })
}

/**
 * Scrolls the pane to its newest row. The engine keeps an `end` scroll there
 * as rows are added, until the person scrolls away.
 */
const followNewest = async ($: EngineInterface): Promise<void> => {
  await $.ui.scroll({ in: PANE, to: 'end' }).catch(() => undefined)
}
