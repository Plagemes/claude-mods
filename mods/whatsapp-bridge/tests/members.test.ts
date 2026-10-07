import { expect, test } from 'claude-code/testing'

import { DIR, GROUP, OWNER_CHAT, arrive, configured, lead, pass, react, sends, world } from './fake'

const MEMBER = '447700900123@c.us'
const noConfirm = () => configured({ [`${DIR}/prefs.json`]: JSON.stringify({ presence: 'away', interaction: 'on', events: { confirmPrompts: false } }) })

test('a member’s question is answered from the transcript by a fork, with costs and paths hidden', async ($, on) => {
  const seen = world(on, { files: noConfirm() })
  seen.forkAnswer.text = 'Login is done. We spent $12.50 so far; config is in /Users/ana/secrets/app.env and API_TOKEN=abc123def456ghi.'
  await lead($, seen)
  arrive(seen, { chatId: GROUP, author: MEMBER, body: '? a che punto siete con il login?' })
  await pass(seen, 12_000)
  expect(seen.forks).toHaveLength(1)
  expect(seen.forks[0]).toContain('a che punto siete con il login?')
  expect(seen.forks[0]).toContain('not the owner')
  const answer = sends(seen).at(-1)
  expect(answer?.chatId).toBe(GROUP)
  expect(answer?.text.startsWith('🤖')).toBe(true)
  expect(answer?.text).toContain('Login is done.')
  expect(answer?.text).not.toContain('12.50')
  expect(answer?.text).not.toContain('/Users/ana')
  expect(answer?.text).not.toContain('abc123def456ghi')
  expect(seen.submitted).toEqual([])
})

test('members cannot command: chatter is ignored, "? stop" is only a question, the owner’s stop works', async ($, on) => {
  const seen = world(on, { files: noConfirm() })
  await lead($, seen)
  await $.turn.start({ text: 'refactor the cart', turnId: 'turn-1' })
  arrive(seen, { chatId: GROUP, author: MEMBER, body: 'stop' })
  arrive(seen, { chatId: GROUP, author: MEMBER, body: 'lol, nice work everyone' })
  await pass(seen, 12_000)
  expect(seen.forks).toEqual([])
  expect(seen.aborted).toEqual([])
  expect(sends(seen)).toEqual([])

  arrive(seen, { chatId: GROUP, author: MEMBER, body: '? stop' })
  await pass(seen, 12_000)
  expect(seen.forks).toHaveLength(1)
  expect(seen.aborted).toEqual([])

  arrive(seen, { chatId: GROUP, author: OWNER_CHAT, body: 'ferma' })
  await pass(seen, 12_000)
  expect(seen.aborted).toEqual(['turn-1'])
})

test('member questions are rate limited per member', async ($, on) => {
  const seen = world(on, { files: noConfirm() })
  await lead($, seen)
  for (let i = 1; i <= 7; i += 1) arrive(seen, { chatId: GROUP, author: MEMBER, body: `? question number ${i}` })
  await pass(seen, 20_000)
  expect(seen.forks).toHaveLength(5)
  expect(seen.files.get(`${DIR}/members.jsonl`)).toContain('"outcome":"limited"')
})

test('a member’s bug report becomes a draft; only the owner’s 👍 files the issue', async ($, on) => {
  const seen = world(on, { files: noConfirm() })
  await lead($, seen)
  arrive(seen, { chatId: GROUP, author: MEMBER, body: 'bug: the login form crashes when I press enter' })
  await pass(seen, 12_000)
  expect(seen.completions[0]).toContain('the login form crashes')
  const draft = seen.wa.rows.filter(row => row.direction === 'outgoing').at(-1)
  expect(draft?.body).toContain('Draft issue')
  expect(draft?.body).toContain('Login crashes on submit')

  react(seen, draft?.waMessageId ?? '', MEMBER, '👍')
  await pass(seen, 30_000)
  expect(seen.processes.filter(argv => argv[0] === 'gh')).toEqual([])

  react(seen, draft?.waMessageId ?? '', OWNER_CHAT, '👍')
  await pass(seen, 30_000)
  const filed = seen.processes.filter(argv => argv[0] === 'gh')
  expect(filed).toHaveLength(1)
  expect(filed[0]?.slice(0, 5)).toEqual(['gh', 'issue', 'create', '--title', 'Login crashes on submit'])
  expect(sends(seen).at(-1)?.text).toContain('https://github.com/acme/shop/issues/7')
})

test('a member’s vote on the owner’s confirmation does not count; the owner’s does', async ($, on) => {
  const seen = world(on, { files: configured({ [`${DIR}/prefs.json`]: JSON.stringify({ presence: 'away', interaction: 'on' }) }) })
  await lead($, seen)
  arrive(seen, { chatId: GROUP, author: OWNER_CHAT, body: 'deploy staging' })
  await pass(seen, 12_000)
  const confirm = seen.wa.rows.filter(row => row.direction === 'outgoing').at(-1)
  react(seen, confirm?.waMessageId ?? '', MEMBER, '👍')
  arrive(seen, { chatId: GROUP, author: MEMBER, body: 'sì' })
  await pass(seen, 30_000)
  expect(seen.submitted).toEqual([])
  react(seen, confirm?.waMessageId ?? '', OWNER_CHAT, '👍')
  await pass(seen, 30_000)
  expect(seen.submitted).toEqual([{ text: 'deploy staging', asUser: true }])
})

test('a permission prompt while away is answered by the owner’s 👍', async ($, on) => {
  const seen = world(on, { files: noConfirm() })
  await lead($, seen)
  const answered = $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm publish' } })
  await pass(seen, 4_000)
  const alert = seen.wa.rows.filter(row => row.direction === 'outgoing').at(-1)
  expect(alert?.chatId).toBe(OWNER_CHAT)
  expect(alert?.body).toContain('npm publish')
  react(seen, alert?.waMessageId ?? '', OWNER_CHAT, '👍')
  await pass(seen, 30_000)
  expect((await answered).decision).toEqual({ behavior: 'allow' })
})
