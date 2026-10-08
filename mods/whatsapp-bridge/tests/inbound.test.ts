import { expect, test } from 'claude-code/testing'

import { DIR, GROUP, ME, OWNER, OWNER_CHAT, arrive, configured, lead, pass, sends, start, startDesktop, wa, world } from './fake'
import { fakeHub } from './hub'

/** The owner's self-chat as WhatsApp's privacy ids key it on both engines now: their own `@lid`. */
const SELF_LID = '208815551234567@lid'
const MEMBER = '447700900123@c.us'
const OTHER_ROOT = '/work/blog'
const OTHER_GROUP = '120363000000000077@g.us'

const prefs = (extra: Record<string, unknown> = {}) => JSON.stringify({ presence: 'away', interaction: 'on', ...extra })
const ownNumber = (extra: Record<string, unknown> = {}) =>
  configured({ [`${DIR}/groups.json`]: '{}', [`${DIR}/prefs.json`]: prefs(extra) })

/** The desktop app's session: no terminal, `isInteractive` false. Lets the lease settle so it leads. */
async function leadOnDesktop($: Parameters<typeof start>[0], seen: ReturnType<typeof world>): Promise<void> {
  await startDesktop($, seen)
  await seen.clock.advance(11_000)
  await seen.clock.advance(1_000)
}

test('desktop app: an SDK-hosted session (isInteractive false) still polls, and the owner’s self-chat "/HELP" under an @lid gets the command list', async ($, on) => {
  const seen = world(on, { files: ownNumber() })
  seen.wa.phone = OWNER
  seen.wa.lids[SELF_LID] = OWNER
  await leadOnDesktop($, seen)
  expect(seen.wa.calls.some(call => call.path.includes('/messages?'))).toBe(true)
  // Typed on the linked phone in "Message yourself": an outgoing (fromMe) row in a chat keyed by the owner's own lid.
  arrive(seen, { chatId: SELF_LID, body: '/HELP', direction: 'outgoing', from: SELF_LID })
  await pass(seen, 12_000)
  const reply = sends(seen).at(-1)
  expect(reply?.chatId).toBe(SELF_LID)
  expect(reply?.text).toContain('Claude on WhatsApp')
  expect(seen.submitted).toEqual([])
  // The bot's own reply comes back as an outgoing row too: never answered again.
  await pass(seen, 30_000)
  expect(sends(seen).filter(send => send.text.includes('Claude on WhatsApp'))).toHaveLength(1)
  expect(seen.files.get(`${DIR}/chats.json`)).toContain(SELF_LID)
  const inbox = await wa($, 'inbox')
  expect(inbox).toContain('accepted: command: help')
})

test('own number: the self-chat under an @lid OpenWA cannot resolve yet is still the owner’s (its id is the sender’s own)', async ($, on) => {
  const seen = world(on, { files: ownNumber() })
  seen.wa.phone = OWNER
  await lead($, seen)
  arrive(seen, { chatId: SELF_LID, body: 'help', direction: 'outgoing', from: SELF_LID })
  // A chat with someone else under their lid, typed on the same phone: never read.
  arrive(seen, { chatId: '99001122334455@lid', body: 'see you at 8', direction: 'outgoing', from: SELF_LID })
  await pass(seen, 12_000)
  expect(sends(seen).map(send => send.chatId)).toEqual([SELF_LID])
  expect([...seen.files.values()].join('\n')).not.toContain('see you at 8')
})

test('a plain -p run (no surface, not interactive) never polls WhatsApp', async ($, on) => {
  const seen = world(on, { files: ownNumber() })
  seen.surfaces = []
  await $.session.start({ cwd: '/work/shop', surface: null, isInteractive: false })
  await pass(seen, 30_000)
  expect(seen.wa.calls.some(call => call.path.includes('/messages?'))).toBe(false)
})

test('"aiuto" in any case from the owner’s direct chat is answered by the leader with no Claude turn running', async ($, on) => {
  const seen = world(on, { files: configured({ [`${DIR}/prefs.json`]: prefs() }) })
  await lead($, seen)
  arrive(seen, { chatId: OWNER_CHAT, body: 'AIUTO' })
  await pass(seen, 12_000)
  expect(sends(seen).at(-1)).toMatchObject({ chatId: OWNER_CHAT })
  expect(sends(seen).at(-1)?.text).toContain('commands (EN/IT)')
})

test('bot echoes are ignored even when WhatsApp strips the invisible mark: the sent id still marks them', async ($, on) => {
  const seen = world(on, { files: ownNumber() })
  seen.wa.phone = OWNER
  await lead($, seen)
  arrive(seen, { chatId: OWNER_CHAT, body: 'help', direction: 'outgoing', from: OWNER })
  await pass(seen, 12_000)
  const reply = seen.wa.rows.filter(row => row.direction === 'outgoing').at(-1)
  if (reply !== undefined) reply.body = reply.body.replace(/⁣$/, '')
  await pass(seen, 30_000)
  expect(sends(seen)).toHaveLength(1)
})

test('an owner question is answered at once from the session’s transcript and the project facts; nothing runs', async ($, on) => {
  const seen = world(on, { files: configured({ [`${DIR}/prefs.json`]: prefs() }) })
  seen.forkAnswer.text = 'I am wiring the login form; 2 files changed, tests next.'
  await lead($, seen)
  arrive(seen, { chatId: GROUP, author: OWNER_CHAT, body: 'what are you doing?' })
  await pass(seen, 12_000)
  expect(seen.submitted).toEqual([])
  expect(seen.forks).toHaveLength(1)
  expect(seen.forks[0]).toContain('The owner of this project asks')
  expect(seen.forks[0]).toContain('src/login.ts')
  expect(seen.forks[0]).toContain('branch feature/login')
  const answer = sends(seen).at(-1)
  expect(answer?.chatId).toBe(GROUP)
  expect(answer?.text).toContain('I am wiring the login form')
  // It shows in the pane's Chat tab, question and answer.
  const log = seen.files.get(`${DIR}/log/${ME}.jsonl`) ?? ''
  expect(log).toContain('what are you doing?')
  expect(log).toContain('I am wiring the login form')
})

test('an owner group message reaches the session of that group’s project, not the most recent one', async ($, on) => {
  const groups = JSON.stringify({
    '/work/shop': { groupId: GROUP, name: 'Claude · shop', inviteLink: '', members: 1, createdAt: 0 },
    [OTHER_ROOT]: { groupId: OTHER_GROUP, name: 'Claude · blog', inviteLink: '', members: 1, createdAt: 0 },
  })
  const seen = world(on, { files: configured({ [`${DIR}/groups.json`]: groups, [`${DIR}/prefs.json`]: prefs({ events: { confirmPrompts: false } }) }) })
  await lead($, seen)
  const blog = (at: number) =>
    JSON.stringify({ info: { id: 'sess-b', project: 'blog', root: OTHER_ROOT, branch: 'main', label: 'blog', lastSeen: at, lastActiveAt: at - 99_000, state: 'idle', task: '', costUsd: 0, startedAt: 0, turns: 0, ended: false }, sentIds: [], sentTimes: [], pending: [], digest: [], parked: [], stats: { costByDay: {}, tests: {} } })
  seen.files.set(`${DIR}/sessions/sess-b.json`, blog(seen.clock.now()))
  arrive(seen, { chatId: OTHER_GROUP, author: OWNER_CHAT, body: 'publish the draft post' })
  await pass(seen, 8_000)
  expect(seen.files.get(`${DIR}/inbox/sess-b/${ME}.jsonl`)).toContain('publish the draft post')
  expect(seen.submitted).toEqual([])
})

test('an owner work request goes through confirmation, is submitted from a timer, says "working on it", and the result follows', async ($, on) => {
  const seen = world(on, { files: configured({ [`${DIR}/prefs.json`]: prefs() }) })
  await lead($, seen)
  arrive(seen, { chatId: GROUP, author: OWNER_CHAT, body: 'fix the failing test' })
  await pass(seen, 12_000)
  expect(seen.submitted).toEqual([])
  expect(sends(seen).at(-1)?.text).toContain('Run this on *#login*')
  arrive(seen, { chatId: GROUP, author: OWNER_CHAT, body: 'sì' })
  await pass(seen, 12_000)
  expect(seen.submitted).toEqual([{ text: 'fix the failing test', asUser: true }])
  expect(sends(seen).at(-1)?.text).toContain('Working on it (#login)')
  await $.turn.start({ text: 'fix the failing test', turnId: 't1' })
  await $.turn.complete({ answer: 'Fixed: the date mock was off by one.', durationMs: 30_000, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(sends(seen).at(-1)?.text).toContain('Fixed: the date mock was off by one.')
})

test('the per-chat rate holds: past it a question is refused in a line, with no model call', { options: { qaRate: 2 } }, async ($, on) => {
  const seen = world(on, { files: configured({ [`${DIR}/prefs.json`]: prefs() }) })
  await lead($, seen)
  for (const question of ['what are you doing?', 'is the build green?', 'how does the cache work here?']) arrive(seen, { chatId: GROUP, author: OWNER_CHAT, body: question })
  await pass(seen, 12_000)
  expect(seen.forks).toHaveLength(2)
  expect(sends(seen).at(-1)?.text).toContain('too many questions in ten minutes')
})

test('the daily cost cap holds across questions', { options: { qaDailyUsd: 0.01 } }, async ($, on) => {
  const seen = world(on, { files: configured({ [`${DIR}/prefs.json`]: prefs() }) })
  seen.completeAnswer = { text: 'It is going well.', outputTokens: 2_000 }
  await lead($, seen)
  await $.turn.start({ text: 'refactor the cart', turnId: 't1' })
  arrive(seen, { chatId: GROUP, author: OWNER_CHAT, body: 'status of the build?' })
  await pass(seen, 12_000)
  arrive(seen, { chatId: GROUP, author: OWNER_CHAT, body: 'and the tests?' })
  await pass(seen, 12_000)
  expect(seen.completions).toHaveLength(1)
  expect(sends(seen).at(-1)?.text).toContain('daily answer budget')
})

test('silent: questions get one "I’ll answer later", then nothing; turning interaction on answers them', async ($, on) => {
  const seen = world(on, { files: configured({ [`${DIR}/prefs.json`]: prefs({ interaction: 'off' }) }) })
  await lead($, seen)
  arrive(seen, { chatId: GROUP, author: OWNER_CHAT, body: 'what are you doing?' })
  arrive(seen, { chatId: GROUP, author: MEMBER, body: '? is the login done?' })
  await pass(seen, 12_000)
  expect(seen.forks).toEqual([])
  expect(seen.completions).toEqual([])
  expect(sends(seen).map(send => send.text)).toEqual([expect.stringContaining("I'll answer when interaction is back on")])
  arrive(seen, { chatId: GROUP, author: OWNER_CHAT, body: 'interact on' })
  await pass(seen, 12_000)
  expect(seen.forks.length + seen.completions.length).toBe(2)
})

test('owner number typed with 00 or a trunk 0 still matches the sender; strangers’ text is never logged', async ($, on) => {
  const files = configured({ [`${DIR}/config.json`]: JSON.stringify({ apiKey: 'owa_k1_scopedoperatorkey0000000000', sessionId: '3f6b9c1e-0000-4000-8000-000000000001', ownerNumbers: [`00${OWNER}`] }), [`${DIR}/prefs.json`]: prefs() })
  const seen = world(on, { files })
  await lead($, seen)
  arrive(seen, { chatId: OWNER_CHAT, body: 'help' })
  arrive(seen, { chatId: '15550009999@c.us', body: 'my card pin is 1234' })
  await pass(seen, 12_000)
  expect(sends(seen).map(send => send.chatId)).toEqual([OWNER_CHAT])
  const inbox = await wa($, 'inbox')
  expect(inbox).toContain('chat not allowlisted')
  expect(inbox).not.toContain('1234')
  expect([...seen.files.values()].join('\n')).not.toContain('my card pin')
})

test('the pane shows when the last message came in and that the receive path is healthy', async ($, on) => {
  const seen = world(on, { files: configured({ [`${DIR}/prefs.json`]: prefs() }) })
  await lead($, seen)
  arrive(seen, { chatId: OWNER_CHAT, body: 'help' })
  await pass(seen, 12_000)
  const ui = await $.ui.mount({ plugin: 'whatsapp-bridge', surface: 'desktop', component: 'Pane', requestId: 'whatsapp-bridge', props: { title: 'WhatsApp', isFocused: true, bodyColumns: 52, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
  expect(await ui.find({ type: 'Text', text: /Last message received 12:00 · Receiving/ })).toBeDefined()
  await ui.unmount()
})

test('with mods-hub: "auto" while you are at the keyboard still answers what you ask; Silent holds it, inbound needs no hub', async ($, on) => {
  const seen = world(on, { files: configured() })
  const hub = fakeHub(on, {}, seen.clock)
  await lead($, seen)
  // At the keyboard nothing is busy: the leader polls at its slow pace (18 s), so the steps below wait that long.
  arrive(seen, { chatId: GROUP, author: OWNER_CHAT, body: 'what are you doing?' })
  await pass(seen, 40_000)
  expect(seen.forks).toHaveLength(1)
  hub.mode = { ...hub.mode, isSilent: true }
  arrive(seen, { chatId: GROUP, author: OWNER_CHAT, body: 'and the tests?' })
  await pass(seen, 40_000)
  expect(seen.forks).toHaveLength(1)
  expect(sends(seen).at(-1)?.text).toContain("I'll answer when interaction is back on")
})
