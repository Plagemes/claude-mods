import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandRunInput, On, TurnCompleteInput } from 'claude-code'

import type { ModsNotice } from '../types/mods-hub'
import { fakeHub } from './hub'

/** The mock clock of the running test, moved on past afterStart's delay so the hub hello is sent. */
let startClock: ReturnType<typeof mock.clock> | undefined

const SLACK = 'https://hooks.slack.com/services/T000/B000/XXXX'
const DISCORD = 'https://discord.com/api/webhooks/123/abc'
const NTFY = 'https://ntfy.sh/my-builds'

const LONG_TURN: TurnCompleteInput = {
  answer: 'Refactored the <checkout> flow & added tests. Everything passes.',
  durationMs: 192_000,
  isAborted: false,
  turnId: 'turn-1',
  reason: 'answer',
}

const NOTIFY_TEST: CommandRunInput = {
  command: 'notify-test',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
}

type Post = { url: string; headers: Record<string, string>; body: string }
type World = { posts: Post[]; toasts: string[] }

/** The engine beneath the plugin: a git repo named "shop" on branch main, and a webhook answering `status`. */
function world(on: On, status = 200): World {
  const seen: World = { posts: [], toasts: [] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: 'ok' }))
  on('session.repo', () => ({ value: { root: '/home/me/shop', remote: null, internal: false, name: null } }))
  on('session.root', () => ({ value: '/home/me/shop' }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('http.fetch', ($, e) => {
    seen.posts.push({ url: e.url, headers: e.init?.headers ?? {}, body: e.init?.body ?? '' })
    return { value: { status, ok: status < 300, headers: {}, text: status < 300 ? 'ok' : 'no_such_hook' } }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  return seen
}

async function runTurn($: Engine, turn: TurnCompleteInput): Promise<void> {
  await $.turn.start({ text: 'refactor checkout', turnId: turn.turnId })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: 'npm run lint' })
  await $.tool.call({ tool: 'Edit', file_path: '/home/me/shop/a.ts', old_string: 'a', new_string: 'b' })
  await $.turn.complete(turn)
}

test('posts a Slack message with project, branch, duration, summary and tool counts', { options: { webhookUrl: SLACK } }, async ($, on) => {
  const clock = (startClock = mock.clock(on))
  const seen = world(on)

  await runTurn($, LONG_TURN)
  await clock.advance(0)

  expect(seen.posts).toHaveLength(1)
  const post = seen.posts[0]!
  expect(post.url).toBe(SLACK)
  const text = String(JSON.parse(post.body).text)
  expect(text).toContain('✅ Claude finished in shop (main)')
  expect(text).toContain('3m 12s')
  expect(text).toContain('Refactored the &lt;checkout&gt; flow &amp; added tests.')
  expect(text).toContain('Bash ×2 · Edit ×1')
  expect(seen.toasts).toEqual([])
})

test('stays silent for short or interrupted turns', { options: { webhookUrl: SLACK, minDurationSec: 120 } }, async ($, on) => {
  const clock = (startClock = mock.clock(on))
  const seen = world(on)

  await runTurn($, { ...LONG_TURN, durationMs: 30_000 })
  await runTurn($, { ...LONG_TURN, reason: 'aborted', isAborted: true })
  await clock.advance(0)

  expect(seen.posts).toEqual([])
})

test('does nothing until a webhook URL is set', async ($, on) => {
  const clock = (startClock = mock.clock(on))
  const seen = world(on)
  await runTurn($, LONG_TURN)
  await clock.advance(0)
  expect(seen.posts).toEqual([])
})

test('Discord payload uses an embed and disables mentions', { options: { webhookUrl: DISCORD } }, async ($, on) => {
  const clock = (startClock = mock.clock(on))
  const seen = world(on)

  await runTurn($, { ...LONG_TURN, reason: 'error' })
  await clock.advance(0)

  const body = JSON.parse(seen.posts[0]!.body)
  expect(body.allowed_mentions).toEqual({ parse: [] })
  expect(body.embeds[0].title).toContain('stopped on an error')
  expect(body.embeds[0].fields[0]).toEqual({ name: 'Duration', value: '3m 12s', inline: true })
})

test('ntfy topics are published as JSON to the server root', { options: { webhookUrl: NTFY } }, async ($, on) => {
  const clock = (startClock = mock.clock(on))
  const seen = world(on)

  await runTurn($, LONG_TURN)
  await clock.advance(0)

  expect(seen.posts[0]!.url).toBe('https://ntfy.sh/')
  const body = JSON.parse(seen.posts[0]!.body)
  expect(body.topic).toBe('my-builds')
  expect(body.title).toBe('Claude finished in shop (main)')
  expect(body.tags).toEqual(['white_check_mark'])
})

test('/notify-test explains a missing URL', async ($, on) => {
  world(on)
  const result = await $.command.run(NOTIFY_TEST)

  expect(result.text).toContain('no webhook URL yet')
})

test('/notify-test reports what the webhook answered, and failures toast', { options: { webhookUrl: SLACK } }, async ($, on) => {
  const clock = (startClock = mock.clock(on))
  const seen = world(on, 404)

  const result = await $.command.run(NOTIFY_TEST)
  expect(result.text).toContain('📭 webhook-notify: slack webhook answered HTTP 404')
  expect(JSON.parse(seen.posts[0]!.body).text).toContain('Test notification')

  await runTurn($, LONG_TURN)
  await clock.advance(0)
  expect(seen.toasts[0]).toContain('HTTP 404')
})

const notice = (fields: Partial<ModsNotice>): ModsNotice => ({
  id: 'n1', level: 'error', title: 'CI failed on main', source: 'ci-watch', at: 0, targets: ['webhook'], held: false, ...fields,
})

const start = ($: Engine) => $.session.start({ cwd: '/home/me/shop', surface: 'terminal', isInteractive: true })

test('masks secrets in the answer before it leaves the machine', { options: { webhookUrl: SLACK } }, async ($, on) => {
  const clock = (startClock = mock.clock(on))
  const seen = world(on)
  const token = `ghp_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`

  await runTurn($, { ...LONG_TURN, answer: `Deployed with token ${token} in the env.` })
  await clock.advance(0)

  const text = String(JSON.parse(seen.posts[0]!.body).text)
  expect(text).not.toContain(token)
  expect(text).toContain('[REDACTED:')
  expect(text).toContain('Deployed with token')
})

test('with mods-hub: registers the webhook channel for the team and posts what the hub queued for it', { options: { webhookUrl: SLACK } }, async ($, on) => {
  const clock = (startClock = mock.clock(on))
  const seen = world(on)
  const hub = fakeHub(on)

  await start($)
  await startClock?.advance(1_500) // the hello waits for session.start to return (afterStart)
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve()
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: [], consumes: [] }])
  expect(hub.channels).toEqual([{ id: 'webhook', title: 'Webhook', audience: 'team', delivery: 'pull', status: 'connected' }])

  await clock.advance(5_000)
  expect(seen.posts).toEqual([])

  hub.outbox.push(
    notice({ title: 'CI failed on <main>', body: 'run 8 & token ghp_' + 'Zz9Yy8Xx7W'.repeat(4).slice(0, 36), url: 'https://github.com/acme/shop/actions/runs/8' }),
    notice({ id: 'n2', level: 'success', title: 'All green' }),
  )
  await clock.advance(5_000)

  expect(seen.posts).toHaveLength(2)
  const first = String(JSON.parse(seen.posts[0]!.body).text)
  expect(first).toContain('*❌ CI failed on &lt;main&gt;*')
  expect(first).toContain('[REDACTED:')
  expect(first).not.toContain('Zz9Yy8Xx7W')
  expect(first).toContain('<https://github.com/acme/shop/actions/runs/8|Open>')
  expect(JSON.parse(seen.posts[1]!.body).text).toBe('*✅ All green*')
  expect(hub.drains[0]).toEqual({ channel: 'webhook', after: null })

  // The next collection acknowledges what was posted, which the hub then drops: nothing is posted twice.
  await clock.advance(5_000)
  expect(hub.drains.at(-1)).toEqual({ channel: 'webhook', after: 'n2' })
  expect(hub.outbox).toEqual([])
  expect(seen.posts).toHaveLength(2)
  expect(hub.statuses).toEqual([])
})

test('with mods-hub: an ntfy topic is a channel for you alone, and notices keep their priority', { options: { webhookUrl: NTFY } }, async ($, on) => {
  const clock = (startClock = mock.clock(on))
  const seen = world(on)
  const hub = fakeHub(on)

  await start($)
  await startClock?.advance(1_500) // the hello waits for session.start to return (afterStart)
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve()
  expect(hub.channels[0]).toMatchObject({ id: 'webhook', audience: 'me', status: 'connected' })

  hub.outbox.push(notice({ level: 'critical', title: 'Budget exceeded', body: 'over by $4' }))
  await clock.advance(5_000)

  expect(seen.posts[0]!.url).toBe('https://ntfy.sh/')
  expect(JSON.parse(seen.posts[0]!.body)).toEqual({ topic: 'my-builds', title: 'Budget exceeded', message: 'over by $4', tags: ['rotating_light'], priority: 5 })
})

test('with mods-hub: Discord gets a notice embed in the level colour', { options: { webhookUrl: DISCORD } }, async ($, on) => {
  const clock = (startClock = mock.clock(on))
  const seen = world(on)
  const hub = fakeHub(on)

  await start($)
  await startClock?.advance(1_500) // the hello waits for session.start to return (afterStart)
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve()
  hub.outbox.push(notice({ level: 'warning', title: 'Slow tests', body: '3 tests over 1 s', topic: 'test.result' }))
  await clock.advance(5_000)

  const body = JSON.parse(seen.posts[0]!.body)
  expect(body.allowed_mentions).toEqual({ parse: [] })
  expect(body.embeds[0]).toEqual({ title: '⚠️ Slow tests', color: 0xecb22e, description: '3 tests over 1 s' })
})

test('with mods-hub and no webhook URL: the channel is unconfigured and nothing is collected', async ($, on) => {
  const clock = (startClock = mock.clock(on))
  const seen = world(on)
  const hub = fakeHub(on)

  await start($)
  hub.outbox.push(notice({}))
  await clock.advance(10_000)

  expect(hub.channels).toEqual([{ id: 'webhook', title: 'Webhook', audience: 'team', delivery: 'pull', status: 'unconfigured', detail: 'set the "webhookUrl" option' }])
  expect(seen.posts).toEqual([])
})

test('with mods-hub: the channel shows error once the webhook refuses a post, once', { options: { webhookUrl: SLACK } }, async ($, on) => {
  const clock = (startClock = mock.clock(on))
  const seen = world(on, 404)
  const hub = fakeHub(on)

  await start($)
  await startClock?.advance(1_500) // the hello waits for session.start to return (afterStart)
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve()
  hub.outbox.push(notice({ title: 'one' }), notice({ id: 'n2', title: 'two' }))
  await clock.advance(5_000)
  // The refused notice stays first in line: the one behind it waits for it.
  expect(seen.posts).toHaveLength(1)
  await clock.advance(5_000)
  expect(seen.posts).toHaveLength(2)
  expect(JSON.parse(seen.posts[1]!.body).text).toBe(JSON.parse(seen.posts[0]!.body).text)
  expect(hub.statuses).toEqual([{ id: 'webhook', status: 'error', detail: 'slack webhook answered HTTP 404 no_such_hook' }])
})

test('with mods-hub: a notice whose post failed is posted again on the next collection, once, and the channel recovers', { options: { webhookUrl: SLACK } }, async ($, on) => {
  const clock = (startClock = mock.clock(on))
  const posts: string[] = []
  let isDown = true
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('http.fetch', ($, e) => {
    if (isDown) return { deny: `connect ECONNREFUSED while posting to ${e.url}` }
    posts.push(String(JSON.parse(e.init?.body ?? '{}').text))
    return { value: { status: 200, ok: true, headers: {}, text: 'ok' } }
  })
  const hub = fakeHub(on)

  await start($)
  await startClock?.advance(1_500) // the hello waits for session.start to return (afterStart)
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve()
  hub.outbox.push(notice({ title: 'Deploy failed' }), notice({ id: 'n2', level: 'success', title: 'All green' }))
  await clock.advance(5_000)
  expect(posts).toEqual([])
  expect(hub.outbox.map(one => one.id)).toEqual(['n1', 'n2'])
  // The webhook URL is a credential: an error that echoes it shows [webhook] instead.
  expect(hub.statuses.at(-1)?.status).toBe('error')
  expect(hub.statuses.at(-1)?.detail).not.toContain('hooks.slack.com/services')
  expect(hub.statuses.at(-1)?.detail).not.toContain('XXXX')
  expect(hub.statuses.at(-1)?.detail).toContain('[webhook]')

  isDown = false
  await clock.advance(5_000)
  expect(posts).toEqual(['*❌ Deploy failed*', '*✅ All green*'])
  expect(hub.statuses.at(-1)).toEqual({ id: 'webhook', status: 'connected' })
  await clock.advance(5_000)
  expect(hub.drains.at(-1)).toEqual({ channel: 'webhook', after: 'n2' })
  expect(posts).toHaveLength(2)
})

test('/notify-test never prints the webhook URL an error carries', { options: { webhookUrl: SLACK } }, async ($, on) => {
  on('session.repo', () => ({ value: null }))
  on('session.root', () => ({ value: '/home/me/shop' }))
  on('http.fetch', ($, e) => ({ deny: `getaddrinfo ENOTFOUND for ${e.url}` }))

  const result = await $.command.run(NOTIFY_TEST)
  expect(result.text).toContain('📭 webhook-notify: slack webhook failed')
  expect(result.text).not.toContain('/services/T000/B000/XXXX')
})

test('without mods-hub: session start registers the command only, and no timer collects anything', { options: { webhookUrl: SLACK } }, async ($, on) => {
  const clock = (startClock = mock.clock(on))
  const seen = world(on)

  await start($)
  await clock.advance(60_000)

  expect(seen.posts).toEqual([])
})

test('with mods-hub: a generic JSON webhook gets the notice as a plain object', { options: { webhookUrl: 'https://example.com/hooks/claude' } }, async ($, on) => {
  const clock = (startClock = mock.clock(on))
  const seen = world(on)
  const hub = fakeHub(on)

  await start($)
  await startClock?.advance(1_500) // the hello waits for session.start to return (afterStart)
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve()
  hub.outbox.push(notice({ level: 'info', title: 'FYI', topic: 'ci.result' }))
  await clock.advance(5_000)

  expect(JSON.parse(seen.posts[0]!.body)).toEqual({ source: 'claude-code', event: 'notification', level: 'info', title: 'FYI', body: null, url: null, topic: 'ci.result' })
})
