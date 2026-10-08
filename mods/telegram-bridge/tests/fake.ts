import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'


export const HOME = '/home/me'
export const DIR = `${HOME}/.claude/claude-mods/telegram`
export const ROOT = '/work/shop'
export const ME = 'sess-a'
export const TOKEN = '123456:AAE-fakeTokenForTests0123456789abcdefg'
export const OWNER = '4242'
export const MEMBER = '777'
export const GROUP = '-100123456'
export const OTHER_GROUP = '-100999999'

export type Call = { method: string; body: Record<string, unknown> }

/** Telegram in memory: the updates waiting for getUpdates, and every call the bot made. */
export type FakeTg = {
  updates: Record<string, unknown>[]
  calls: Call[]
  nextUpdate: number
  nextMessage: number
  botName: string
  isTokenValid: boolean
  /** Messages the bot sent: chat, id, the HTML it sent, the buttons. */
  sent: { chatId: string; id: number; html: string; buttons: { text: string; data: string }[] }[]
}

export type World = {
  clock: MockClock
  files: Map<string, string>
  tg: FakeTg
  submitted: { text: string; asUser: boolean }[]
  toasts: string[]
  /** The tools registered with the engine, in order. */
  tools: string[]
  aborted: string[]
  forks: string[]
  processes: { argv: string[]; stdin?: string }[]
  mods: Map<string, string>
}

const json = (status: number, body: unknown) => ({
  value: { status, ok: status >= 200 && status < 300, headers: { 'content-type': 'application/json' }, text: JSON.stringify(body) },
})

const tagsOff = (html: string): string => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** The texts the bot sent, tags removed, with chat id and buttons. */
export const sends = (seen: World): { chatId: string; text: string; buttons: string[]; id: number }[] =>
  seen.tg.sent.map(one => ({ chatId: one.chatId, text: tagsOff(one.html), buttons: one.buttons.map(button => button.text), id: one.id }))

const chatOf = (id: string) => (id.startsWith('-') ? { id: Number(id), type: 'supergroup', title: id === GROUP ? 'Shop team' : 'Other' } : { id: Number(id), type: 'private', first_name: 'Person' })

/** Someone writes to the bot (or in a group the bot is in). */
export function say(seen: World, input: { chatId: string; fromId: string; text: string; name?: string; replyTo?: { id: number; fromBot?: boolean } }): void {
  seen.tg.nextUpdate += 1
  seen.tg.updates.push({
    update_id: seen.tg.nextUpdate,
    message: {
      message_id: 9000 + seen.tg.nextUpdate,
      from: { id: Number(input.fromId), is_bot: false, first_name: input.name ?? (input.fromId === OWNER ? 'Owner' : 'Member') },
      chat: chatOf(input.chatId),
      date: Math.floor(seen.clock.now() / 1000),
      text: input.text,
      ...(input.replyTo !== undefined ? { reply_to_message: { message_id: input.replyTo.id, from: { id: input.replyTo.fromBot === false ? 5 : 123456, is_bot: input.replyTo.fromBot !== false } } } : {}),
    },
  })
}

/** Someone taps an inline button on a message of the bot. */
export function tap(seen: World, input: { chatId: string; fromId: string; messageId: number; data: string }): void {
  seen.tg.nextUpdate += 1
  seen.tg.updates.push({
    update_id: seen.tg.nextUpdate,
    callback_query: {
      id: `cb${seen.tg.nextUpdate}`,
      from: { id: Number(input.fromId), is_bot: false, first_name: 'Owner' },
      message: { message_id: input.messageId, chat: chatOf(input.chatId), date: 0 },
      data: input.data,
    },
  })
}

/** The callback data of the nth button of the bot's last message with buttons. */
export const buttonData = (seen: World, index: number): string => seen.tg.sent.filter(one => one.buttons.length > 0).at(-1)?.buttons[index]?.data ?? ''
export const lastWithButtons = (seen: World): { chatId: string; id: number } => {
  const one = seen.tg.sent.filter(item => item.buttons.length > 0).at(-1)
  return { chatId: one?.chatId ?? '', id: one?.id ?? 0 }
}

function bot(seen: World, method: string, body: Record<string, unknown>) {
  const tg = seen.tg
  tg.calls.push({ method, body })
  if (!tg.isTokenValid) return json(401, { ok: false, error_code: 401, description: 'Unauthorized' })
  switch (method) {
    case 'getMe':
      return json(200, { ok: true, result: { id: 123456, is_bot: true, first_name: 'Claude', username: tg.botName } })
    case 'getUpdates': {
      const offset = typeof body.offset === 'number' ? body.offset : 0
      if (offset > 0) tg.updates = tg.updates.filter(update => Number(update.update_id) >= offset)
      const limit = typeof body.limit === 'number' ? body.limit : 100
      return json(200, { ok: true, result: tg.updates.slice(0, limit) })
    }
    case 'sendMessage': {
      tg.nextMessage += 1
      const markup = body.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] } | undefined
      tg.sent.push({
        chatId: String(body.chat_id),
        id: tg.nextMessage,
        html: String(body.text),
        buttons: (markup?.inline_keyboard ?? []).flat().map(button => ({ text: button.text, data: button.callback_data })),
      })
      return json(200, { ok: true, result: { message_id: tg.nextMessage, chat: { id: Number(body.chat_id) } } })
    }
    case 'editMessageReplyMarkup': {
      const target = tg.sent.find(one => one.id === Number(body.message_id))
      if (target !== undefined) target.buttons = []
      return json(200, { ok: true, result: true })
    }
    case 'answerCallbackQuery':
    case 'setMessageReaction':
      return json(200, { ok: true, result: true })
    default:
      return json(404, { ok: false, error_code: 404, description: `no method ${method}` })
  }
}

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/'))

/** The engine beneath the plugin: files, Telegram, the session, the model and the host, all in memory. */
export function world(on: On, options: { now?: number; files?: Record<string, string> } = {}): World {
  const seen: World = {
    clock: mock.clock(on, { now: options.now ?? new Date(2026, 9, 7, 12, 0, 0).getTime() }),
    files: new Map(Object.entries(options.files ?? {})),
    tg: { updates: [], calls: [], nextUpdate: 100, nextMessage: 500, botName: 'claude_bot', isTokenValid: true, sent: [] },
    submitted: [],
    toasts: [],
    tools: [],
    aborted: [],
    forks: [],
    processes: [],
    mods: new Map(),
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
    const match = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(e.url)
    if (match === null || match[1] !== TOKEN) return json(404, { ok: false, description: 'wrong token or url' })
    const body = typeof e.init?.body === 'string' ? (JSON.parse(e.init.body) as Record<string, unknown>) : {}
    return bot(seen, match[2] ?? '', body)
  })
  on('process.run', async ($, e) => {
    seen.processes.push({ argv: [...e.argv], ...(e.init?.stdin !== undefined ? { stdin: e.init.stdin } : {}) })
    const [binary = ''] = e.argv
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (binary === 'sleep') {
      await seen.clock.sleep(Number(e.argv[1] ?? 1) * 1000)
      return ok('')
    }
    if (binary === 'git') return ok('feature/login\n')
    if (binary === 'curl') {
      seen.tg.nextMessage += 1
      return ok(JSON.stringify({ ok: true, result: { message_id: seen.tg.nextMessage } }))
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
  on('tool.register', ($, e) => {
    seen.tools.push(e.name)
    return { value: { tool: `mcp__telegram-bridge__${e.name}` } }
  })
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

/** A configured machine: token, owner, this project linked to its group. */
export const configured = (extra: Record<string, string> = {}): Record<string, string> => ({
  [`${DIR}/config.json`]: JSON.stringify({ ownerId: OWNER }),
  [`${DIR}/groups.json`]: JSON.stringify({ [ROOT]: { chatId: GROUP, title: 'Shop team', linkedAt: 0 } }),
  [`${DIR}/prefs.json`]: JSON.stringify({ confirmPrompts: false }),
  ...extra,
})

export const OPTIONS = { botToken: TOKEN, ownerId: OWNER }

export const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

export const telegram = async ($: Engine, args: string): Promise<string> =>
  (await $.command.run({ command: 'telegram', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })).text ?? ''

/** Moves time on in steps, so polls, heartbeats and the inbox all get their turns. */
export async function pass(seen: World, ms: number, step = 1_000): Promise<void> {
  for (let done = 0; done < ms; done += step) await seen.clock.advance(step)
}

/** Starts the session and lets the lease settle so this session is the verified leader and has read the backlog. */
export async function lead($: Engine, seen: World): Promise<void> {
  await start($)
  await pass(seen, 12_000)
}
