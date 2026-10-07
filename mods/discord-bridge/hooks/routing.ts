import type { BrSessionInfo } from '../types'

/** A session counts as live while its heartbeat is this fresh. */
export const LIVE_MS = 45_000

export type RouteInput = {
  text: string
  /** The `chatId:messageId` of the message this one replies to. */
  repliedTo?: string
  now: number
}

export type RouteContext = {
  sessions: readonly BrSessionInfo[]
  /** Which session sent each message the bot sent (`chatId:messageId` → session id). */
  sentBy: ReadonlyMap<string, string>
}

export type Route =
  | { sessionId: string; text: string; reason: 'reply' | 'tag' | 'recent' }
  | { sessionId: null; text: string; reason: 'no-session' | 'unknown-tag'; detail: string }

export const isLive = (session: BrSessionInfo, now: number): boolean => !session.ended && now - session.lastSeen <= LIVE_MS

const byActivity = (a: BrSessionInfo, b: BrSessionInfo): number =>
  Math.max(b.lastActiveAt, b.lastSeen - LIVE_MS) - Math.max(a.lastActiveAt, a.lastSeen - LIVE_MS) || b.startedAt - a.startedAt

/** `#label` and `@project` at the start of a message pick a session; returns the tag and the rest. */
export const extractTag = (text: string): { tag?: { kind: 'label' | 'project'; value: string }; rest: string } => {
  const match = /^\s*([#@])([\p{L}\p{N}_.-]+)[\s:,-]*([\s\S]*)$/u.exec(text)
  if (match === null) return { rest: text.trim() }
  return { tag: { kind: match[1] === '#' ? 'label' : 'project', value: (match[2] ?? '').toLowerCase() }, rest: (match[3] ?? '').trim() }
}

/**
 * Picks the session an incoming message is for: a reply goes to the session that sent the message it replies
 * to, a `#label` / `@project` tag to that session, anything else to the most recently active session.
 */
export const route = (input: RouteInput, context: RouteContext): Route => {
  const live = context.sessions.filter(session => isLive(session, input.now)).sort(byActivity)
  const { tag, rest } = extractTag(input.text)
  const text = tag === undefined ? input.text.trim() : rest

  if (input.repliedTo !== undefined) {
    const sender = context.sentBy.get(input.repliedTo)
    if (sender !== undefined && live.some(session => session.id === sender)) return { sessionId: sender, text, reason: 'reply' }
  }
  if (tag !== undefined) {
    const found = live.find(session => (tag.kind === 'label' ? session.label.toLowerCase() === tag.value : session.project.toLowerCase() === tag.value))
    if (found !== undefined) return { sessionId: found.id, text, reason: 'tag' }
    return { sessionId: null, text, reason: 'unknown-tag', detail: `${tag.kind === 'label' ? '#' : '@'}${tag.value}` }
  }
  const first = live[0]
  if (first === undefined) return { sessionId: null, text, reason: 'no-session', detail: '' }
  return { sessionId: first.id, text, reason: 'recent' }
}

/** A short, unique-ish label for a session: the branch when it says something, else the project. */
export const defaultLabel = (project: string, branch: string, taken: readonly string[]): string => {
  const base = (branch !== '' && !['main', 'master', 'develop', 'trunk', 'HEAD'].includes(branch) ? branch.split('/').at(-1) ?? branch : project)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_.-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'claude'
  if (!taken.includes(base)) return base
  for (let n = 2; n < 100; n += 1) if (!taken.includes(`${base}${n}`)) return `${base}${n}`
  return `${base}-${Math.floor(Math.random() * 1000)}`
}
