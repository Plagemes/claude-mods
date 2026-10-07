import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

export const HOME = '/home/me'
export const DIR = `${HOME}/.claude/claude-mods/slack`
export const ROOT = '/work/shop'
export const ME = 'sess-a'
// Assembled from parts so secret scanners don't mistake the fixture for a real token.
export const TOKEN = ['xoxb', '1111111111', '2222222222', 'fakeTokenForTests0123456789'].join('-')
export const WEBHOOK = 'https://hooks.slack.com/services/T0000000/B0000000/fakeWebhookSecretForTests01'
export const BOT = 'UBOT00001'
export const OWNER = 'U0OWNER01'
export const MEMBER = 'U0MEMBER1'
export const CHANNEL = 'C0SHOP001'

type Message = { ts: string; user: string; text: string; bot_id?: string; subtype?: string; reactions: { name: string; users: string[] }[]; replies: Message[] }

/** Slack in memory: the channel's messages, their reactions and threads, and every call the bot made. */
export type FakeSlack = {
  messages: Message[]
  calls: { method: string; params: Record<string, unknown> }[]
  hooks: string[]
  counter: number
  isTokenValid: boolean
  isMember: boolean
}

export type World = {
  clock: MockClock
  files: Map<string, string>
  slack: FakeSlack
  submitted: { text: string; asUser: boolean }[]
  toasts: string[]
  aborted: string[]
  forks: string[]
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  value: { status, ok: status >= 200 && status < 300, headers: { 'content-type': 'application/json', ...headers }, text: JSON.stringify(body) },
})

const nextTs = (seen: World): string => {
  seen.slack.counter += 1
  return `${Math.floor(seen.clock.now() / 1000)}.${String(seen.slack.counter).padStart(6, '0')}`
}

/** What the bot posted: text (Slack entities undone) and message ts. */
export const posts = (seen: World): { text: string; ts: string }[] =>
  seen.slack.messages.filter(one => one.bot_id !== undefined).map(one => ({ text: one.text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'), ts: one.ts }))

/** The reactions the bot put on a message, as Slack names. */
export const botReactions = (seen: World, ts: string): string[] =>
  (seen.slack.messages.find(one => one.ts === ts)?.reactions ?? []).filter(reaction => reaction.users.includes(BOT)).map(reaction => reaction.name)

/** Someone writes in the channel. */
export function say(seen: World, input: { user: string; text: string; subtype?: string }): string {
  const ts = nextTs(seen)
  seen.slack.messages.push({ ts, user: input.user, text: input.text, ...(input.subtype !== undefined ? { subtype: input.subtype } : {}), reactions: [], replies: [] })
  return ts
}

/** Someone replies in the thread of a message. */
export function reply(seen: World, parentTs: string, input: { user: string; text: string }): string {
  const parent = seen.slack.messages.find(one => one.ts === parentTs)
  const ts = nextTs(seen)
  parent?.replies.push({ ts, user: input.user, text: input.text, reactions: [], replies: [] })
  return ts
}

/** Someone reacts to a message. */
export function react(seen: World, ts: string, user: string, name: string): void {
  const message = seen.slack.messages.find(one => one.ts === ts)
  const existing = message?.reactions.find(one => one.name === name)
  if (existing !== undefined) existing.users.push(user)
  else message?.reactions.push({ name, users: [user] })
}

const view = (message: Message) => ({ type: 'message', ts: message.ts, user: message.user, text: message.text, ...(message.bot_id !== undefined ? { bot_id: message.bot_id } : {}), ...(message.subtype !== undefined ? { subtype: message.subtype } : {}) })

function web(seen: World, method: string, params: Record<string, unknown>, authorized: boolean) {
  const slack = seen.slack
  slack.calls.push({ method, params })
  if (!authorized || !slack.isTokenValid) return json(200, { ok: false, error: 'invalid_auth' })
  switch (method) {
    case 'auth.test':
      return json(200, { ok: true, user_id: BOT, user: 'claude', team: 'Acme' })
    case 'conversations.info':
      return slack.isMember ? json(200, { ok: true, channel: { id: CHANNEL, name: 'dev', is_member: true } }) : json(200, { ok: false, error: 'channel_not_found' })
    case 'conversations.history': {
      if (!slack.isMember) return json(200, { ok: false, error: 'channel_not_found' })
      const oldest = params.oldest === undefined ? 0 : Number(params.oldest)
      const limit = Number(params.limit ?? 100)
      const newer = slack.messages.filter(one => Number(one.ts) > oldest).reverse()
      return json(200, { ok: true, messages: newer.slice(0, limit).map(view), has_more: false })
    }
    case 'conversations.replies': {
      const parent = slack.messages.find(one => one.ts === params.ts)
      const oldest = params.oldest === undefined ? 0 : Number(params.oldest)
      return json(200, { ok: true, messages: [...(parent === undefined ? [] : [view(parent)]), ...(parent?.replies ?? []).filter(one => Number(one.ts) > oldest).map(view)] })
    }
    case 'reactions.get': {
      const message = slack.messages.find(one => one.ts === params.timestamp)
      return message === undefined ? json(200, { ok: false, error: 'message_not_found' }) : json(200, { ok: true, message: { ...view(message), reactions: message.reactions } })
    }
    case 'reactions.add': {
      react(seen, String(params.timestamp), BOT, String(params.name))
      return json(200, { ok: true })
    }
    case 'chat.postMessage': {
      const ts = nextTs(seen)
      slack.messages.push({ ts, user: BOT, bot_id: 'B0BOT', text: String(params.text), reactions: [], replies: [] })
      return json(200, { ok: true, ts, channel: params.channel })
    }
    default:
      return json(200, { ok: false, error: 'unknown_method' })
  }
}

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/'))

/** The engine beneath the plugin: files, Slack, the session, the model and the host, all in memory. */
export function world(on: On, options: { now?: number; files?: Record<string, string> } = {}): World {
  const seen: World = {
    clock: mock.clock(on, { now: options.now ?? new Date(2026, 9, 7, 12, 0, 0).getTime() }),
    files: new Map(Object.entries(options.files ?? {})),
    slack: { messages: [], calls: [], hooks: [], counter: 0, isTokenValid: true, isMember: true },
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
    if (e.url === WEBHOOK) {
      const text = typeof e.init?.body === 'string' ? String((JSON.parse(e.init.body) as { text?: string }).text) : ''
      seen.slack.hooks.push(text)
      return { value: { status: 200, ok: true, headers: {}, text: 'ok' } }
    }
    const match = /^https:\/\/slack\.com\/api\/([\w.]+)(?:\?(.*))?$/.exec(e.url)
    if (match === null) return json(404, { ok: false })
    const params: Record<string, unknown> = typeof e.init?.body === 'string' ? (JSON.parse(e.init.body) as Record<string, unknown>) : {}
    for (const pair of (match[2] ?? '').split('&').filter(Boolean)) {
      const [key = '', value = ''] = pair.split('=')
      params[decodeURIComponent(key)] = decodeURIComponent(value)
    }
    return web(seen, match[1] ?? '', params, e.init?.headers?.Authorization === `Bearer ${TOKEN}`)
  })
  on('process.run', async ($, e) => {
    const [binary = ''] = e.argv
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (binary === 'sleep') {
      await seen.clock.sleep(Number(e.argv[1] ?? 1) * 1000)
      return ok('')
    }
    if (binary === 'git') return ok('feature/login\n')
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
  on('tool.register', ($, e) => ({ value: { tool: `mcp__slack-bridge__${e.name}` } }))
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

export const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

export const slack = async ($: Engine, args: string): Promise<string> =>
  (await $.command.run({ command: 'slack', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })).text ?? ''

/** Moves time on in steps, so polls, heartbeats and the inbox all get their turns. */
export async function pass(seen: World, ms: number, step = 1_000): Promise<void> {
  for (let done = 0; done < ms; done += step) await seen.clock.advance(step)
}

/** Starts the session and lets the lease settle so this session is the verified leader and has noted "now". */
export async function lead($: Engine, seen: World): Promise<void> {
  await start($)
  await pass(seen, 12_000)
}
