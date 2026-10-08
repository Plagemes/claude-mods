import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

export const HOME = '/home/me'
export const DIR = `${HOME}/.claude/claude-mods/whatsapp`
export const ROOT = '/work/shop'
export const ME = 'sess-a'
export const OWNER = '393331112222'
export const OWNER_CHAT = `${OWNER}@c.us`
export const BOT = '15550001111'
export const GROUP = '120363000000000001@g.us'
export const SESSION = '3f6b9c1e-0000-4000-8000-000000000001'
export const KEY = 'owa_k1_scopedoperatorkey0000000000'
/** What the bridge appends to a phone prompt so Claude knows its reply goes to the phone (the prompt carries it itself). */
export const PHONE_NOTE =
  '\n\n(This prompt was sent by the user from WhatsApp (whatsapp-bridge). Your final reply is relayed to their phone: end with a short plain-text summary of what you did or found.)'
/** A real 1×1 PNG. */
export const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** A message row as OpenWA stores it. */
export type FakeRow = {
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
  metadata: Record<string, unknown> | null
}

/** OpenWA in memory: what it stores, what was sent, and how it behaves. */
export type FakeWa = {
  status: 'ready' | 'qr_ready'
  phone: string
  role: 'operator' | 'admin'
  canCreateGroups: boolean
  rows: FakeRow[]
  groups: { id: string; name: string; participants: string[] }[]
  calls: { method: string; path: string; body: Record<string, unknown> }[]
  next: number
  /** The next this many sends fail with a 500 (the engine restarting). */
  failSends: number
}

export type World = {
  clock: MockClock
  files: Map<string, string>
  wa: FakeWa
  /** Prompts the bridge submitted, the phone note (PHONE_NOTE) taken off: what the person wrote. */
  submitted: { text: string; asUser: boolean }[]
  /** The same prompts as the model reads them, the phone note included. */
  prompts: string[]
  toasts: string[]
  /** The tools registered with the engine, in order. */
  tools: string[]
  aborted: string[]
  forks: string[]
  completions: string[]
  forkAnswer: { text: string }
  processes: string[][]
  gh: { exitCode: number; stdout: string }
  /** Host tools that exist (beyond sleep, git and gh): rsvg-convert, openssl. */
  bins: Set<string>
  /** Runs just before a file write lands: another session writing at the same moment. */
  beforeWrite?: (path: string) => void
}

/** Sends the bot made (send-text, reply, send-image, ...): chat and text. */
export const sends = (seen: World): { chatId: string; text: string; path: string }[] =>
  seen.wa.calls
    .filter(call => call.method === 'POST' && /\/messages\/(send-|reply)/.test(call.path))
    .map(call => ({ chatId: String(call.body.chatId ?? ''), text: String(call.body.text ?? call.body.caption ?? '').replace(/\u2063$/, ''), path: call.path }))

const json = (status: number, body: unknown) => ({
  value: { status, ok: status >= 200 && status < 300, headers: { 'content-type': 'application/json' }, text: JSON.stringify(body) },
})

const iso = (ms: number): string => new Date(ms).toISOString()

/** Adds a row as if a message arrived (or was typed on the linked phone, for `outgoing`). */
export function arrive(
  seen: World,
  input: { chatId: string; body: string; author?: string; from?: string; quotedId?: string; type?: string; direction?: 'incoming' | 'outgoing'; media?: Record<string, unknown> },
): FakeRow {
  seen.wa.next += 1
  const n = seen.wa.next
  const now = seen.clock.now()
  const metadata: Record<string, unknown> = {}
  if (input.quotedId !== undefined) metadata.quotedMessage = { id: input.quotedId, body: '' }
  if (input.media !== undefined) metadata.media = input.media
  const row: FakeRow = {
    id: `row-${String(n).padStart(5, '0')}`,
    waMessageId: `false_${input.chatId}_IN${n}`,
    chatId: input.chatId,
    from: input.from ?? input.chatId,
    author: input.author ?? null,
    body: input.body,
    type: input.type ?? 'text',
    direction: input.direction ?? 'incoming',
    timestamp: Math.floor(now / 1000),
    createdAt: iso(now + n),
    metadata: Object.keys(metadata).length > 0 ? metadata : null,
  }
  seen.wa.rows.push(row)
  return row
}

/** Someone reacts to a message the bot sent (OpenWA keeps reactions on the row's metadata). */
export function react(seen: World, waMessageId: string, reactor: string, emoji: string): void {
  const row = seen.wa.rows.find(one => one.waMessageId === waMessageId)
  if (row === undefined) throw new Error(`no row ${waMessageId}`)
  const metadata = row.metadata ?? {}
  metadata.reactions = { ...((metadata.reactions as Record<string, string> | undefined) ?? {}), [reactor]: emoji }
  row.metadata = metadata
}

function openwa(seen: World, method: string, url: string, body: Record<string, unknown>) {
  const wa = seen.wa
  const path = url.replace(/^http:\/\/127\.0\.0\.1:2785\/api/, '')
  wa.calls.push({ method, path, body })
  const [route = '', query = ''] = path.split('?')
  const params = new Map(query.split('&').filter(Boolean).map(pair => pair.split('=').map(decodeURIComponent) as [string, string]))
  const session = { id: SESSION, name: 'claude', status: wa.status, phone: wa.status === 'ready' ? wa.phone : null, pushName: 'Bot', lastError: null }
  if (route === '/health') return json(200, { status: 'ok' })
  if (route === '/auth/validate') return json(200, { valid: true, role: wa.role, scoped: false })
  if (route === '/sessions') return json(200, [session])
  if (route === `/sessions/${SESSION}`) return json(200, session)
  if (route === `/sessions/${SESSION}/qr`) return wa.status === 'qr_ready' ? json(200, { qrCode: `data:image/png;base64,${PNG}`, status: 'qr_ready' }) : json(400, { message: 'already authenticated' })
  if (route === `/sessions/${SESSION}/pairing-code`) return json(201, { pairingCode: 'ABCD1234', status: 'qr_ready' })
  if (route === `/sessions/${SESSION}/start`) return json(200, session)
  if (route === `/sessions/${SESSION}/messages`) {
    let rows = [...wa.rows].reverse()
    const chatId = params.get('chatId')
    if (chatId !== undefined) rows = rows.filter(row => row.chatId === chatId)
    const messageId = params.get('messageId')
    if (messageId !== undefined) rows = rows.filter(row => row.waMessageId === messageId)
    if (params.get('direction') === 'incoming') rows = rows.filter(row => row.direction === 'incoming')
    const after = params.get('after')
    if (after !== undefined) {
      const index = rows.findIndex(row => row.id === after)
      if (index < 0) return json(400, { message: 'unknown cursor' })
      rows = rows.slice(index + 1)
    }
    const limit = Number(params.get('limit') ?? 50)
    return json(200, { messages: rows.slice(0, limit), total: rows.length })
  }
  const send = /^\/sessions\/[^/]+\/messages\/(send-text|reply|send-image|send-document)$/.exec(route)
  if (send !== null) {
    if (wa.failSends > 0) {
      wa.failSends -= 1
      return json(500, { message: 'engine restarting' })
    }
    const chatId = String(body.chatId ?? '')
    const row = arrive(seen, { chatId, body: String(body.text ?? body.caption ?? ''), direction: 'outgoing', from: wa.phone })
    row.waMessageId = `true_${chatId}_OUT${wa.next}`
    return json(201, { messageId: row.waMessageId, timestamp: row.timestamp })
  }
  if (/\/messages\/(edit|react)$/.test(route)) return json(200, { success: true })
  if (route === `/sessions/${SESSION}/groups` && method === 'GET') return json(200, wa.groups.map(group => ({ id: group.id, name: group.name, participantsCount: group.participants.length })))
  if (route === `/sessions/${SESSION}/groups` && method === 'POST') {
    if (!wa.canCreateGroups) return json(501, { message: 'Not supported by the active engine' })
    const group = { id: GROUP, name: String(body.name), participants: (body.participants as string[]) ?? [] }
    wa.groups.push(group)
    return json(201, { id: group.id, name: group.name })
  }
  const groupInfo = /^\/sessions\/[^/]+\/groups\/([^/]+)(\/[a-z-]+)?$/.exec(route)
  if (groupInfo !== null) {
    const group = wa.groups.find(one => one.id === decodeURIComponent(groupInfo[1] ?? ''))
    if (groupInfo[2] === '/invite-code') return json(200, { inviteCode: 'CODE', inviteLink: 'https://chat.whatsapp.com/CODE' })
    if (groupInfo[2] === '/description') return json(200, { success: true })
    return json(200, { id: group?.id, name: group?.name, participants: (group?.participants ?? []).map(id => ({ id, number: id.split('@')[0], isAdmin: false, isSuperAdmin: false })) })
  }
  if (/\/contacts\/[^/]+\/phone$/.test(route)) return json(200, { contactId: '', phone: null })
  return json(404, { message: `no route ${method} ${route}` })
}

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/'))

/** The engine beneath the plugin: files, OpenWA, the session, the model and the host, all in memory. */
export function world(on: On, options: { now?: number; status?: FakeWa['status']; canCreateGroups?: boolean; files?: Record<string, string> } = {}): World {
  const seen: World = {
    clock: (startClock = mock.clock(on, { now: options.now ?? new Date(2026, 9, 7, 12, 0, 0).getTime() })),
    files: new Map(Object.entries(options.files ?? {})),
    wa: { status: options.status ?? 'ready', phone: BOT, role: 'operator', canCreateGroups: options.canCreateGroups ?? true, rows: [], groups: [], calls: [], next: 0, failSends: 0 },
    submitted: [],
    prompts: [],
    toasts: [],
    tools: [],
    aborted: [],
    forks: [],
    completions: [],
    forkAnswer: { text: 'The login page is done; tests are next.' },
    processes: [],
    gh: { exitCode: 0, stdout: 'https://github.com/acme/shop/issues/7\n' },
    bins: new Set(),
  }
  mock.env(on, { HOME })
  mock.store(on)
  const mtimes = new Map<string, number>()
  on('fs.read', ($, e) => {
    const text = seen.files.get(e.path)
    if (text === undefined) return { deny: `ENOENT: ${e.path}` }
    return { value: e.as === 'bytes' ? { base64: text } : text }
  })
  on('fs.write', ($, e) => {
    seen.beforeWrite?.(e.path)
    seen.files.set(e.path, e.text)
    mtimes.set(e.path, seen.clock.now())
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: seen.files.has(e.path) }))
  on('fs.list', ($, e) => {
    const names = [...seen.files.keys()].filter(path => parentOf(path) === e.path)
    if (names.length === 0) return { deny: `ENOENT: ${e.path}` }
    return {
      value: names.map(path => ({ name: path.slice(e.path.length + 1), kind: 'file' as const, size: (seen.files.get(path) ?? '').length, mtimeMs: mtimes.get(path) ?? seen.clock.now(), isLink: false })),
    }
  })
  on('fs.stat', ($, e) => {
    const isDir = [...seen.files.keys()].some(path => path.startsWith(`${e.path}/`)) || e.path === ROOT
    const text = seen.files.get(e.path)
    if (text === undefined && !isDir) return { deny: `ENOENT: ${e.path}` }
    return { value: { kind: isDir ? ('dir' as const) : ('file' as const), size: text?.length ?? 0, mtimeMs: mtimes.get(e.path) ?? 0, isLink: false, realPath: e.path } }
  })
  on('http.fetch', ($, e) => {
    const body = typeof e.init?.body === 'string' ? (JSON.parse(e.init.body) as Record<string, unknown>) : {}
    return openwa(seen, e.init?.method ?? 'GET', e.url, body)
  })
  on('process.run', async ($, e) => {
    seen.processes.push([...e.argv])
    const [bin = ''] = e.argv
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (bin === 'sleep') {
      await seen.clock.sleep(Number(e.argv[1] ?? 1) * 1000)
      return ok('')
    }
    if (bin === 'git') return ok('feature/login\n')
    if (bin === 'rsvg-convert' && seen.bins.has(bin)) {
      if (e.argv[1] === '-o') seen.files.set(e.argv[2] ?? '', PNG)
      return ok('rsvg-convert 2.58')
    }
    if (bin === 'openssl' && seen.bins.has(bin)) {
      const out = e.argv[e.argv.indexOf('-out') + 1] ?? ''
      seen.files.set(out, `decoded:${seen.files.get(e.argv[e.argv.indexOf('-in') + 1] ?? '') ?? ''}`)
      return ok('')
    }
    if (bin === 'gh') return { value: { exitCode: seen.gh.exitCode, stdout: seen.gh.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return { deny: 'failed to start: ENOENT' }
  })
  on('session.id', () => ({ value: ME }))
  on('session.root', () => ({ value: ROOT }))
  on('session.repo', () => ({ value: { root: ROOT, remote: null, internal: false, name: 'shop' } }))
  on('session.messages', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 200_000, percent: 0 }, rateLimits: [], cost: { usd: 1.25 } } as never }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: [] }))
  on('tool.register', ($, e) => {
    seen.tools.push(e.name)
    return { value: { tool: `mcp__whatsapp-bridge__${e.name}` } }
  })
  on('tool.check', () => ({ decision: 'ask' }))
  on('prompt.submit', ($, e) => {
    if (e.origin.kind === 'plugin') {
      seen.prompts.push(e.text)
      seen.submitted.push({ text: e.text.replace(PHONE_NOTE, ''), asUser: (e.origin as { asUser?: boolean }).asUser === true })
    }
    return { text: e.text, ...(e.context !== undefined ? { context: e.context } : {}) }
  })
  on('prompt.compose', () => ({ sections: [] }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.abort', ($, e) => {
    seen.aborted.push(e.turnId)
    return { value: undefined }
  })
  on('model.fork', ($, e) => {
    seen.forks.push(e.prompt)
    return { value: { isAnswered: true, text: seen.forkAnswer.text, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('model.complete', ($, e) => {
    seen.completions.push(typeof e.prompt === 'string' ? e.prompt : '')
    return { value: { isAnswered: true, text: 'TITLE: Login crashes on submit\n\nDescription: the login form crashes.', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('classic.PermissionRequest', () => ({}))
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  return seen
}

/** A ready, configured machine: config with key, session and owner; this project linked to its group. */
export const configured = (extra: Record<string, string> = {}): Record<string, string> => ({
  [`${DIR}/config.json`]: JSON.stringify({ apiKey: KEY, sessionId: SESSION, ownerNumbers: [OWNER] }),
  [`${DIR}/groups.json`]: JSON.stringify({ [ROOT]: { groupId: GROUP, name: 'Claude · shop', inviteLink: '', members: 1, createdAt: 0 } }),
  [`${DIR}/prefs.json`]: JSON.stringify({ presence: 'away' }),
  ...extra,
})

/** The running test's mock clock (each world makes one). */
let startClock: MockClock | undefined

/** Starts the session and lets the start-up run: it waits until session.start has returned (afterStart). */
export const start = async ($: Engine) => {
  const started = await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await startClock?.advance(1_500)
  return started
}

export const wa = async ($: Engine, args: string): Promise<string> =>
  (await $.command.run({ command: 'wa', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })).text ?? ''

/** Starts the session and lets the lease settle so this session is the verified leader and polling. */
export async function lead($: Engine, seen: World): Promise<void> {
  await start($)
  await seen.clock.advance(11_000)
  await seen.clock.advance(1_000)
}

/** Moves time on in steps, so polls, heartbeats and the inbox all get their turns. */
export async function pass(seen: World, ms: number, step = 2_000): Promise<void> {
  for (let done = 0; done < ms; done += step) await seen.clock.advance(step)
}
