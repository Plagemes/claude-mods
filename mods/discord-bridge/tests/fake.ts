import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

export const HOME = '/home/me'
export const DIR = `${HOME}/.claude/claude-mods/discord`
export const ROOT = '/work/shop'
export const ME = 'sess-a'
// Assembled from parts so secret scanners don't mistake the fixture for a real token.
export const TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GfAkE0', 'fakeBotTokenForTests0123456789abcdefg'].join('.')
export const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/fakeWebhookTokenForTests0123456789abcdef'
export const BOT = '900000000000000001'
export const OWNER = '900000000000000002'
export const MEMBER = '900000000000000003'
export const CHANNEL = '900000000000000010'

type Message = {
  id: string
  userId: string
  username: string
  isBot: boolean
  content: string
  replyTo?: string
  type: number
  reactions: { emoji: string; users: string[] }[]
}

/** Discord in memory: the channel's messages and their reactions, and every call the bot made. */
export type FakeDiscord = {
  messages: Message[]
  calls: { method: string; path: string; body: Record<string, unknown> }[]
  hooks: string[]
  uploads: { argv: string[]; stdin: string }[]
  counter: number
  isTokenValid: boolean
  canRead: boolean
}

export type World = {
  clock: MockClock
  files: Map<string, string>
  discord: FakeDiscord
  submitted: { text: string; asUser: boolean }[]
  toasts: string[]
  aborted: string[]
  forks: string[]
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  value: { status, ok: status >= 200 && status < 300, headers: { 'content-type': 'application/json', ...headers }, text: JSON.stringify(body) },
})

const nextId = (seen: World): string => {
  seen.discord.counter += 1
  return String(1_000_000_000_000_000_000n + BigInt(seen.discord.counter))
}

/** What the bot posted: Discord markdown as sent, with its message id and the message it replied to. */
export const posts = (seen: World): { text: string; id: string; replyTo?: string }[] =>
  seen.discord.messages.filter(one => one.isBot).map(one => ({ text: one.content, id: one.id, ...(one.replyTo !== undefined ? { replyTo: one.replyTo } : {}) }))

/** The reactions the bot put on a message. */
export const botReactions = (seen: World, id: string): string[] =>
  (seen.discord.messages.find(one => one.id === id)?.reactions ?? []).filter(reaction => reaction.users.includes(BOT)).map(reaction => reaction.emoji)

/** Someone writes in the channel (optionally replying to a message). */
export function say(seen: World, input: { user: string; text: string; replyTo?: string; type?: number; name?: string }): string {
  const id = nextId(seen)
  seen.discord.messages.push({
    id,
    userId: input.user,
    username: input.name ?? (input.user === OWNER ? 'owner' : 'member'),
    isBot: false,
    content: input.text,
    ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
    type: input.type ?? (input.replyTo !== undefined ? 19 : 0),
    reactions: [],
  })
  return id
}

/** Someone reacts to a message. */
export function react(seen: World, id: string, user: string, emoji: string): void {
  const message = seen.discord.messages.find(one => one.id === id)
  const existing = message?.reactions.find(one => one.emoji === emoji)
  if (existing !== undefined) existing.users.push(user)
  else message?.reactions.push({ emoji, users: [user] })
}

const view = (message: Message) => ({
  id: message.id,
  type: message.type,
  content: message.content,
  author: { id: message.userId, username: message.username, ...(message.isBot ? { bot: true } : {}) },
  attachments: [],
  embeds: [],
  ...(message.replyTo !== undefined ? { message_reference: { message_id: message.replyTo } } : {}),
})

function rest(seen: World, method: string, path: string, body: Record<string, unknown>, isAuthorized: boolean) {
  const discord = seen.discord
  discord.calls.push({ method, path, body })
  if (!isAuthorized || !discord.isTokenValid) return json(401, { message: '401: Unauthorized', code: 0 })
  if (method === 'GET' && path === '/users/@me') return json(200, { id: BOT, username: 'claude', bot: true })
  const messages = /^\/channels\/(\d+)\/messages(?:\?(.*))?$/.exec(path)
  if (messages !== null && messages[1] === CHANNEL) {
    if (!discord.canRead) return json(403, { message: 'Missing Access', code: 50001 })
    if (method === 'GET') {
      const params = new Map((messages[2] ?? '').split('&').filter(Boolean).map(pair => pair.split('=') as [string, string]))
      const limit = Number(params.get('limit') ?? 50)
      const after = params.get('after')
      let list = discord.messages
      if (after !== undefined) list = list.filter(one => BigInt(one.id) > BigInt(after)).slice(0, limit)
      else list = list.slice(-limit)
      return json(200, [...list].reverse().map(view))
    }
    const id = nextId(seen)
    const reference = body.message_reference as { message_id?: string } | undefined
    discord.messages.push({ id, userId: BOT, username: 'claude', isBot: true, content: String(body.content), type: reference !== undefined ? 19 : 0, ...(reference?.message_id !== undefined ? { replyTo: reference.message_id } : {}), reactions: [] })
    return json(200, { id, channel_id: CHANNEL })
  }
  const reaction = /^\/channels\/(\d+)\/messages\/(\d+)\/reactions\/([^/?]+)(?:\/@me|\?.*)$/.exec(path)
  if (reaction !== null) {
    const emoji = decodeURIComponent(reaction[3] ?? '')
    const id = reaction[2] ?? ''
    if (method === 'PUT') {
      react(seen, id, BOT, emoji)
      return { value: { status: 204, ok: true, headers: {}, text: '' } }
    }
    const users = discord.messages.find(one => one.id === id)?.reactions.find(one => one.emoji === emoji)?.users ?? []
    return json(200, users.map(userId => ({ id: userId, username: 'x' })))
  }
  return json(404, { message: 'Unknown', code: 10003 })
}

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/'))

/** The engine beneath the plugin: files, Discord, the session, the model and the host, all in memory. */
export function world(on: On, options: { now?: number; files?: Record<string, string> } = {}): World {
  const seen: World = {
    clock: (startClock = mock.clock(on, { now: options.now ?? new Date(2026, 9, 7, 12, 0, 0).getTime() })),
    files: new Map(Object.entries(options.files ?? {})),
    discord: { messages: [], calls: [], hooks: [], uploads: [], counter: 0, isTokenValid: true, canRead: true },
    submitted: [],
    toasts: [],
    aborted: [],
    forks: [],
  }
  mock.env(on, { HOME })
  mock.store(on)
  const mtimes = new Map<string, number>()
  on('fs.read', ($, e) => {
    const text = seen.files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: e.as === 'bytes' ? { base64: text } : text }
  })
  on('fs.write', ($, e) => {
    seen.files.set(e.path, e.text)
    mtimes.set(e.path, seen.clock.now())
    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    const names = [...seen.files.keys()].filter(path => parentOf(path) === e.path)
    if (names.length === 0) return { deny: `ENOENT: ${e.path}` }
    return { value: names.map(path => ({ name: path.slice(e.path.length + 1), kind: 'file' as const, size: (seen.files.get(path) ?? '').length, mtimeMs: mtimes.get(path) ?? seen.clock.now(), isLink: false })) }
  })
  on('fs.stat', ($, e) => {
    const isDir = [...seen.files.keys()].some(path => path.startsWith(`${e.path}/`)) || e.path === ROOT
    const text = seen.files.get(e.path)
    if (text === undefined && !isDir) return { deny: `ENOENT: ${e.path}` }
    return { value: { kind: isDir ? ('dir' as const) : ('file' as const), size: text?.length ?? 0, mtimeMs: mtimes.get(e.path) ?? 0, isLink: false, realPath: e.path } }
  })
  on('http.fetch', ($, e) => {
    if (e.url === `${WEBHOOK}?wait=true`) {
      seen.discord.hooks.push(typeof e.init?.body === 'string' ? String((JSON.parse(e.init.body) as { content?: string }).content) : '')
      return json(200, { id: nextId(seen) })
    }
    const prefix = 'https://discord.com/api/v10'
    if (!e.url.startsWith(prefix)) return json(404, { message: 'no route' })
    const body: Record<string, unknown> = typeof e.init?.body === 'string' ? (JSON.parse(e.init.body) as Record<string, unknown>) : {}
    return rest(seen, e.init?.method ?? 'GET', e.url.slice(prefix.length), body, e.init?.headers?.Authorization === `Bot ${TOKEN}`)
  })
  on('process.run', async ($, e) => {
    const [binary = ''] = e.argv
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (binary === 'sleep') {
      await seen.clock.sleep(Number(e.argv[1] ?? 1) * 1000)
      return ok('')
    }
    if (binary === 'git') return ok('feature/login\n')
    if (binary === 'curl') {
      seen.discord.uploads.push({ argv: [...e.argv], stdin: e.init?.stdin ?? '' })
      return ok(JSON.stringify({ id: nextId(seen) }))
    }
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
  on('tool.register', ($, e) => ({ value: { tool: `mcp__discord-bridge__${e.name}` } }))
  on('tool.check', () => ({ decision: 'ask' }))
  on('prompt.submit', ($, e) => {
    if (e.origin.kind === 'plugin') seen.submitted.push({ text: e.text, asUser: (e.origin as { asUser?: boolean }).asUser === true })
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
    return { value: { isAnswered: true, text: 'The login page is done; tests are next. See /home/me/secret/plan.md, it cost $4.20.', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
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

/** A configured machine: no prefs beyond turning the "Run this?" step off. */
export const configured = (extra: Record<string, string> = {}): Record<string, string> => ({
  [`${DIR}/prefs.json`]: JSON.stringify({ confirmPrompts: false }),
  ...extra,
})

export const OPTIONS = { botToken: TOKEN, channelId: CHANNEL, ownerId: OWNER, pollSeconds: 3 }

/** The running test's mock clock (each world makes one). */
let startClock: MockClock | undefined

/** Starts the session and lets the start-up run: it waits until session.start has returned (afterStart). */
export const start = async ($: Engine) => {
  const started = await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await startClock?.advance(1_500)
  return started
}

export const discord = async ($: Engine, args: string): Promise<string> =>
  (await $.command.run({ command: 'discord', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })).text ?? ''

/** Moves time on in steps, so polls, heartbeats and the inbox all get their turns. */
export async function pass(seen: World, ms: number, step = 1_000): Promise<void> {
  for (let done = 0; done < ms; done += step) await seen.clock.advance(step)
}

/** Starts the session and lets the lease settle so this session is the verified leader and has noted "now". */
export async function lead($: Engine, seen: World): Promise<void> {
  await start($)
  await pass(seen, 12_000)
}
