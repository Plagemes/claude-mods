import type { SessionStatsData } from '../types'

export const EMPTY_STATS: SessionStatsData = {
  prompts: 0,
  turns: 0,
  tools: {},
  toolErrors: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  filesEdited: [],
  costUsd: null,
  startedAt: null,
  takenAt: null,
  busyMs: 0,
}

/** `950`, `12.3k`, `4.1M`. */
export const compact = (count: number): string => {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`
  return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0)}M`
}

/** `42s`, `4m 05s`, `1h 12m`. */
export const formatDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** `$0.42`, `$12.30`; `—` when unknown. */
export const formatCost = (usd: number | null): string => (usd === null ? '—' : `$${usd.toFixed(2)}`)

/** The tools called most, most first, ties by name. */
export const topTools = (tools: Readonly<Record<string, number>>, limit: number): [string, number][] =>
  Object.entries(tools)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, limit)

/** A bar of `width` cells at most for `count` out of `max`, at least one cell for any call. */
export const bar = (count: number, max: number, width: number): string =>
  max <= 0 || count <= 0 ? '' : '█'.repeat(Math.max(1, Math.round((count / max) * width)))

/** `mcp__github__get_file` → `github:get_file`; a built-in tool keeps its name. */
export const toolLabel = (tool: string): string => {
  const parts = tool.split('__')
  return parts.length >= 3 && parts[0] === 'mcp' ? `${parts[1]}:${parts.slice(2).join('__')}` : tool
}

/** Fits `text` into `width` cells, padding or cutting it with an ellipsis. */
export const fit = (text: string, width: number): string =>
  text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width)
