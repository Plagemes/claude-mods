import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallInput } from 'claude-code'

import type { SessionStatsData } from '../types'
import { EMPTY_STATS, bar, compact, fit, formatCost, formatDuration, toolLabel, topTools } from './format'

const PANE = 'session-stats'
const DESCRIPTION = 'Show a dashboard of this session: turns, tools, tokens, cost, time and files'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const TOP_TOOLS = 5
const NAME_WIDTH = 16
const MIN_TILE_WIDTH = 20
const MAX_TILE_WIDTH = 30
const TILES_PER_ROW = 3

const stats = atom({ plugin: 'session-stats', key: 'stats' } as const, EMPTY_STATS)

type Tile = { title: string; value: string; details: string[] }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Claude Code 2.1 ships /stats as an alias of its own /usage and refuses the name;
    // /session-stats always registers, and /stats is claimed wherever it is free.
    await $.command.register({ name: 'stats', description: DESCRIPTION }).catch(() => undefined)
    await $.command.register({ name: 'session-stats', description: DESCRIPTION }).catch(() => undefined)
    await takeSnapshot($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, stats, () => EMPTY_STATS)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)
    if (entered.drop === undefined) await update($, stats, value => ({ ...value, prompts: value.prompts + 1 }))
    return entered
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran

    const tool = String(e.tool)
    const isFailed = ran.isError === true
    const edited = isFailed || !EDIT_TOOLS.has(tool) ? undefined : editedPath(e)
    await update($, stats, value => ({
      ...value,
      tools: { ...value.tools, [tool]: (value.tools[tool] ?? 0) + 1 },
      toolErrors: value.toolErrors + (isFailed ? 1 : 0),
      filesEdited:
        edited === undefined || value.filesEdited.includes(edited) ? value.filesEdited : [...value.filesEdited, edited],
    }))
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const usage = e.usage ?? done.usage
    const isMain = e.agentId === undefined
    await update($, stats, value => ({
      ...value,
      turns: value.turns + (isMain ? 1 : 0),
      busyMs: value.busyMs + (isMain ? e.durationMs : 0),
      tokens:
        usage === undefined
          ? value.tokens
          : {
              input: value.tokens.input + usage.input_tokens,
              output: value.tokens.output + usage.output_tokens,
              cacheRead: value.tokens.cacheRead + usage.cache_read_input_tokens,
              cacheWrite: value.tokens.cacheWrite + usage.cache_creation_input_tokens,
            },
    }))
    if (isMain) await takeSnapshot($)
    return done
  })

  on('command.run', { command: ['stats', 'session-stats'] }, async $ => {
    await takeSnapshot($)
    await $.ui.open({ id: PANE, title: 'Session stats' })
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const current = await read($, stats)
    const columns = e.props.bodyColumns
    const tileWidth = Math.max(MIN_TILE_WIDTH, Math.min(MAX_TILE_WIDTH, Math.floor((columns - TILES_PER_ROW + 1) / TILES_PER_ROW)))
    const top = topTools(current.tools, TOP_TOOLS)
    const most = top[0]?.[1] ?? 0
    const barWidth = Math.max(8, columns - NAME_WIDTH - 10)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {tilesOf(current).map(tile => (
            <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} width={tileWidth}>
              <Text dimColor>{tile.title}</Text>
              <Text bold>{tile.value}</Text>
              {tile.details.map(detail => (
                <Text dimColor wrap="truncate-end">
                  {detail}
                </Text>
              ))}
            </Box>
          ))}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Top tools</Text>
          {top.length === 0 && <Text dimColor>No tool calls yet.</Text>}
          {top.map(([tool, count]) => (
            <Box flexDirection="row" gap={1}>
              <Text>{fit(toolLabel(tool), NAME_WIDTH)}</Text>
              <Text color="claude">{bar(count, most, barWidth)}</Text>
              <Text dimColor>{count}</Text>
            </Box>
          ))}
        </Box>
        <Box flexDirection="row" marginTop={1}>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => void takeSnapshot($)} />
        </Box>
      </Box>
    )
  })
}

/** The dashboard's tiles, in reading order. */
const tilesOf = (current: SessionStatsData): Tile[] => {
  const calls = Object.values(current.tools).reduce((sum, count) => sum + count, 0)
  const { input, output, cacheRead, cacheWrite } = current.tokens
  const wallMs = current.startedAt === null || current.takenAt === null ? 0 : current.takenAt - current.startedAt
  const lastEdited = current.filesEdited.at(-1)
  return [
    {
      title: 'Turns',
      value: String(current.turns),
      details: [`${current.prompts} ${current.prompts === 1 ? 'prompt' : 'prompts'}`],
    },
    {
      title: 'Tool calls',
      value: String(calls),
      details: [current.toolErrors === 0 ? 'none failed' : `${current.toolErrors} failed`],
    },
    {
      title: 'Tokens',
      value: compact(input + output + cacheRead + cacheWrite),
      details: [`in ${compact(input)} · out ${compact(output)}`, `cache ${compact(cacheRead)} read · ${compact(cacheWrite)} new`],
    },
    { title: 'Cost', value: formatCost(current.costUsd), details: ['as /usage counts it'] },
    { title: 'Wall time', value: formatDuration(wallMs), details: [`${formatDuration(current.busyMs)} in turns`] },
    {
      title: 'Files edited',
      value: String(current.filesEdited.length),
      details: [lastEdited === undefined ? 'none yet' : `last ${lastEdited.slice(lastEdited.lastIndexOf('/') + 1)}`],
    },
  ]
}

/** Takes the figures only the engine has (cost, the session's start) and the time they were taken. */
const takeSnapshot = async ($: EngineInterface): Promise<void> => {
  const usage = await $.session.usage().catch(() => undefined)
  const now = await $.clock.now()
  await update($, stats, value => ({
    ...value,
    costUsd: usage?.cost?.usd ?? value.costUsd,
    startedAt: usage?.startedAt ?? value.startedAt ?? now,
    takenAt: now,
  }))
}

const editedPath = (e: ToolCallInput): string | undefined => {
  const input: Readonly<Record<string, unknown>> = e
  const path = input.file_path ?? input.notebook_path
  return typeof path === 'string' && path !== '' ? path : undefined
}
