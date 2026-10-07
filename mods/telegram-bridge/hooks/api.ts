import type { BrChatSeen } from '../types'

export const API = 'https://api.telegram.org'
export const urlOf = (token: string, method: string): string => `${API}/bot${token}/${method}`

export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '')

/** A message or a button press from `getUpdates`, flattened to what the bridge reads. */
export type Inbound = {
  /** Unique per update: the leader remembers it so nothing is handled twice. */
  key: string
  updateId: number
  kind: 'message' | 'callback'
  chatId: string
  chatKind: 'private' | 'group' | 'supergroup' | 'channel'
  chatTitle: string
  fromId: string
  fromName: string
  messageId: string
  text: string
  /** The message this one replies to, and whether that was the bot. */
  replyToId?: string
  isReplyToBot: boolean
  /** Forwarded from someone else: its words are another person's, never the sender's own command. */
  isForwarded?: boolean
  /** A button press: its id (to acknowledge) and data. */
  callbackId?: string
  data?: string
}

export type ParsedUpdates = { updates: Inbound[]; lastId: number; chats: BrChatSeen[] }

const nameOf = (from: Record<string, unknown>): string => {
  const first = str(from.first_name)
  const username = str(from.username)
  return first !== '' ? first : username !== '' ? `@${username}` : str(from.id)
}

const chatKindOf = (value: unknown): Inbound['chatKind'] => (value === 'group' || value === 'supergroup' || value === 'channel' ? value : 'private')

/** `getUpdates` result → the messages and button presses in it, the last update id, and the group chats seen. */
export const parseUpdates = (result: unknown, botId: string): ParsedUpdates => {
  const out: ParsedUpdates = { updates: [], lastId: 0, chats: [] }
  if (!Array.isArray(result)) return out
  for (const raw of result as unknown[]) {
    if (!isRecord(raw) || typeof raw.update_id !== 'number') continue
    const updateId = raw.update_id
    out.lastId = Math.max(out.lastId, updateId)
    const callback = isRecord(raw.callback_query) ? raw.callback_query : undefined
    const message = isRecord(raw.message) ? raw.message : isRecord(callback?.message) ? (callback?.message as Record<string, unknown>) : undefined
    const member = isRecord(raw.my_chat_member) ? raw.my_chat_member : undefined
    const chat = isRecord(message?.chat) ? (message?.chat as Record<string, unknown>) : isRecord(member?.chat) ? (member?.chat as Record<string, unknown>) : undefined
    if (chat === undefined) continue
    const chatKind = chatKindOf(chat.type)
    if (chatKind !== 'private') out.chats.push({ id: str(chat.id), title: str(chat.title), kind: chatKind })
    if (callback !== undefined && message !== undefined && isRecord(callback.from)) {
      out.updates.push({
        key: `u:${updateId}`,
        updateId,
        kind: 'callback',
        chatId: str(chat.id),
        chatKind,
        chatTitle: str(chat.title),
        fromId: str(callback.from.id),
        fromName: nameOf(callback.from),
        messageId: str(message.message_id),
        text: '',
        isReplyToBot: false,
        callbackId: str(callback.id),
        data: str(callback.data),
      })
      continue
    }
    if (raw.message === undefined || message === undefined || !isRecord(message.from)) continue
    const replied = isRecord(message.reply_to_message) ? message.reply_to_message : undefined
    out.updates.push({
      key: `u:${updateId}`,
      updateId,
      kind: 'message',
      chatId: str(chat.id),
      chatKind,
      chatTitle: str(chat.title),
      fromId: str(message.from.id),
      fromName: nameOf(message.from),
      messageId: str(message.message_id),
      text: str(message.text) || str(message.caption),
      ...(replied !== undefined ? { replyToId: str(replied.message_id) } : {}),
      ...(message.forward_origin !== undefined || message.forward_date !== undefined || message.forward_from !== undefined ? { isForwarded: true } : {}),
      isReplyToBot: replied !== undefined && isRecord(replied.from) && botId !== '' && str(replied.from.id) === botId,
    })
  }
  return out
}

/** A parsed Bot API response: `ok`, its `result` and a readable error. */
export type Reply = { ok: boolean; status: number; result: unknown; description: string; retryAfter?: number }

export const parseReply = (status: number, text: string): Reply => {
  const json = parseJson(text)
  const body = isRecord(json) ? json : {}
  const parameters = isRecord(body.parameters) ? body.parameters : {}
  const retryAfter = typeof parameters.retry_after === 'number' ? parameters.retry_after : undefined
  return {
    ok: status >= 200 && status < 300 && body.ok === true,
    status,
    result: body.result,
    description: str(body.description),
    ...(retryAfter !== undefined ? { retryAfter } : {}),
  }
}

export const messageIdOf = (result: unknown): string => (isRecord(result) ? str(result.message_id) : '')

export const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The bridge's light markup (`*bold*`, `_italic_`, `` `code` ``, fences) as Telegram HTML. */
export const toHtml = (text: string): string =>
  escapeHtml(text)
    .replace(/```(?:[\w-]*\n)?([\s\S]*?)```/g, '<pre>$1</pre>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,!?])/g, '$1<i>$2</i>')

/** Rows of at most two buttons, one per option; each press comes back as `callback_data`. */
export const keyboard = (pendingId: string, options: readonly string[], dataOf: (pendingId: string, index: number) => string): { inline_keyboard: { text: string; callback_data: string }[][] } => {
  const rows: { text: string; callback_data: string }[][] = []
  options.forEach((option, index) => {
    const button = { text: option.slice(0, 40), callback_data: dataOf(pendingId, index) }
    const last = rows.at(-1)
    if (last !== undefined && last.length < 2 && options.length > 2 && (last[0]?.text.length ?? 99) < 18 && option.length < 18) last.push(button)
    else rows.push([button])
  })
  return { inline_keyboard: rows }
}

/** Hides the bot token if an error text carries it. */
export const scrub = (text: string, token: string): string => (token === '' ? text : text.split(token).join('[token]'))
