import type { ToolTimelineCall } from '../types'

/** The input fields that say what a call is about, in the order they are tried. */
const SUMMARY_KEYS = ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'skill', 'description', 'prompt', 'subject', 'name']
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
const FULL = '█'
const SUMMARY_MAX = 200
/** Durations under this read as an empty bar; the log scale starts here. */
const BAR_FLOOR_MS = 10

/** The call's input in a few words: a command's first line, a path relative to `root`, a pattern and where. */
export const summarize = (input: Readonly<Record<string, unknown>>, root: string): string => {
  const key = SUMMARY_KEYS.find(name => typeof input[name] === 'string' && input[name] !== '')
  if (key === undefined) return ''
  const shorten = (path: string) => (root !== '' && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path)
  let text = String(input[key])
  if (key === 'file_path' || key === 'notebook_path') text = shorten(text)
  if (key === 'pattern' && typeof input.path === 'string') text = `${text} in ${shorten(input.path) || '.'}`
  const line = (text.split('\n')[0] ?? '').replace(/\s+/g, ' ').trim()
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line
}

/** `mcp__github__get_file` → `github:get_file`; a built-in tool keeps its name. */
export const toolLabel = (tool: string): string => {
  const parts = tool.split('__')
  return parts.length >= 3 && parts[0] === 'mcp' ? `${parts[1]}:${parts.slice(2).join('__')}` : tool
}

/** `850ms`, `1.2s`, `14s`, `2m05s`. */
export const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
}

/** Time since the timeline began: `+04:12`, or `+1:02:03` past an hour. */
export const formatOffset = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
  const seconds = String(total % 60).padStart(2, '0')
  return hours > 0 ? `+${hours}:${minutes}:${seconds}` : `+${minutes}:${seconds}`
}

/**
 * A bar `width` cells wide at most, in eighths of a cell, log-scaled so a
 * 100ms read and a 3-minute build both show.
 */
export const durationBar = (ms: number, longestMs: number, width: number): string => {
  if (ms < BAR_FLOOR_MS || longestMs < BAR_FLOOR_MS) return ''
  const scale = Math.log10(ms / BAR_FLOOR_MS + 1) / Math.log10(longestMs / BAR_FLOOR_MS + 1)
  const eighths = Math.max(1, Math.round(Math.min(1, scale) * width * 8))
  return FULL.repeat(Math.floor(eighths / 8)) + (EIGHTHS[eighths % 8] ?? '')
}

export const durationOf = (call: ToolTimelineCall): number | null =>
  call.endedAt === null ? null : call.endedAt - call.startedAt

/** Fits `text` into `width` cells, padding or cutting it with an ellipsis. */
export const fit = (text: string, width: number): string =>
  text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width)

/** A turn that ended, as the hub's `turn.finished` tells it. */
export type TurnMark = { at: number; durationMs: number; tools: number; isAborted: boolean }

/** The `turn.finished` events in the hub's feed, as marks; anything else in the feed, or a payload of another shape, is skipped. */
export const turnMarksOf = (feed: readonly { topic: string; at: number; data: unknown }[]): TurnMark[] =>
  feed.flatMap(({ topic, at, data }) => {
    if (topic !== 'turn.finished' || typeof data !== 'object' || data === null) return []
    const { durationMs, tools, isAborted } = data as { durationMs?: unknown; tools?: unknown; isAborted?: unknown }
    return typeof durationMs === 'number' && typeof tools === 'number' ? [{ at, durationMs, tools, isAborted: isAborted === true }] : []
  })

/**
 * Where each turn ended on the timeline: the id of the last call that began before the turn finished and after the
 * previous turn's end. A turn that made no calls leaves no mark.
 */
export const turnEnds = (calls: readonly ToolTimelineCall[], marks: readonly TurnMark[]): Map<string, TurnMark> => {
  const ends = new Map<string, TurnMark>()
  let after = -1
  for (const mark of [...marks].sort((a, b) => a.at - b.at)) {
    let last = -1
    calls.forEach((call, index) => {
      if (call.startedAt <= mark.at) last = index
    })
    const call = calls[last]
    if (call !== undefined && last > after) {
      ends.set(call.id, mark)
      after = last
    }
  }
  return ends
}

/** `turn · 12 tools · 2m05s`, `· interrupted` when it was stopped. */
export const describeTurn = ({ tools, durationMs, isAborted }: TurnMark): string =>
  `turn · ${tools} tool${tools === 1 ? '' : 's'} · ${formatDuration(durationMs)}${isAborted ? ' · interrupted' : ''}`
