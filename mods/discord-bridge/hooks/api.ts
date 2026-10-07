export const API = 'https://discord.com/api/v10'
/** Discord asks bots to say who they are. */
export const USER_AGENT = 'DiscordBot (https://github.com/plagemes/claude-mods, 1.0)'

export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '')

/** A user, channel or message id ("snowflake"). */
export const isSnowflake = (value: string): boolean => /^\d{17,20}$/.test(value)
export const isWebhook = (value: string): boolean => /^https:\/\/(?:discord|discordapp)\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+$/.test(value)

/** A message of the watched channel, flattened to what the bridge reads. */
export type Inbound = {
  /** Unique per message: the leader remembers it so nothing is handled twice. */
  key: string
  id: string
  userId: string
  username: string
  text: string
  /** The message this one replies to. */
  replyToId?: string
}

/** A parsed REST response: `ok`, its body (an object, or an array for lists) and Discord's error text. */
export type Reply = { ok: boolean; status: number; body: unknown; error: string; retryAfter?: number }

export const parseReply = (status: number, text: string, retryAfterHeader: string | undefined): Reply => {
  const body = parseJson(text)
  const record = isRecord(body) ? body : {}
  const fromBody = typeof record.retry_after === 'number' ? record.retry_after : undefined
  const fromHeader = Number(retryAfterHeader)
  const retryAfter = fromBody ?? (retryAfterHeader !== undefined && Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : undefined)
  return {
    ok: status >= 200 && status < 300,
    status,
    body,
    error: str(record.message) || (status >= 400 ? `http ${status}` : ''),
    ...(retryAfter !== undefined ? { retryAfter } : {}),
  }
}

/** Snowflakes grow with time; compare as numbers without losing digits. */
export const newerId = (a: string, b: string): boolean => {
  try {
    return BigInt(a) > BigInt(b)
  } catch {
    return a > b
  }
}

/**
 * People's messages of `GET /channels/{id}/messages`, oldest first; bots (and so the bridge's own posts and webhooks),
 * joins and pins are not people. `newest` is the highest id seen (the next cursor); `empty` counts people's messages
 * that came without text, which is what a missing Message Content intent looks like.
 */
export const parseMessages = (body: unknown, botUserId: string): { messages: Inbound[]; newest: string; empty: number } => {
  const out = { messages: [] as Inbound[], newest: '', empty: 0 }
  if (!Array.isArray(body)) return out
  for (const raw of body) {
    if (!isRecord(raw) || typeof raw.id !== 'string') continue
    if (out.newest === '' || newerId(raw.id, out.newest)) out.newest = raw.id
    const author = isRecord(raw.author) ? raw.author : {}
    const userId = str(author.id)
    if (userId === '' || userId === botUserId || author.bot === true) continue
    if (raw.type !== 0 && raw.type !== 19) continue
    const hasContent = str(raw.content) !== '' || (Array.isArray(raw.attachments) && raw.attachments.length > 0) || (Array.isArray(raw.embeds) && raw.embeds.length > 0) || (Array.isArray(raw.sticker_items) && raw.sticker_items.length > 0)
    if (!hasContent) out.empty += 1
    const reference = isRecord(raw.message_reference) ? str(raw.message_reference.message_id) : ''
    out.messages.push({ key: `m:${raw.id}`, id: raw.id, userId, username: str(author.username), text: fromDiscord(str(raw.content)), ...(reference !== '' ? { replyToId: reference } : {}) })
  }
  out.messages.sort((a, b) => (a.id === b.id ? 0 : newerId(a.id, b.id) ? 1 : -1))
  return out
}

/** The ids of the people who used a reaction (`GET …/reactions/{emoji}`). */
export const usersOf = (body: unknown): string[] => (Array.isArray(body) ? body.filter(isRecord).map(user => str(user.id)).filter(id => id !== '') : [])

export const createdId = (body: unknown): string => (isRecord(body) ? str(body.id) : '')

/** The bridge's light markup (`*bold*`) as Discord's (`**bold**`); `_italic_` and code are the same. */
export const toDiscord = (text: string): string => text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1**$2**')

/** What Discord sent, as plain text: nickname mentions, channel links and custom emoji unwrapped. */
export const fromDiscord = (text: string): string =>
  text
    .replace(/<@!(\d+)>/g, '<@$1>')
    .replace(/<#\d+>/g, '#channel')
    .replace(/<a?:(\w+):\d+>/g, ':$1:')

/** Hides a token or webhook URL if an error text carries it. */
export const scrub = (text: string, ...secrets: string[]): string => secrets.reduce((out, secret) => (secret === '' ? out : out.split(secret).join('[secret]')), text)
