import { expect, test } from 'claude-code/testing'

import { DIR, GROUP, OWNER, OWNER_CHAT, arrive, configured, lead, pass, react, sends, start, wa, world } from './fake'

test('setup: pairing flow from QR to pairing code, then a test message creates the project group', async ($, on) => {
  const seen = world(on, { status: 'qr_ready', files: { [`${DIR}/config.json`]: JSON.stringify({ apiKey: 'owa_k1_scopedoperatorkey0000000000' }) } })
  await start($)
  const first = await wa($, 'setup')
  expect(first).toContain('waiting to be linked')
  expect(first).toContain('/wa owner')
  expect(await wa($, 'pair +39 333 111 2222')).toContain('ABCD1234')
  expect(await wa($, `owner +${OWNER}`)).toContain('Owner set')

  seen.wa.status = 'ready'
  expect(await wa($, 'setup')).toContain('Linked as +15550001111')
  expect(await wa($, 'test')).toBe('Sent a test message.')
  const created = seen.wa.groups[0]
  expect(created?.name).toBe('Claude · shop')
  expect(created?.participants).toEqual([OWNER_CHAT])
  expect(sends(seen).map(send => send.chatId)).toEqual([GROUP, GROUP])
  expect(sends(seen).at(-1)?.text).toContain('Test from Claude Code')
  expect(seen.files.get(`${DIR}/groups.json`)).toContain(GROUP)
})

test('an admin key is refused and never stored', async ($, on) => {
  const seen = world(on)
  seen.wa.role = 'admin'
  await start($)
  expect(await wa($, 'key owa_k1_adminkey000000000000000000')).toContain('ADMIN')
  expect(seen.files.get(`${DIR}/config.json`) ?? '').not.toContain('adminkey')
})

const noConfirm = (extra: Record<string, unknown> = {}) =>
  configured({ [`${DIR}/prefs.json`]: JSON.stringify({ presence: 'away', events: { confirmPrompts: false }, ...extra }) })

test('the leader routes an owner message to this session as their words, and relays the answer', async ($, on) => {
  const seen = world(on, { files: noConfirm() })
  await lead($, seen)
  arrive(seen, { chatId: GROUP, author: OWNER_CHAT, body: 'run the linter and fix what it finds' })
  await pass(seen, 12_000)
  expect(seen.submitted).toEqual([{ text: 'run the linter and fix what it finds', asUser: true }])

  await $.turn.start({ text: 'run the linter and fix what it finds', turnId: 't1' })
  await $.turn.complete({ answer: 'Fixed 3 lint errors.', durationMs: 20_000, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(sends(seen).at(-1)).toMatchObject({ chatId: GROUP })
  expect(sends(seen).at(-1)?.text).toContain('Fixed 3 lint errors.')
})

test('messages from chats outside the allowlist are dropped unread', async ($, on) => {
  const seen = world(on, { files: noConfirm() })
  await lead($, seen)
  arrive(seen, { chatId: '447700900123@c.us', body: 'hello, are you there?' })
  arrive(seen, { chatId: '120363999999999999@g.us', author: OWNER_CHAT, body: 'status' })
  await pass(seen, 20_000)
  expect(seen.submitted).toEqual([])
  expect(sends(seen)).toEqual([])
  const reactsOrReads = seen.wa.calls.filter(call => /\/(react|chats\/read|chats\/typing)/.test(call.path))
  expect(reactsOrReads).toEqual([])
  const logs = [...seen.files.entries()].filter(([path]) => path.includes('/log/')).map(([, text]) => text).join('\n')
  expect(logs).not.toContain('are you there')
})

const ASK = 'mcp__whatsapp-bridge__ask' as const
const NOTIFY = 'mcp__whatsapp-bridge__notify' as const

test('ask waits for the owner: a numbered reply picks the option', async ($, on) => {
  const seen = world(on, { files: noConfirm() })
  await lead($, seen)
  const asked = $.tool.call({ tool: ASK, question: 'Which database for the cache?', options: ['Redis', 'Postgres'] })
  await pass(seen, 4_000)
  const question = sends(seen).at(-1)
  expect(question?.chatId).toBe(GROUP)
  expect(question?.text).toContain('Which database for the cache?')
  expect(question?.text).toContain('*2.* Postgres')
  arrive(seen, { chatId: GROUP, author: OWNER_CHAT, body: '2' })
  await pass(seen, 16_000)
  expect(String((await asked).result)).toContain('The user answered on WhatsApp: Postgres (option 2)')
  expect(seen.submitted).toEqual([])
})

test('ask waits for the owner: a 👍 reaction answers a yes/no question; a member’s reaction does not', async ($, on) => {
  const seen = world(on, { files: noConfirm() })
  await lead($, seen)
  const asked = $.tool.call({ tool: ASK, question: 'Deploy to staging now?' })
  await pass(seen, 4_000)
  const sent = seen.wa.rows.filter(row => row.direction === 'outgoing').at(-1)
  react(seen, sent?.waMessageId ?? '', '447700900123@c.us', '👍')
  await pass(seen, 30_000)
  react(seen, sent?.waMessageId ?? '', OWNER_CHAT, '❌')
  await pass(seen, 30_000)
  expect(String((await asked).result)).toContain('The user answered on WhatsApp: no')
})

test('interaction off: ask returns unavailable without sending; parked questions arrive when it is back on', async ($, on) => {
  const seen = world(on, { files: noConfirm({ interaction: 'off' }) })
  await lead($, seen)
  const asked = await $.tool.call({ tool: ASK, question: 'Keep the old API for v1 clients?' })
  expect(String(asked.result)).toMatch(/^unavailable/)
  expect(sends(seen)).toEqual([])

  arrive(seen, { chatId: OWNER_CHAT, body: 'interact on' })
  await pass(seen, 12_000)
  const texts = sends(seen).map(send => send.text)
  expect(texts.some(text => text.includes('Interaction on'))).toBe(true)
  expect(texts.some(text => text.includes('Keep the old API for v1 clients?'))).toBe(true)
  expect(seen.files.get(`${DIR}/prefs.json`)).toContain('"interaction": "on"')
})

test('a phone prompt needs the owner’s confirmation before it runs', async ($, on) => {
  const seen = world(on, { files: configured() })
  await lead($, seen)
  arrive(seen, { chatId: GROUP, author: OWNER_CHAT, body: 'fai il deploy di staging' })
  await pass(seen, 12_000)
  expect(seen.submitted).toEqual([])
  expect(sends(seen).at(-1)?.text).toContain('Run this on *#login*')
  arrive(seen, { chatId: GROUP, author: OWNER_CHAT, body: 'sì' })
  await pass(seen, 12_000)
  expect(seen.submitted).toEqual([{ text: 'fai il deploy di staging', asUser: true }])
})

test('quiet hours hold info and normal updates for the digest but let critical through', async ($, on) => {
  const seen = world(on, { now: new Date(2026, 9, 7, 23, 30).getTime(), files: noConfirm({ interaction: 'on' }) })
  await start($)
  expect(String((await $.tool.call({ tool: NOTIFY, text: 'Nightly build is 40% done', priority: 'info' })).result)).toContain('Held for the digest')
  expect(String((await $.tool.call({ tool: NOTIFY, text: 'Migration finished', priority: 'normal' })).result)).toContain('quiet hours')
  expect(String((await $.tool.call({ tool: NOTIFY, text: 'Production deploy failed', priority: 'critical' })).result)).toContain('Sent')
  expect(sends(seen).map(send => send.text).join('\n')).toContain('Production deploy failed')
  expect(sends(seen)).toHaveLength(1)
  expect(seen.files.get(`${DIR}/sessions/sess-a.json`)).toContain('Migration finished')
})

test('two sessions, one leader: a follower never polls and handles each inbox entry once', async ($, on) => {
  const now = new Date(2026, 9, 7, 12, 0, 0).getTime()
  const lease = (at: number) => JSON.stringify({ sessionId: 'sess-b', heartbeatAt: at, since: now })
  const seen = world(on, { now, files: noConfirm() })
  seen.files.set(`${DIR}/lease.json`, lease(now))
  await start($)
  const entry = { seq: 1, key: 'row:row-00042', at: now, kind: 'owner', chatId: GROUP, messageId: 'false_x_IN42', author: OWNER_CHAT, text: 'add a changelog entry' }
  // The other session's leader delivers the same message twice (a takeover overlap).
  seen.files.set(`${DIR}/inbox/sess-a.jsonl`, `${JSON.stringify(entry)}\n${JSON.stringify({ ...entry, seq: 2 })}\n`)
  for (let i = 0; i < 6; i += 1) {
    seen.files.set(`${DIR}/lease.json`, lease(seen.clock.now()))
    await seen.clock.advance(5_000)
  }
  expect(seen.wa.calls.filter(call => call.path.includes('/messages?'))).toEqual([])
  expect(seen.submitted).toEqual([{ text: 'add a changelog entry', asUser: true }])
  expect(seen.files.get(`${DIR}/lease.json`)).toContain('sess-b')
})

test('own number linked: the owner’s phone-typed messages count, the bot’s own sends never loop back', async ($, on) => {
  const seen = world(on, { files: noConfirm() })
  seen.wa.phone = OWNER
  await lead($, seen)
  arrive(seen, { chatId: GROUP, body: 'summarize the open TODOs', direction: 'outgoing', from: OWNER })
  await pass(seen, 12_000)
  expect(seen.submitted).toEqual([{ text: 'summarize the open TODOs', asUser: true }])
  await $.turn.start({ text: 'summarize the open TODOs', turnId: 't1' })
  await $.turn.complete({ answer: 'There are 4 TODOs.', durationMs: 5_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await pass(seen, 20_000)
  expect(seen.submitted).toHaveLength(1)
  expect(sends(seen).at(-1)?.text).toContain('There are 4 TODOs.')
})

test('the owner’s direct chat keeps global commands; a project with a group is steered from its group', async ($, on) => {
  const seen = world(on, { files: noConfirm() })
  await lead($, seen)
  arrive(seen, { chatId: OWNER_CHAT, body: 'sessioni' })
  arrive(seen, { chatId: OWNER_CHAT, body: 'refactor the checkout' })
  await pass(seen, 12_000)
  const replies = sends(seen).filter(send => send.chatId === OWNER_CHAT).map(send => send.text)
  expect(replies[0]).toContain('#login')
  expect(replies[1]).toContain('steered from its group "Claude · shop"')
  expect(seen.submitted).toEqual([])
})
