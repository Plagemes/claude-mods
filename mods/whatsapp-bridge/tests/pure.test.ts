import { expect, test } from 'claude-code/testing'

import type { WaSessionInfo } from '../types'
import { matchAnswer, pendingFor, questionText } from '../hooks/answers'
import type { Pending } from '../hooks/answers'
import { parseCommand, reactionMeaning, takePin } from '../hooks/commands'
import { composeSection } from '../hooks/format'
import { emptyBook, isOwnerPhone, memberTrigger, parseIssueDraft, phoneOf, takeQuota } from '../hooks/members'
import { parseRows } from '../hooks/openwa'
import { crossed, crossedBudgets, decide, isAway } from '../hooks/policy'
import { LEASE_STALE_MS, backoff, leaseAction, pollInterval, remember, walkPage } from '../hooks/poller'
import { cap, clean } from '../hooks/privacy'
import { chartSvg, chartText, costChart, routerChart } from '../hooks/reports'
import { defaultLabel, extractTag, route } from '../hooks/routing'
import { defaultPrefs, inWindow, interactionAllowed, mergePrefs, readSettings, windowEnd } from '../hooks/settings'

const NOW = new Date(2026, 9, 7, 12, 0, 0).getTime()
const settings = readSettings({ ownerNumbers: '+39 333 111 2222' })

const session = (id: string, extra: Partial<WaSessionInfo> = {}): WaSessionInfo => ({
  id,
  project: 'shop',
  root: '/work/shop',
  branch: 'main',
  label: id,
  lastSeen: NOW - 5_000,
  lastActiveAt: NOW - 60_000,
  state: 'idle',
  task: '',
  costUsd: 0,
  startedAt: NOW - 3_600_000,
  turns: 1,
  ended: false,
  ...extra,
})

test('routing: reply → sender, #label / @project tags, project group, else the most recently active', () => {
  const sessions = [
    session('api', { project: 'api', root: '/work/api', lastActiveAt: NOW - 1_000 }),
    session('web', { lastActiveAt: NOW - 120_000 }),
    session('gone', { lastSeen: NOW - 120_000, lastActiveAt: NOW }),
  ]
  const context = { sessions, sentBy: new Map([['true_x_OUT1', 'web']]), groups: { '/work/shop': { groupId: 'g1@g.us', name: 'Claude · shop', inviteLink: '', members: 1, createdAt: 0 } } }
  expect(route({ chatId: 'o@c.us', text: 'ok', quotedId: 'true_x_OUT1', now: NOW }, context)).toMatchObject({ sessionId: 'web', reason: 'reply' })
  expect(route({ chatId: 'o@c.us', text: '#WEB run tests', now: NOW }, context)).toEqual({ sessionId: 'web', text: 'run tests', reason: 'tag' })
  expect(route({ chatId: 'o@c.us', text: '@api: deploy', now: NOW }, context)).toEqual({ sessionId: 'api', text: 'deploy', reason: 'tag' })
  expect(route({ chatId: 'o@c.us', text: '#nope hi', now: NOW }, context)).toMatchObject({ sessionId: null, reason: 'unknown-tag' })
  expect(route({ chatId: 'g1@g.us', text: 'status?', now: NOW }, context)).toMatchObject({ sessionId: 'web', reason: 'group' })
  expect(route({ chatId: 'o@c.us', text: 'hello', now: NOW }, context)).toMatchObject({ sessionId: 'api', reason: 'recent' })
  expect(route({ chatId: 'o@c.us', text: 'hello', now: NOW }, { ...context, sessions: [] })).toMatchObject({ sessionId: null, reason: 'no-session' })
  expect(extractTag('#Login: fix it')).toEqual({ tag: { kind: 'label', value: 'login' }, rest: 'fix it' })
  expect(defaultLabel('shop', 'feature/login', [])).toBe('login')
  expect(defaultLabel('shop', 'main', ['shop'])).toBe('shop2')
})

test('cursor walk: rows above the cursor, paging when needed, and a bounded dedupe set', () => {
  const rows = (ids: number[]) => ids.map(n => ({ id: `r${n}`, createdAt: new Date(NOW + n * 1000).toISOString() }))
  const cursor = { id: 'r3', createdAt: new Date(NOW + 3000).toISOString() }
  expect(walkPage(rows([6, 5, 4, 3, 2]), cursor, 50)).toEqual({ fresh: rows([6, 5, 4]), isDone: true })
  expect(walkPage(rows([9, 8]), cursor, 2)).toEqual({ fresh: rows([9, 8]), isDone: false, after: 'r8' })
  // The cursor's row was deleted: stop at the first older row.
  expect(walkPage(rows([6, 5, 2, 1]), { id: 'r4', createdAt: cursor.createdAt }, 50).fresh).toEqual(rows([6, 5]))
  expect(remember(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c'])
  expect(remember(Array.from({ length: 2_000 }, (_, i) => `k${i}`), ['new'])).toHaveLength(2_000)
  const parsed = parseRows({ messages: [{ id: 'r1', chatId: 'g@g.us', waMessageId: 'w1', body: 'hi', direction: 'incoming', metadata: { quotedMessage: { id: 'q1', body: '' }, reactions: { 'o@c.us': '👍', 'x@c.us': '' } } }, { nope: 1 }] })
  expect(parsed).toHaveLength(1)
  expect(parsed[0]).toMatchObject({ quotedId: 'q1', reactions: { 'o@c.us': '👍' } })
})

test('leader lease: renew own, take stale or missing, follow a fresh one; poll pacing and backoff', () => {
  expect(leaseAction(null, 'a', NOW)).toBe('take')
  expect(leaseAction({ sessionId: 'a', heartbeatAt: NOW - 5_000, since: 0 }, 'a', NOW)).toBe('renew')
  expect(leaseAction({ sessionId: 'b', heartbeatAt: NOW - 5_000, since: 0 }, 'a', NOW)).toBe('follow')
  expect(leaseAction({ sessionId: 'b', heartbeatAt: NOW - LEASE_STALE_MS - 1, since: 0 }, 'a', NOW)).toBe('take')
  expect(pollInterval({ baseSeconds: 6, targets: 1, isBusy: true })).toBe(6_000)
  expect(pollInterval({ baseSeconds: 6, targets: 1, isBusy: false })).toBe(18_000)
  expect(pollInterval({ baseSeconds: 6, targets: 5, isBusy: true })).toBe(20_000)
  expect(backoff(0, '30')).toBe(30_000)
  expect(backoff(0, undefined)).toBe(10_000)
  expect(backoff(200_000, undefined)).toBe(300_000)
})

test('delivery: critical always, normal when away, info to the digest, quiet hours, pause and the cap', () => {
  const prefs = defaultPrefs(settings)
  const base = { now: NOW, prefs, notifyMode: 'away' as const, lastActiveAt: NOW - 20 * 60_000, sentTimes: [], maxPerHour: 3 }
  expect(decide({ ...base, priority: 'normal' })).toEqual({ action: 'send', reason: 'away' })
  expect(decide({ ...base, priority: 'info' }).action).toBe('digest')
  expect(decide({ ...base, priority: 'normal', lastActiveAt: NOW - 60_000 }).action).toBe('drop')
  expect(decide({ ...base, priority: 'critical', lastActiveAt: NOW }).action).toBe('send')
  expect(decide({ ...base, priority: 'normal', prefs: { ...prefs, paused: true } }).action).toBe('digest')
  expect(decide({ ...base, priority: 'normal', sentTimes: [NOW - 1, NOW - 2, NOW - 3] }).reason).toBe('hourly cap reached')
  const night = new Date(2026, 9, 7, 23, 30).getTime()
  expect(decide({ ...base, now: night, lastActiveAt: night - 3_600_000, priority: 'normal' }).reason).toBe('quiet hours')
  expect(decide({ ...base, now: night, priority: 'critical' }).action).toBe('send')
  expect(decide({ ...base, priority: 'critical', notifyMode: 'off' }).action).toBe('drop')
  expect(isAway({ ...prefs, presence: 'away' }, NOW, NOW)).toBe(true)
  expect(isAway({ ...prefs, presence: 'here' }, 0, NOW)).toBe(false)
  expect(inWindow('23-8', 2)).toBe(true)
  expect(inWindow('23-8', 12)).toBe(false)
  expect(inWindow('off', 2)).toBe(false)
  expect(crossedBudgets([5, 10, 25], 4, 11)).toEqual([5, 10])
  const eight = new Date(2026, 9, 8, 8, 31).getTime()
  expect(crossed(8 * 60 + 30, eight - 120_000, eight)).toBe(true)
  expect(crossed(8 * 60 + 30, eight, eight + 60_000)).toBe(false)
})

test('interaction: on, silent, night until the morning, and auto off-hours; one prompt text per mode', () => {
  const prefs = defaultPrefs(settings)
  const night = new Date(2026, 9, 7, 23, 30).getTime()
  expect(interactionAllowed(prefs, '23-8', NOW)).toBe(true)
  expect(interactionAllowed(prefs, '23-8', night)).toBe(false)
  expect(interactionAllowed({ ...prefs, interaction: 'on' }, '23-8', night)).toBe(true)
  expect(interactionAllowed({ ...prefs, interaction: 'off' }, '23-8', NOW)).toBe(false)
  const until = windowEnd('23-8', NOW)
  expect(new Date(until).getHours()).toBe(8)
  expect(interactionAllowed({ ...prefs, interaction: 'night', nightUntil: until }, '23-8', NOW + 60_000)).toBe(false)
  expect(interactionAllowed({ ...prefs, interaction: 'night', nightUntil: until }, '23-8', until)).toBe(true)
  expect(composeSection(true)).toContain('Use ask only when you are blocked')
  expect(composeSection(false)).toContain('NOT available')
  expect(mergePrefs({ events: { tests: false, bogus: true }, presence: 'away', quietHours: 'nonsense' }, settings)).toMatchObject({
    presence: 'away',
    quietHours: '23-8',
    events: { tests: false, longTurn: true, liveStatus: false },
  })
})

test('redaction: secrets always; members also lose costs, paths, env values and code', () => {
  const text = 'Deployed with ghp_abcdefghijklmnopqrstuvwxyz0123456789AB, cost $4.20 (12k tokens).\nAPI_KEY=sk-live-abc123def456\nsee /Users/ana/app/.env and /work/shop/src/app.ts\n```ts\nconst x = 1\n```'
  const owner = clean(text, { audience: 'owner', maxChars: 1_000, root: '/work/shop' }).text
  expect(owner).toContain('[REDACTED:github-token]')
  expect(owner).toContain('$4.20')
  expect(owner).toContain('./src/app.ts')
  const member = clean(text, { audience: 'member', maxChars: 1_000, root: '/work/shop' })
  expect(member.text).not.toContain('4.20')
  expect(member.text).not.toContain('tokens')
  expect(member.text).not.toContain('/Users/ana')
  expect(member.text).not.toContain('const x')
  expect(member.text).toContain('./src/app.ts')
  expect(member.masked).toBeGreaterThan(3)
  expect(cap('word '.repeat(100), 60).endsWith('…(truncated)')).toBe(true)
})

test('phone commands in English and Italian, with the PIN for risky ones', () => {
  const kind = (text: string) => parseCommand(text).command.kind
  expect(kind('stato')).toBe('status')
  expect(kind('Status')).toBe('status')
  expect(kind('ferma')).toBe('stop')
  expect(kind('STOP ALL')).toBe('stopAll')
  expect(kind('ferma tutto')).toBe('stopAll')
  expect(kind('riepilogo')).toBe('digest')
  expect(kind('costo')).toBe('cost')
  expect(kind('sessioni')).toBe('sessions')
  expect(kind('pausa')).toBe('pause')
  expect(kind('notte')).toBe('night')
  expect(parseCommand('coda: aggiorna le dipendenze').command).toEqual({ kind: 'queue', task: 'aggiorna le dipendenze' })
  expect(parseCommand('interact off').command).toEqual({ kind: 'interact', isOn: false })
  expect(parseCommand('interazione on').command).toEqual({ kind: 'interact', isOn: true })
  expect(parseCommand('/compact keep the plan').command).toEqual({ kind: 'slash', command: 'compact', args: 'keep the plan' })
  expect(parseCommand('please refactor the cart').command).toEqual({ kind: 'prompt', text: 'please refactor the cart' })
  expect(parseCommand('STOP ALL', '4321')).toMatchObject({ needsPin: true, hasPin: false })
  expect(parseCommand('STOP ALL 4321', '4321')).toMatchObject({ command: { kind: 'stopAll' }, needsPin: true, hasPin: true })
  expect(parseCommand('pin:4321 /clear', '4321')).toMatchObject({ command: { kind: 'slash', command: 'clear' }, hasPin: true })
  expect(parseCommand('stop', '4321').needsPin).toBe(false)
  expect(takePin('deploy 4321 now', '4321')).toEqual({ text: 'deploy now', hasPin: true })
  expect(reactionMeaning('👍🏽')).toBe('approve')
  expect(reactionMeaning('❌')).toBe('reject')
  expect(reactionMeaning('⏸️')).toBe('pause')
  expect(reactionMeaning('🔁')).toBe('retry')
  expect(reactionMeaning('😂')).toBeUndefined()
})

test('answers: numbers, option text, yes/no words and reactions; the quoted question wins', () => {
  const ask: Pending = { id: 'a', kind: 'ask', question: 'DB?', options: ['Redis', 'Postgres', 'SQLite'], chatId: 'c', messageId: 'm1', createdAt: NOW, expiresAt: NOW + 60_000 }
  expect(matchAnswer(ask, { text: '2' })).toEqual({ text: 'Postgres', choice: 1, verdict: undefined })
  expect(matchAnswer(ask, { text: 'opzione 3' })?.text).toBe('SQLite')
  expect(matchAnswer(ask, { text: 'postgres' })?.choice).toBe(1)
  expect(matchAnswer(ask, { text: 'red' })?.text).toBe('Redis')
  expect(matchAnswer(ask, { text: 'whatever is fastest' })).toEqual({ text: 'whatever is fastest' })
  expect(matchAnswer(ask, { emoji: '👍' })).toBeNull()
  const yesNo: Pending = { ...ask, id: 'b', options: ['Sì', 'No'], messageId: 'm2', createdAt: NOW + 1 }
  expect(matchAnswer(yesNo, { text: 'no' })).toMatchObject({ choice: 1, verdict: 'reject' })
  expect(matchAnswer(yesNo, { text: 'ok' })).toMatchObject({ choice: 0, verdict: 'approve' })
  expect(matchAnswer(yesNo, { emoji: '👍' })).toMatchObject({ verdict: 'approve' })
  const open: Pending = { ...ask, id: 'c', options: [], messageId: 'm3' }
  expect(matchAnswer(open, { emoji: '❌' })).toMatchObject({ text: 'no', verdict: 'reject' })
  expect(pendingFor([ask, yesNo], 'c', 'm1', NOW)?.id).toBe('a')
  expect(pendingFor([ask, yesNo], 'c', undefined, NOW)?.id).toBe('b')
  expect(pendingFor([ask], 'c', undefined, NOW + 120_000)).toBeUndefined()
  expect(questionText('DB?', ['A', 'B'], '#x · shop')).toContain('*2.* B')
})

test('members: owner by number, triggers, bug reports, quota and the issue draft', () => {
  expect(phoneOf('393331112222@c.us')).toBe('393331112222')
  expect(phoneOf('1234567@lid')).toBe('')
  expect(isOwnerPhone('393331112222', settings.ownerNumbers)).toBe(true)
  expect(isOwnerPhone('3331112222', settings.ownerNumbers)).toBe(true)
  expect(isOwnerPhone('447700900123', settings.ownerNumbers)).toBe(false)
  const options = { triggers: ['?', 'claude'], botPhone: '15550001111', isReplyToBot: false }
  expect(memberTrigger('? what changed today?', options)).toEqual({ isTriggered: true, isBug: false, text: 'what changed today?' })
  expect(memberTrigger('Claude, are we done?', options).isTriggered).toBe(true)
  expect(memberTrigger('claudette is late', options).isTriggered).toBe(false)
  expect(memberTrigger('@15550001111 status please', options)).toMatchObject({ isTriggered: true, text: 'status please' })
  expect(memberTrigger('nice!', options).isTriggered).toBe(false)
  expect(memberTrigger('nice!', { ...options, isReplyToBot: true }).isTriggered).toBe(true)
  expect(memberTrigger('bug: crash on save', options)).toEqual({ isTriggered: true, isBug: true, text: 'crash on save' })
  expect(memberTrigger('the save button 🐞 crashes', options).isBug).toBe(true)
  expect(memberTrigger('bugfix landed', options).isTriggered).toBe(false)
  let book = emptyBook()
  const limits = { perTenMinutes: 2, dailyCap: 3 }
  const take = (who: string, at: number) => {
    const result = takeQuota(book, who, at, '2026-10-07', limits)
    book = result.book
    return result.isAllowed
  }
  expect([take('m', NOW), take('m', NOW + 1), take('m', NOW + 2)]).toEqual([true, true, false])
  expect(take('m', NOW + 11 * 60_000)).toBe(true)
  expect(take('n', NOW + 12 * 60_000)).toBe(false)
  expect(parseIssueDraft('TITLE: Crash on save\n\nBody here', 'x')).toEqual({ title: 'Crash on save', body: 'Body here' })
  expect(parseIssueDraft('no title line', 'fallback').title).toBe('fallback')
})

test('reports: an SVG bar chart, a text fallback, and smart-router’s daily stats when present', () => {
  const chart = costChart({ '2026-10-06': 3.5, '2026-10-07': 1.25 }, '2026-10-07')
  expect(chart.bars).toHaveLength(7)
  expect(chart.bars.at(-1)).toEqual({ label: '10-07', value: 1.25 })
  const svg = chartSvg(chart)
  expect(svg.startsWith('<svg')).toBe(true)
  expect(svg).toContain('$3.50')
  expect(chartText(chart)).toContain('10-06')
  expect(routerChart({ date: '2026-10-07', saved: 2, spent: 5, byModel: {} })?.bars).toEqual([{ label: '10-07', value: 5, second: 2 }])
  expect(routerChart([{ nope: 1 }])).toBeNull()
})

test('settings: defaults work with zero config and values are clamped', () => {
  const zero = readSettings({})
  expect(zero.baseUrl).toBe('http://127.0.0.1:2785/api')
  expect(zero.ownerNumbers).toEqual([])
  expect(zero.notifyMode).toBe('away')
  expect(readSettings({ digestMinutes: 5, pollSeconds: 1, budgetSteps: '25, x, 5' })).toMatchObject({ digestMinutes: 30, pollSeconds: 3, budgetSteps: [5, 25] })
})
