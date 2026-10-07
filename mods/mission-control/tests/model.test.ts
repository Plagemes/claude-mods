import { expect, test } from 'claude-code/testing'

import {
  COMMAND_TTL_MS,
  STALE_MS,
  appendCommand,
  buildBoard,
  dayKey,
  describeTotals,
  episodeOf,
  isLive,
  parseCommand,
  parseHeartbeat,
  parseHubSessions,
  parseInbox,
  parseMissionArgs,
  pendingCommands,
  resolveTarget,
  summarizeTask,
  waitsToAlert,
} from '../hooks/model'
import type { MissionCommand, MissionHeartbeat } from '../types'

/** Wednesday 7 October 2026, noon local time. */
const NOW = new Date(2026, 9, 7, 12, 0, 0).getTime()
const MINUTE = 60_000

const beat = (id: string, patch: Partial<MissionHeartbeat> = {}): MissionHeartbeat => ({
  v: 1,
  id,
  label: `shop#${id.slice(0, 4)}`,
  project: 'shop',
  root: '/work/shop',
  cwd: '/work/shop',
  branch: 'main',
  model: 'claude-opus-5-5',
  surface: 'terminal',
  state: 'idle',
  stateSince: NOW - 10 * MINUTE,
  task: '',
  turnStartedAt: null,
  startedAt: NOW - 60 * MINUTE,
  updatedAt: NOW - 2_000,
  turns: 3,
  tokens: 12_000,
  usd: 0.5,
  isUsdEstimate: false,
  spend: { day: dayKey(NOW), usd: 0.5 },
  subagents: 0,
  lastError: null,
  blocked: null,
  paused: false,
  priority: 'normal',
  acked: [],
  ended: false,
  ...patch,
})

const command = (id: string, patch: Partial<MissionCommand> = {}): MissionCommand => ({ id, at: NOW - MINUTE, kind: 'pause', from: { session: 'peer', label: 'api#peer' }, ...patch })

test('heartbeats: parsed defensively, live for 30 s after the last write, never once ended', () => {
  const written = beat('a1b2c3d4')
  expect(parseHeartbeat(JSON.parse(JSON.stringify(written)))).toEqual(written)
  expect(parseHeartbeat({ v: 2, id: 'x' })).toBeNull()
  expect(parseHeartbeat('garbage')).toBeNull()
  expect(parseHeartbeat({ v: 1, id: 'b2c3d4e5', state: 'dancing', priority: 'urgent' })).toMatchObject({ state: 'idle', priority: 'normal', label: 'session#b2c3' })

  expect(isLive(beat('a', { updatedAt: NOW - STALE_MS }), NOW)).toBe(true)
  expect(isLive(beat('a', { updatedAt: NOW - STALE_MS - 1 }), NOW)).toBe(false)
  expect(isLive(beat('a', { ended: true }), NOW)).toBe(false)
})

test('the inbox: each command runs once, old ones never, handled and expired ones are pruned on the next write', () => {
  const old = command('old', { at: NOW - COMMAND_TTL_MS - 1 })
  const done = command('done')
  const fresh = command('fresh', { kind: 'note', text: 'please rebase on main', at: NOW - 30_000 })
  const first = command('first', { kind: 'priority', priority: 'high', at: NOW - 40_000 })
  const file = [old, done, fresh, first].map(entry => JSON.stringify(entry)).join('\n') + '\n{"cut in ha'

  const parsed = parseInbox(file)
  expect(parsed.map(entry => entry.id)).toEqual(['old', 'done', 'fresh', 'first'])
  expect(pendingCommands(parsed, ['done'], NOW).map(entry => entry.id)).toEqual(['first', 'fresh'])

  const next = appendCommand(file, command('new', { kind: 'stop', at: NOW }), ['done'], NOW)
  expect(parseInbox(next).map(entry => entry.id)).toEqual(['fresh', 'first', 'new'])

  expect(parseCommand({ id: 'n', at: NOW, kind: 'note', text: '  ' })).toBeNull()
  expect(parseCommand({ id: 'p', at: NOW, kind: 'priority', priority: 'urgent' })).toBeNull()
  expect(parseCommand({ id: 'r', at: NOW, kind: 'reboot' })).toBeNull()
})

test('the board: live cards (and hub-only sessions), totals over live ones, spend today over every heartbeat of today', () => {
  const me = beat('me000001', { state: 'working', turnStartedAt: NOW - 90_000, usd: 0.4, spend: { day: dayKey(NOW), usd: 0.4 } })
  const waiting = beat('wait0001', { project: 'api', label: 'api#wait', state: 'waiting-permission', stateSince: NOW - 5 * MINUTE, blocked: 'Approve Bash: npm publish', usd: 1.2, spend: { day: dayKey(NOW), usd: 1.2 } })
  const ended = beat('gone0001', { ended: true, spend: { day: dayKey(NOW), usd: 0.3 } })
  const stale = beat('dead0001', { updatedAt: NOW - 2 * MINUTE, spend: { day: dayKey(NOW), usd: 0.1 } })
  const yesterday = beat('old00001', { updatedAt: NOW - 2 * MINUTE, spend: { day: dayKey(NOW - 24 * 60 * MINUTE), usd: 9 } })
  const hub = parseHubSessions({ hubonly1: { lastSeen: NOW - MINUTE, project: 'docs', usd: 0.2 }, me000001: { lastSeen: NOW, project: 'shop' }, ancient: { lastSeen: NOW - 60 * MINUTE } }, NOW, 10 * MINUTE)

  const board = buildBoard({ beats: [me, waiting, ended, stale, yesterday], hub, me: 'me000001', now: NOW, sort: 'status', filter: 'all', alertMs: 3 * MINUTE })
  expect(board.cards.map(card => card.id)).toEqual(['wait0001', 'me000001', 'hubonly1'])
  expect(board.cards[0]).toMatchObject({ elapsedMs: 5 * MINUTE, blocked: 'Approve Bash: npm publish', isMe: false })
  expect(board.cards[1]).toMatchObject({ elapsedMs: 90_000, isMe: true })
  expect(board.cards[2]).toMatchObject({ isHubOnly: true, project: 'docs' })
  expect(board.totals).toMatchObject({ sessions: 3, working: 1, waiting: 1, longWaits: 1 })
  expect(Math.round(board.totals.spendToday * 100)).toBe(200)
  expect(describeTotals(board.totals)).toBe('3 sessions · 1 working · 1 waiting · $2.00 today')

  const byCost = buildBoard({ beats: [me, waiting], hub: [], me: 'me000001', now: NOW, sort: 'cost', filter: 'all', alertMs: 3 * MINUTE })
  expect(byCost.cards.map(card => card.id)).toEqual(['wait0001', 'me000001'])
  const onlyWorking = buildBoard({ beats: [me, waiting], hub: [], me: 'me000001', now: NOW, sort: 'status', filter: 'working', alertMs: 3 * MINUTE })
  expect(onlyWorking.cards.map(card => card.id)).toEqual(['me000001'])
  expect(onlyWorking.totals.sessions).toBe(2)
})

test('alerts: another live session waiting past the limit, once per wait', () => {
  const waiting = beat('wait0001', { state: 'waiting-input', stateSince: NOW - 4 * MINUTE })
  const short = beat('wait0002', { state: 'waiting-permission', stateSince: NOW - MINUTE })
  const mine = beat('me000001', { state: 'waiting-permission', stateSince: NOW - 9 * MINUTE })
  const alerted = new Set<string>()
  expect(waitsToAlert([waiting, short, mine], 'me000001', NOW, 3 * MINUTE, alerted).map(one => one.id)).toEqual(['wait0001'])
  alerted.add(episodeOf(waiting))
  expect(waitsToAlert([waiting], 'me000001', NOW, 3 * MINUTE, alerted)).toEqual([])
  const again = { ...waiting, stateSince: NOW - 3 * MINUTE }
  expect(waitsToAlert([again], 'me000001', NOW, 3 * MINUTE, alerted).map(one => one.id)).toEqual(['wait0001'])
})

test('naming sessions and the /mission words', () => {
  const sessions = [
    { id: 'a1b2c3d4', label: 'shop#a1b2', project: 'shop' },
    { id: 'a1ff0000', label: 'shop#a1ff', project: 'shop' },
    { id: 'c3d4e5f6', label: 'api#c3d4', project: 'api' },
  ]
  expect(resolveTarget(sessions, 'shop#a1b2')).toMatchObject({ id: 'a1b2c3d4' })
  expect(resolveTarget(sessions, 'c3d4')).toMatchObject({ id: 'c3d4e5f6' })
  expect(resolveTarget(sessions, 'api')).toMatchObject({ id: 'c3d4e5f6' })
  expect(resolveTarget(sessions, 'a1')).toContain('matches shop#a1b2, shop#a1ff')
  expect(resolveTarget(sessions, 'nope')).toContain('No live session')

  expect(parseMissionArgs('')).toEqual({ kind: 'open' })
  expect(parseMissionArgs('pause api')).toEqual({ kind: 'command', command: 'pause', who: 'api' })
  expect(parseMissionArgs('note api  please rebase on main')).toEqual({ kind: 'note', who: 'api', text: 'please rebase on main' })
  expect(parseMissionArgs('priority api HIGH')).toEqual({ kind: 'priority', who: 'api', priority: 'high' })
  expect(parseMissionArgs('priority api urgent').kind).toBe('error')
  expect(parseMissionArgs('stop').kind).toBe('error')

  expect(summarizeTask('\n  <system-reminder>x</system-reminder>\nFix the   login bug\nand more')).toBe('Fix the login bug')
})
