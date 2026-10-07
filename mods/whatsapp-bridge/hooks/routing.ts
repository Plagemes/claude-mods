import type { WaGroupLink, WaSessionInfo } from '../types'

/** A session counts as live while its heartbeat is this fresh. */
export const LIVE_MS = 45_000

export type RouteInput = {
  chatId: string
  text: string
  /** The WhatsApp id of the message this one quotes (a reply). */
  quotedId?: string
  now: number
}

export type RouteContext = {
  sessions: readonly WaSessionInfo[]
  /** Which session sent each message the bot sent (WhatsApp message id → session id). */
  sentBy: ReadonlyMap<string, string>
  /** Project groups by project root. */
  groups: Readonly<Record<string, WaGroupLink>>
}

export type Route =
  | { sessionId: string; text: string; reason: 'reply' | 'tag' | 'group' | 'recent' }
  | { sessionId: null; text: string; reason: 'no-session' | 'unknown-tag' | 'no-project-session'; detail: string }

export const isLive = (session: WaSessionInfo, now: number): boolean => !session.ended && now - session.lastSeen <= LIVE_MS

const byActivity = (a: WaSessionInfo, b: WaSessionInfo): number =>
  Math.max(b.lastActiveAt, b.lastSeen - LIVE_MS) - Math.max(a.lastActiveAt, a.lastSeen - LIVE_MS) || b.startedAt - a.startedAt

/** `#label` and `@project` at the start of a message pick a session; returns the tag and the rest. */
export const extractTag = (text: string): { tag?: { kind: 'label' | 'project'; value: string }; rest: string } => {
  const match = /^\s*([#@])([\p{L}\p{N}_.-]+)[\s:,-]*([\s\S]*)$/u.exec(text)
  if (match === null) return { rest: text.trim() }
  return { tag: { kind: match[1] === '#' ? 'label' : 'project', value: (match[2] ?? '').toLowerCase() }, rest: (match[3] ?? '').trim() }
}

/** The project root whose group this chat is, if any. */
export const projectOfChat = (groups: Readonly<Record<string, WaGroupLink>>, chatId: string): string | undefined =>
  Object.entries(groups).find(([, link]) => link.groupId === chatId)?.[0]

/**
 * Picks the session an incoming message is for: a reply goes to the session that sent the quoted message,
 * a `#label` / `@project` tag to that session, a project group's message to that project's most recently
 * active session, anything else to the most recently active session.
 */
export const route = (input: RouteInput, context: RouteContext): Route => {
  const live = context.sessions.filter(session => isLive(session, input.now)).sort(byActivity)
  const { tag, rest } = extractTag(input.text)
  const text = tag === undefined ? input.text.trim() : rest
  const groupRoot = projectOfChat(context.groups, input.chatId)
  const inScope = groupRoot === undefined ? live : live.filter(session => session.root === groupRoot)

  if (input.quotedId !== undefined) {
    const sender = context.sentBy.get(input.quotedId)
    if (sender !== undefined && live.some(session => session.id === sender)) return { sessionId: sender, text, reason: 'reply' }
  }
  if (tag !== undefined) {
    const found = inScope.find(session =>
      tag.kind === 'label' ? session.label.toLowerCase() === tag.value : session.project.toLowerCase() === tag.value,
    )
    if (found !== undefined) return { sessionId: found.id, text, reason: 'tag' }
    return { sessionId: null, text, reason: 'unknown-tag', detail: `${tag.kind === 'label' ? '#' : '@'}${tag.value}` }
  }
  if (groupRoot !== undefined) {
    const first = inScope[0]
    if (first === undefined) return { sessionId: null, text, reason: 'no-project-session', detail: groupRoot }
    return { sessionId: first.id, text, reason: 'group' }
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
