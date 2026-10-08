import type { WaPhase } from '../types'

/** One stored message row of `GET /sessions/{id}/messages` (newest first). */
export type WaRow = {
  id: string
  waMessageId: string
  chatId: string
  from: string
  author: string | null
  body: string
  type: string
  direction: 'incoming' | 'outgoing'
  timestamp: number
  createdAt: string
  chatName: string
  quotedId?: string
  quotedBody?: string
  reactions: Record<string, string>
  media?: { mimetype: string; filename?: string; data?: string; isOmitted: boolean }
}

export type WaSessionRecord = { id: string; name: string; status: string; phone: string; pushName: string; lastError: string }

/** One OpenWA call. `key` sends that key instead of the stored one (the setup's one-time admin key). */
export type Request = { method: 'GET' | 'POST' | 'PUT'; path: string; body?: Record<string, unknown>; isPublic?: boolean; key?: string }

const str = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '')
const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
const enc = encodeURIComponent

export const directChat = (phone: string): string => `${phone}@c.us`
export const isGroupChat = (chatId: string): boolean => chatId.endsWith('@g.us')

export const api = {
  health: (): Request => ({ method: 'GET', path: '/health', isPublic: true }),
  validate: (): Request => ({ method: 'POST', path: '/auth/validate' }),
  sessions: (): Request => ({ method: 'GET', path: '/sessions' }),
  /** The setup's calls, made once with the admin key: find or create the session, mint the scoped operator key. */
  sessionsNamed: (name: string, key: string): Request => ({ method: 'GET', path: `/sessions?name=${enc(name)}`, key }),
  createSession: (name: string, key: string): Request => ({ method: 'POST', path: '/sessions', body: { name }, key }),
  createKey: (sessionId: string, name: string, key: string): Request => ({
    method: 'POST',
    path: '/auth/api-keys',
    body: { name, role: 'operator', allowedSessions: [sessionId] },
    key,
  }),
  session: (id: string): Request => ({ method: 'GET', path: `/sessions/${enc(id)}` }),
  start: (id: string): Request => ({ method: 'POST', path: `/sessions/${enc(id)}/start` }),
  qr: (id: string): Request => ({ method: 'GET', path: `/sessions/${enc(id)}/qr` }),
  pairingCode: (id: string, phone: string): Request => ({ method: 'POST', path: `/sessions/${enc(id)}/pairing-code`, body: { phoneNumber: phone } }),
  /**
   * `GET /sessions/{id}/messages`, newest first. OpenWA 0.24.0 (the pinned image) reads only `chatId`, `from`, `limit`,
   * `offset`, `after` and `inlineMedia` here (src/modules/message/message.controller.ts at tag v0.24.0): `direction`
   * and `messageId` came later and are silently ignored by 0.24, so the mod never relies on them.
   */
  messages: (id: string, query: { chatId?: string; after?: string; limit: number; inlineMedia?: boolean }): Request => {
    const params: [string, string][] = [['limit', String(query.limit)], ['inlineMedia', query.inlineMedia === true ? 'true' : 'false']]
    if (query.chatId !== undefined) params.push(['chatId', query.chatId])
    if (query.after !== undefined) params.push(['after', query.after])
    return { method: 'GET', path: `/sessions/${enc(id)}/messages?${params.map(([k, v]) => `${k}=${enc(v)}`).join('&')}` }
  },
  sendText: (id: string, chatId: string, text: string): Request => ({ method: 'POST', path: `/sessions/${enc(id)}/messages/send-text`, body: { chatId, text } }),
  reply: (id: string, chatId: string, quotedMessageId: string, text: string): Request => ({
    method: 'POST',
    path: `/sessions/${enc(id)}/messages/reply`,
    body: { chatId, quotedMessageId, text },
  }),
  sendMedia: (id: string, kind: 'image' | 'document', input: { chatId: string; base64: string; mimetype: string; filename: string; caption: string }): Request => ({
    method: 'POST',
    path: `/sessions/${enc(id)}/messages/send-${kind}`,
    body: kind === 'image'
      ? { chatId: input.chatId, base64: input.base64, mimetype: input.mimetype, caption: input.caption }
      : { chatId: input.chatId, base64: input.base64, mimetype: input.mimetype, filename: input.filename, caption: input.caption },
  }),
  edit: (id: string, chatId: string, messageId: string, body: string): Request => ({ method: 'POST', path: `/sessions/${enc(id)}/messages/edit`, body: { chatId, messageId, body } }),
  react: (id: string, chatId: string, messageId: string, emoji: string): Request => ({ method: 'POST', path: `/sessions/${enc(id)}/messages/react`, body: { chatId, messageId, emoji } }),
  groups: (id: string): Request => ({ method: 'GET', path: `/sessions/${enc(id)}/groups` }),
  createGroup: (id: string, name: string, participants: string[]): Request => ({ method: 'POST', path: `/sessions/${enc(id)}/groups`, body: { name, participants } }),
  groupInfo: (id: string, groupId: string): Request => ({ method: 'GET', path: `/sessions/${enc(id)}/groups/${enc(groupId)}` }),
  groupDescription: (id: string, groupId: string, description: string): Request => ({
    method: 'PUT',
    path: `/sessions/${enc(id)}/groups/${enc(groupId)}/description`,
    body: { description },
  }),
  /** `PUT …/groups/{groupId}/subject` `{ subject }` (≤ 100 characters). */
  groupSubject: (id: string, groupId: string, subject: string): Request => ({ method: 'PUT', path: `/sessions/${enc(id)}/groups/${enc(groupId)}/subject`, body: { subject } }),
  /** `POST …/groups/{groupId}/participants` `{ participants }`: 200 with a per-participant `results` list. */
  addParticipants: (id: string, groupId: string, participants: string[]): Request => ({
    method: 'POST',
    path: `/sessions/${enc(id)}/groups/${enc(groupId)}/participants`,
    body: { participants },
  }),
  /** `POST …/groups/{groupId}/leave`. */
  leaveGroup: (id: string, groupId: string): Request => ({ method: 'POST', path: `/sessions/${enc(id)}/groups/${enc(groupId)}/leave` }),
  inviteCode: (id: string, groupId: string): Request => ({ method: 'GET', path: `/sessions/${enc(id)}/groups/${enc(groupId)}/invite-code` }),
  contactPhone: (id: string, contactId: string): Request => ({ method: 'GET', path: `/sessions/${enc(id)}/contacts/${enc(contactId)}/phone` }),
}

export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The error text of an OpenWA error body (`message` may be a list), or the status. */
export const errorText = (status: number, text: string): string => {
  const body = record(parseJson(text))
  const message = Array.isArray(body.message) ? body.message.map(str).join('; ') : str(body.message)
  const code = str(body.code)
  return `${status}${code !== '' ? ` ${code}` : ''}${message !== '' ? `: ${message}` : ''}`
}

export const parseSession = (value: unknown): WaSessionRecord | null => {
  const raw = record(value)
  const id = str(raw.id)
  if (id === '') return null
  return { id, name: str(raw.name), status: str(raw.status), phone: str(raw.phone).replace(/\D/g, ''), pushName: str(raw.pushName), lastError: str(record(raw.lastError).message ?? raw.lastError) }
}

export const parseSessions = (value: unknown): WaSessionRecord[] =>
  (Array.isArray(value) ? value : Array.isArray(record(value).sessions) ? (record(value).sessions as unknown[]) : [])
    .map(parseSession)
    .filter((one): one is WaSessionRecord => one !== null)

export const parseRow = (value: unknown): WaRow | null => {
  const raw = record(value)
  const id = str(raw.id)
  const chatId = str(raw.chatId)
  if (id === '' || chatId === '') return null
  const metadata = record(raw.metadata)
  const quoted = record(metadata.quotedMessage)
  const media = record(metadata.media)
  const reactions = Object.fromEntries(Object.entries(record(metadata.reactions)).filter(([, emoji]) => typeof emoji === 'string' && emoji !== '')) as Record<string, string>
  return {
    id,
    waMessageId: str(raw.waMessageId),
    chatId,
    from: str(raw.from),
    author: typeof raw.author === 'string' && raw.author !== '' ? raw.author : null,
    body: str(raw.body),
    type: str(raw.type) || 'text',
    direction: raw.direction === 'outgoing' ? 'outgoing' : 'incoming',
    timestamp: Number(raw.timestamp) || 0,
    createdAt: str(raw.createdAt),
    chatName: str(raw.chatName),
    ...(str(quoted.id) !== '' ? { quotedId: str(quoted.id), quotedBody: str(quoted.body) } : {}),
    reactions,
    ...(Object.keys(media).length > 0
      ? {
          media: {
            mimetype: str(media.mimetype),
            ...(str(media.filename) !== '' ? { filename: str(media.filename) } : {}),
            ...(str(media.data) !== '' ? { data: str(media.data) } : {}),
            isOmitted: media.omitted === true,
          },
        }
      : {}),
  }
}

export const parseRows = (value: unknown): WaRow[] =>
  (Array.isArray(record(value).messages) ? (record(value).messages as unknown[]) : [])
    .map(parseRow)
    .filter((row): row is WaRow => row !== null)

export const parseMessageId = (value: unknown): string => str(record(value).messageId)

export const parseGroups = (value: unknown): { id: string; name: string; participantsCount: number }[] =>
  (Array.isArray(value) ? value : [])
    .map(record)
    .map(group => ({ id: str(group.id), name: str(group.name), participantsCount: Number(group.participantsCount) || 0 }))
    .filter(group => group.id.endsWith('@g.us'))

/** The connection phase a session status means. */
export const phaseOf = (status: string): WaPhase => {
  switch (status) {
    case 'ready':
      return 'ready'
    case 'qr_ready':
      return 'qr'
    case 'created':
    case 'initializing':
    case 'authenticating':
      return 'starting'
    case 'disconnected':
      return 'disconnected'
    default:
      return 'error'
  }
}

/** `data:image/png;base64,....` → the base64 part. */
export const dataUrlBase64 = (url: string): string => url.replace(/^data:[^,]*,/, '')

/** A file name's media type, for the files Claude may send. */
export const mimeOf = (path: string): { mimetype: string; kind: 'image' | 'document' } => {
  const ext = (path.split('.').at(-1) ?? '').toLowerCase()
  const images: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
  const docs: Record<string, string> = {
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
    html: 'text/html',
    zip: 'application/zip',
    log: 'text/plain',
  }
  const image = images[ext]
  if (image !== undefined) return { mimetype: image, kind: 'image' }
  return { mimetype: docs[ext] ?? 'application/octet-stream', kind: 'document' }
}

/** The file extension to save an incoming media message under. */
export const extensionOf = (mimetype: string, filename: string | undefined): string => {
  const fromName = filename?.includes('.') === true ? filename.split('.').at(-1) ?? '' : ''
  if (/^[a-z0-9]{1,5}$/i.test(fromName)) return fromName.toLowerCase()
  const sub = (mimetype.split('/')[1] ?? 'bin').split(';')[0] ?? 'bin'
  return ({ jpeg: 'jpg', 'ogg': 'ogg', mpeg: 'mp3', 'x-m4a': 'm4a', plain: 'txt' } as Record<string, string>)[sub] ?? (sub.replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'bin')
}

/** The per-participant outcome of an add (`ParticipantsOperationResponseDto.results`). */
export const parseParticipantResults = (value: unknown): { id: string; isAdded: boolean; message: string }[] =>
  (Array.isArray(record(value).results) ? (record(value).results as unknown[]) : [])
    .map(record)
    .map(one => ({ id: str(one.id), isAdded: one.success === true, message: str(one.message) }))
    .filter(one => one.id !== '')

/** A group's member count from `GET …/groups/{groupId}` (`participants`). */
export const memberCountOf = (value: unknown): number => (Array.isArray(record(value).participants) ? (record(value).participants as unknown[]).length : 0)
