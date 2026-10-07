export const API = 'https://slack.com/api'

export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '')

/** A Slack member id (`U…`, or `W…` on Enterprise Grid). */
export const isUserId = (value: string): boolean => /^[UW][A-Z0-9]{6,}$/.test(value)
/** A public (`C…`) or private (`G…`) channel id. */
export const isChannelId = (value: string): boolean => /^[CG][A-Z0-9]{6,}$/.test(value)
export const isWebhook = (value: string): boolean => /^https:\/\/hooks\.slack\.com\/(?:services|workflows)\/\S+$/.test(value)

/** A message of the watched channel, flattened to what the bridge reads. */
export type Inbound = {
  /** Unique per message: the leader remembers it so nothing is handled twice. */
  key: string
  ts: string
  userId: string
  text: string
}

/** A parsed Web API response: `ok`, its body and Slack's error code. */
export type Reply = { ok: boolean; status: number; json: Record<string, unknown>; error: string; retryAfter?: number }

export const parseReply = (status: number, text: string, retryAfter: string | undefined): Reply => {
  const json = parseJson(text)
  const body = isRecord(json) ? json : {}
  const seconds = Number(retryAfter)
  return {
    ok: status >= 200 && status < 300 && body.ok === true,
    status,
    json: body,
    error: str(body.error) || (status >= 400 ? `http ${status}` : ''),
    ...(retryAfter !== undefined && Number.isFinite(seconds) && seconds > 0 ? { retryAfter: seconds } : {}),
  }
}

/** Slack timestamps (`1700000000.000200`) have equal length, so they compare as text. */
export const newerTs = (a: string, b: string): boolean => a.length > b.length || (a.length === b.length && a > b)

export const tsAt = (ms: number): string => `${Math.floor(ms / 1000)}.000000`

/** People's messages of `conversations.history` / `conversations.replies`, oldest first; bots, joins and edits are not people. */
export const parseMessages = (json: unknown, botUserId: string): { messages: Inbound[]; newest: string } => {
  const list = isRecord(json) && Array.isArray(json.messages) ? json.messages : []
  const messages: Inbound[] = []
  let newest = ''
  for (const raw of list) {
    if (!isRecord(raw) || typeof raw.ts !== 'string') continue
    if (newest === '' || newerTs(raw.ts, newest)) newest = raw.ts
    const userId = str(raw.user)
    if (userId === '' || userId === botUserId || raw.bot_id !== undefined) continue
    if (raw.subtype !== undefined && raw.subtype !== 'thread_broadcast') continue
    messages.push({ key: `m:${raw.ts}`, ts: raw.ts, userId, text: fromSlack(str(raw.text)) })
  }
  messages.sort((a, b) => (a.ts === b.ts ? 0 : newerTs(a.ts, b.ts) ? 1 : -1))
  return { messages, newest }
}

/** The reactions on a message (`reactions.get`): each emoji name and who used it. */
export const reactionsOf = (json: unknown): { name: string; users: string[] }[] => {
  const message = isRecord(json) && isRecord(json.message) ? json.message : {}
  const list = Array.isArray(message.reactions) ? message.reactions : []
  return list.filter(isRecord).map(one => ({ name: str(one.name), users: Array.isArray(one.users) ? one.users.map(str) : [] }))
}

export const nextCursor = (json: unknown): string => (isRecord(json) && isRecord(json.response_metadata) ? str(json.response_metadata.next_cursor) : '')

/** The bridge's light markup (`*bold*`, `_italic_`, code) is Slack's own: only `& < >` need escaping, and `<@U…>` stays a mention. */
export const toSlack = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/&lt;@([UW][A-Z0-9]{6,})&gt;/g, '<@$1>')

/** What Slack sent, as plain text: links, mentions and entities unwrapped. */
export function fromSlack(text: string): string {
  return text
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** Hides a token if an error text carries it. */
export const scrub = (text: string, ...secrets: string[]): string => secrets.reduce((out, secret) => (secret === '' ? out : out.split(secret).join('[secret]')), text)
