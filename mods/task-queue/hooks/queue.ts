// Pure parts of the queue: reading /queue arguments, reordering, and the words shown. No `$` here.

import type { QueueFinished, QueueItem, QueueView } from '../types'

export type QueueCommand =
  | { kind: 'open' }
  | { kind: 'list' }
  | { kind: 'add'; text: string }
  | { kind: 'remove'; position: number }
  | { kind: 'clear' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'usage'; why: string }

export const EMPTY_VIEW: QueueView = { items: [], isPaused: false, pauseReason: '', running: null, recent: [], streak: 0 }

const LIST_LABEL = 72

/**
 * `/queue` arguments as a command. A bare word (list, clear, pause, resume) is a subcommand only on its own,
 * so `/queue clear the cache and rebuild` queues that prompt; anything that is no subcommand is queued as typed.
 */
export function parseQueueArgs(args: string): QueueCommand {
  const text = args.trim()
  if (text === '') return { kind: 'open' }
  const word = text.toLowerCase()
  if (word === 'list' || word === 'ls') return { kind: 'list' }
  if (word === 'clear') return { kind: 'clear' }
  if (word === 'pause' || word === 'stop') return { kind: 'pause' }
  if (word === 'resume' || word === 'start' || word === 'run') return { kind: 'resume' }
  if (word === 'add') return { kind: 'usage', why: 'nothing to queue: /queue add <prompt>' }

  const removal = /^(?:remove|rm|delete|del)(?:\s+#?(\S+))?$/i.exec(text)
  if (removal !== null) {
    const position = Number(removal[1])
    return Number.isInteger(position) && position >= 1
      ? { kind: 'remove', position }
      : { kind: 'usage', why: 'which one? /queue remove <n>, n as /queue list numbers them' }
  }

  const added = /^add\s+([\s\S]+)$/i.exec(text)
  return { kind: 'add', text: (added?.[1] ?? text).trim() }
}

/** `items` with the one at `index` moved by `by` places, kept inside the list. */
export function moveItem(items: readonly QueueItem[], index: number, by: number): QueueItem[] {
  const target = Math.max(0, Math.min(items.length - 1, index + by))
  if (index < 0 || index >= items.length || target === index) return [...items]
  const moved = [...items]
  const [item] = moved.splice(index, 1)
  if (item !== undefined) moved.splice(target, 0, item)
  return moved
}

/** One line of a prompt, cut to `width` characters. */
export function oneLine(text: string, width = LIST_LABEL): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > width ? `${line.slice(0, Math.max(1, width - 1))}…` : line
}

/** The status line: `⏭ queue 3`, `▶ queue · 2 waiting`, `⏸ queue 3 paused`; undefined when there is nothing to say. */
export function statusText(view: QueueView): string | undefined {
  const waiting = view.items.length
  if (view.running !== null) return waiting > 0 ? `▶ queue · ${waiting} waiting` : '▶ queue · last one'
  if (waiting === 0) return undefined
  return view.isPaused ? `⏸ queue ${waiting} paused` : `⏭ queue ${waiting}`
}

/** `/queue list` as text. */
export function listText(view: QueueView): string {
  const lines: string[] = []
  if (view.running !== null) lines.push(`▶ running: ${oneLine(view.running.text)}`)
  view.items.forEach((item, index) => lines.push(`${index + 1}. ${oneLine(item.text)}`))
  if (lines.length === 0) return 'The queue is empty. Add a prompt with /queue <prompt>.'
  const head = view.isPaused ? `⏸ paused${view.pauseReason ? `: ${view.pauseReason}` : ''} · /queue resume` : `⏭ ${view.items.length} waiting`
  return [head, ...lines].join('\n')
}

/** What the store keeps for a project: everything but the running prompt and the streak. */
export type StoredQueue = Pick<QueueView, 'items' | 'isPaused' | 'pauseReason' | 'recent'>

const OUTCOMES = new Set(['done', 'interrupted', 'failed', 'dropped'])

const isItem = (value: unknown): value is QueueItem => {
  const item = value as Partial<QueueItem> | null
  return typeof item === 'object' && item !== null && typeof item.id === 'string' && typeof item.text === 'string' && item.text.trim() !== ''
}

const isFinished = (value: unknown): value is QueueFinished => {
  const done = value as Partial<QueueFinished> | null
  return typeof done === 'object' && done !== null && typeof done.text === 'string' && OUTCOMES.has(String(done.outcome))
}

/** A stored queue read back defensively: whatever is malformed is left out. */
export function fromStore(value: unknown, limits: { items: number; recent: number }): StoredQueue {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  return {
    items: (Array.isArray(raw.items) ? raw.items.filter(isItem) : [])
      .slice(0, limits.items)
      .map(item => ({ id: item.id, text: item.text, addedAt: Number(item.addedAt) || 0 })),
    isPaused: raw.isPaused === true,
    pauseReason: typeof raw.pauseReason === 'string' ? raw.pauseReason : '',
    recent: (Array.isArray(raw.recent) ? raw.recent.filter(isFinished) : []).slice(0, limits.recent),
  }
}

/** Milliseconds as `45s`, `3m`, `1h 5m`. */
export function shortDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
