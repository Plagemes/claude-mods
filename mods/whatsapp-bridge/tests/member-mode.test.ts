import { expect, test } from 'claude-code/testing'

import { memberIntent, memberRoute, memberStatusText, isAcknowledgement } from '../hooks/members'
import { DIR, GROUP, ME, OWNER_CHAT, ROOT, arrive, configured, lead, pass, sends, world } from './fake'

const MEMBER = '447700900123@c.us'
const OTHER_GROUP = '120363000000000099@g.us'
const onFiles = (extra: Record<string, string> = {}) =>
  configured({ [`${DIR}/prefs.json`]: JSON.stringify({ presence: 'away', interaction: 'on', events: { confirmPrompts: false } }), ...extra })
const memberSends = (seen: ReturnType<typeof world>) => sends(seen).filter(send => send.chatId === GROUP)
const REFUSED = /Only the owner can ask Claude to do things/

test('pure: acknowledgements are ignored; read-only commands, refusals and questions are told apart', () => {
  for (const ack of ['ok', 'OK!', '👍', 'grazie', 'Thanks!', 'ok grazie mille', 'thank you', '🙏🏻👍', 'sì', '...']) expect(isAcknowledgement(ack)).toBe(true)
  for (const real of ['Report', 'status', 'how is the login going', 'ok but is it deployed?']) expect(isAcknowledgement(real)).toBe(false)
  const base = { triggers: ['?', 'claude'], botPhone: '15550001111', isReplyToBot: false }
  expect(memberRoute('Report', { ...base, isOpen: true })).toMatchObject({ isTriggered: true, text: 'Report' })
  expect(memberRoute('Report', { ...base, isOpen: false }).isTriggered).toBe(false)
  expect(memberRoute('👍', { ...base, isOpen: true })).toMatchObject({ isTriggered: false, isAck: true })
  expect(memberRoute('? status', { ...base, isOpen: false })).toMatchObject({ isTriggered: true, text: 'status' })
  expect(memberRoute('bug: it crashes', { ...base, isOpen: true })).toMatchObject({ isTriggered: true, isBug: true })
  expect(memberIntent('Report')).toEqual({ kind: 'command', command: 'report' })
  expect(memberIntent('aiuto')).toEqual({ kind: 'command', command: 'help' })
  expect(memberIntent('stato')).toEqual({ kind: 'command', command: 'status' })
  expect(memberIntent('costo')).toEqual({ kind: 'command', command: 'cost' })
  for (const owners of ['stop', 'pausa', 'resume', 'night', '/compact', 'queue fix it', 'interact off', 'away', 'fix the failing test']) expect(memberIntent(owners)).toEqual({ kind: 'refuse' })
  expect(memberIntent('how is the login going?')).toEqual({ kind: 'question' })
})

test('pure: the member status shows no paths and no secrets', () => {
  const text = memberStatusText(
    [{ id: 'a', project: 'shop', root: ROOT, branch: 'main', label: 'shop', lastSeen: 0, lastActiveAt: 0, state: 'working', task: `fix ${ROOT}/src/auth/login.ts and src/db/pool.ts with API_TOKEN=abc123def456ghi; cost $4.20`, costUsd: 4.2, startedAt: 0, turns: 3, ended: false }],
    5 * 60_000,
  )
  expect(text).toContain('working for 5m')
  expect(text).toContain('3 prompts')
  for (const leak of ['/work/shop', 'src/auth', 'login.ts', 'pool.ts', 'abc123def456ghi', '4.20']) expect(text).not.toContain(leak)
})

test('all mode: a member’s "Report", "status" and "help" get replies; no paths or secrets in them', async ($, on) => {
  const seen = world(on, { files: onFiles() })
  await lead($, seen)
  await $.turn.start({ text: `fix ${ROOT}/src/auth/login.ts using API_TOKEN=abc123def456ghi`, turnId: 'turn-1' })
  arrive(seen, { chatId: GROUP, author: MEMBER, body: 'status' })
  await pass(seen, 8_000)
  const status = memberSends(seen).at(-1)?.text ?? ''
  expect(status).toContain('*Status*')
  expect(status).toContain('working')
  for (const leak of ['/work/shop', 'src/auth', 'login.ts', 'abc123def456ghi']) expect(status).not.toContain(leak)

  arrive(seen, { chatId: GROUP, author: MEMBER, body: 'help' })
  await pass(seen, 8_000)
  const help = memberSends(seen).at(-1)?.text ?? ''
  expect(help).toContain('for members')
  expect(help).toContain('just write')
  expect(help).not.toContain('cost')

  const before = sends(seen).length
  arrive(seen, { chatId: GROUP, author: MEMBER, body: 'Report' })
  await pass(seen, 8_000)
  const report = sends(seen).slice(before)
  expect(report.length).toBeGreaterThan(0)
  expect(report.every(send => send.chatId === GROUP)).toBe(true)
  expect(report.some(send => /Test runs per day/.test(send.text))).toBe(true)
  // No cost chart for members unless memberSeesCost.
  expect(report.some(send => /cost per day|smart-router/i.test(send.text))).toBe(false)
  for (const send of report) expect(send.text).not.toContain('/work/shop')
  expect(seen.submitted).toEqual([])
  expect(seen.aborted).toEqual([])
})

test('all mode: a free-text question is answered with no "?"; "ok" and 👍 are ignored', async ($, on) => {
  const seen = world(on, { files: onFiles() })
  await lead($, seen)
  arrive(seen, { chatId: GROUP, author: MEMBER, body: 'ok' })
  arrive(seen, { chatId: GROUP, author: MEMBER, body: '👍' })
  arrive(seen, { chatId: GROUP, author: MEMBER, body: 'grazie!' })
  arrive(seen, { chatId: GROUP, author: MEMBER, body: '', type: 'sticker' })
  await pass(seen, 8_000)
  expect(seen.forks).toEqual([])
  expect(seen.completions).toEqual([])
  expect(memberSends(seen)).toEqual([])

  arrive(seen, { chatId: GROUP, author: MEMBER, body: 'a che punto siete con il login' })
  await pass(seen, 12_000)
  expect(seen.forks).toHaveLength(1)
  expect(seen.forks[0]).toContain('a che punto siete con il login')
  expect(seen.forks[0]).toContain('not the owner')
  expect(memberSends(seen).at(-1)?.text).toContain('The login page is done')
  expect(await $.command.run({ command: 'wa', args: 'inbox', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }).then(r => r.text ?? '')).toContain('acknowledgement')
})

test('all mode: a member’s stop, pause and work request are refused; nothing runs', async ($, on) => {
  const seen = world(on, { files: onFiles() })
  await lead($, seen)
  await $.turn.start({ text: 'refactor the cart', turnId: 'turn-1' })
  for (const body of ['stop', 'pausa', 'fix the failing test and deploy', '/compact']) arrive(seen, { chatId: GROUP, author: MEMBER, body })
  await pass(seen, 12_000)
  const replies = memberSends(seen).map(send => send.text)
  expect(replies).toHaveLength(4)
  for (const reply of replies) {
    expect(reply).toMatch(REFUSED)
    expect(reply).not.toContain('start with')
  }
  expect(seen.aborted).toEqual([])
  expect(seen.submitted).toEqual([])
  expect(JSON.parse(seen.files.get(`${DIR}/prefs.json`) ?? '{}').paused).not.toBe(true)
})

test('cost is owner-only by default', async ($, on) => {
  const seen = world(on, { files: onFiles() })
  await lead($, seen)
  arrive(seen, { chatId: GROUP, author: MEMBER, body: 'costo' })
  await pass(seen, 8_000)
  const reply = memberSends(seen).at(-1)?.text ?? ''
  expect(reply).toContain('owner only')
  expect(reply).not.toMatch(/\$\d/)
})

test('memberSeesCost: a member gets the cost in the group', { options: { memberSeesCost: true } }, async ($, on) => {
  const seen = world(on, { files: onFiles() })
  await lead($, seen)
  arrive(seen, { chatId: GROUP, author: MEMBER, body: 'cost' })
  await pass(seen, 8_000)
  expect(memberSends(seen).at(-1)?.text).toContain('*Cost*')
  expect(sends(seen).some(send => send.chatId === OWNER_CHAT)).toBe(false)
})

test('trigger mode: "Report" and a plain question are chatter; "? status" is answered', { options: { memberMode: 'trigger' } }, async ($, on) => {
  const seen = world(on, { files: onFiles() })
  await lead($, seen)
  arrive(seen, { chatId: GROUP, author: MEMBER, body: 'Report' })
  arrive(seen, { chatId: GROUP, author: MEMBER, body: 'how is the login going' })
  await pass(seen, 8_000)
  expect(memberSends(seen)).toEqual([])
  expect(seen.forks).toEqual([])
  arrive(seen, { chatId: GROUP, author: MEMBER, body: '? status' })
  await pass(seen, 8_000)
  expect(memberSends(seen).at(-1)?.text).toContain('*Status*')
})

test('a group not linked to a project still needs a trigger', { options: { allowedChats: OTHER_GROUP } }, async ($, on) => {
  const seen = world(on, { files: onFiles() })
  await lead($, seen)
  arrive(seen, { chatId: OTHER_GROUP, author: MEMBER, body: 'how is the login going' })
  arrive(seen, { chatId: OTHER_GROUP, author: MEMBER, body: 'status' })
  await pass(seen, 8_000)
  expect(sends(seen).filter(send => send.chatId === OTHER_GROUP)).toEqual([])
  expect(seen.forks).toEqual([])
  expect(seen.completions).toEqual([])
  arrive(seen, { chatId: OTHER_GROUP, author: MEMBER, body: '? how is the login going' })
  await pass(seen, 12_000)
  expect(seen.forks.length + seen.completions.length).toBe(1)
})

test('all mode: the member rate limit still applies to plain messages and commands', async ($, on) => {
  const seen = world(on, { files: onFiles() })
  await lead($, seen)
  for (let i = 1; i <= 4; i += 1) arrive(seen, { chatId: GROUP, author: MEMBER, body: `question number ${i} about the login` })
  for (let i = 1; i <= 3; i += 1) arrive(seen, { chatId: GROUP, author: MEMBER, body: 'status' })
  await pass(seen, 20_000)
  expect(seen.forks).toHaveLength(4)
  expect(memberSends(seen)).toHaveLength(5)
  expect(seen.files.get(`${DIR}/members/${ME}.jsonl`)).toContain('"outcome":"limited"')
})
