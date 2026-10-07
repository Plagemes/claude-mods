import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandRunInput, On, TurnCompleteInput } from 'claude-code'

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
  const clock = mock.clock(on)
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
  const clock = mock.clock(on)
  const seen = world(on)

  await runTurn($, { ...LONG_TURN, durationMs: 30_000 })
  await runTurn($, { ...LONG_TURN, reason: 'aborted', isAborted: true })
  await clock.advance(0)

  expect(seen.posts).toEqual([])
})

test('does nothing until a webhook URL is set', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)
  await runTurn($, LONG_TURN)
  await clock.advance(0)
  expect(seen.posts).toEqual([])
})

test('Discord payload uses an embed and disables mentions', { options: { webhookUrl: DISCORD } }, async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)

  await runTurn($, { ...LONG_TURN, reason: 'error' })
  await clock.advance(0)

  const body = JSON.parse(seen.posts[0]!.body)
  expect(body.allowed_mentions).toEqual({ parse: [] })
  expect(body.embeds[0].title).toContain('stopped on an error')
  expect(body.embeds[0].fields[0]).toEqual({ name: 'Duration', value: '3m 12s', inline: true })
})

test('ntfy topics are published as JSON to the server root', { options: { webhookUrl: NTFY } }, async ($, on) => {
  const clock = mock.clock(on)
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
  const clock = mock.clock(on)
  const seen = world(on, 404)

  const result = await $.command.run(NOTIFY_TEST)
  expect(result.text).toContain('📭 webhook-notify: slack webhook answered HTTP 404')
  expect(JSON.parse(seen.posts[0]!.body).text).toContain('Test notification')

  await runTurn($, LONG_TURN)
  await clock.advance(0)
  expect(seen.toasts[0]).toContain('HTTP 404')
})
