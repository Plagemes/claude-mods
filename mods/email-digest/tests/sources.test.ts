import { expect, test } from 'claude-code/testing'

import { eventFromHub, eventFromNotice, gitLogArgv, mergeEvents, parseDaily, parseGitLog, parseJournal, unresolved } from '../hooks/sources'
import type { DigestEvent } from '../hooks/sources'

const FS = '\u001f'
const RS = '\u001e'

test('git log: the argv reads local branches without merges, the parser reads its records and drops duplicates', () => {
  const argv = gitLogArgv('2026-10-07T00:00:00.000Z', '2026-10-07T16:00:00.000Z')
  expect(argv.slice(0, 4)).toEqual(['git', 'log', '--branches', '--no-merges'])
  expect(argv).toContain('--since=2026-10-07T00:00:00.000Z')
  expect(argv).toContain('--until=2026-10-07T16:00:00.000Z')
  const out = [
    `abc1234${FS}Ada Lovelace${FS}2026-10-07T10:15:00+02:00${FS}feat(cart): add discount codes${RS}`,
    `\ndef5678${FS}Bob${FS}2026-10-07T09:00:00+02:00${FS}fix: rounding: totals${RS}`,
    `\nabc1234${FS}Ada Lovelace${FS}2026-10-07T10:15:00+02:00${FS}feat(cart): add discount codes${RS}`,
    `\nbad${FS}Eve${FS}not a date${FS}broken${RS}`,
  ].join('')
  const commits = parseGitLog(out)
  expect(commits.map(commit => commit.sha)).toEqual(['def5678', 'abc1234'])
  expect(commits[0]).toEqual({ sha: 'def5678', author: 'Bob', at: Date.parse('2026-10-07T07:00:00Z'), subject: 'fix: rounding: totals' })
  expect(parseGitLog('')).toEqual([])
})

test('journals: work done, open questions and unchecked todos are read, headings of entries and other sections are not', () => {
  const md = [
    '## 18:06 · shop · main',
    '',
    '### Work done',
    '- Fixed the login redirect loop',
    '- Added the invoice export',
    '### Open questions',
    '- Should sessions expire after 7 days?',
    '',
    '### Files changed',
    '- `src/auth.ts`',
    '### Requests',
    '- Fix the login redirect loop',
    '### Open todos',
    '- [ ] Add a regression test',
    '- [x] Update the docs',
    '',
    '_2 prompts · session abcdef12_',
    '## 21:40 · shop · main',
    '### Work done',
    '* Tidied the settings page',
  ].join('\n')
  expect(parseJournal(md, '2026-10-07')).toEqual({
    date: '2026-10-07',
    done: ['Fixed the login redirect loop', 'Added the invoice export', 'Tidied the settings page'],
    questions: ['Should sessions expire after 7 days?'],
    todos: ['Add a regression test'],
  })
})

test('smart-router daily.json: only a date and a spent amount are accepted', () => {
  expect(parseDaily({ date: '2026-10-07', saved: 1, spent: 4.5, byModel: {} })).toEqual({ date: '2026-10-07', spent: 4.5 })
  expect(parseDaily({ date: '2026-10-07' })).toBeUndefined()
  expect(parseDaily({ date: '2026-10-07', spent: -1 })).toBeUndefined()
  expect(parseDaily('x')).toBeUndefined()
})

test('hub events: CI, deploys, PRs, decisions, tests, issues and sessions become digest events; the rest is ignored', () => {
  const at = 1_000
  expect(eventFromHub({ topic: 'ci.result', at, data: { provider: 'github', workflow: 'test', outcome: 'failed', branch: 'main', url: 'https://ci/1' } })).toEqual({ at, kind: 'ci', outcome: 'failed', text: 'test (main)', group: 'github:test:main', url: 'https://ci/1' })
  expect(eventFromHub({ topic: 'ci.result', at, data: { provider: 'github', workflow: 'test', outcome: 'cancelled' } })).toBeUndefined()
  expect(eventFromHub({ topic: 'deploy.finished', at, data: { target: 'shop', environment: 'production', version: 'v1.4.0' } })).toMatchObject({ kind: 'deploy', outcome: 'ok', text: 'shop → production v1.4.0' })
  expect(eventFromHub({ topic: 'deploy.failed', at, data: { target: 'shop', environment: 'staging', reason: 'timeout' } })).toMatchObject({ kind: 'deploy', outcome: 'failed', text: 'shop → staging: timeout', group: 'shop:staging' })
  expect(eventFromHub({ topic: 'pr.opened', at, data: { title: 'Add coupons', url: 'https://gh/pr/1', branch: 'b' } })).toEqual({ at, kind: 'pr', text: 'Add coupons', url: 'https://gh/pr/1' })
  expect(eventFromHub({ topic: 'decision.recorded', at, data: { title: 'Use Postgres', summary: 'JSON columns suffice' } })?.text).toBe('Use Postgres: JSON columns suffice')
  expect(eventFromHub({ topic: 'test.result', at, data: { runner: 'vitest', outcome: 'passed', passed: 120, failed: 0 } })).toEqual({ at, kind: 'test', outcome: 'ok', text: 'vitest: 120 passed, 0 failed' })
  expect(eventFromHub({ topic: 'issue.drafted', at, data: { title: 'Cart empties on refresh' } })).toBeUndefined()
  expect(eventFromHub({ topic: 'session.ended', at, data: { durationMs: 1_800_000, turns: 4, usd: 2.5 } })).toMatchObject({ kind: 'session', text: '30 min', usd: 2.5 })
  expect(eventFromHub({ topic: 'risk.blocked', at, data: { guard: 'rm-rf-guard' } })).toBeUndefined()
  expect(eventFromHub({ topic: 'cost.update', at, data: {} })).toBeUndefined()
})

test('notices from the email channel: a level and a title are needed, the body is appended', () => {
  expect(eventFromNotice({ level: 'error', title: 'CI failed', body: 'main is red', at: 5 })).toEqual({ at: 5, kind: 'notice', level: 'error', text: 'CI failed: main is red' })
  expect(eventFromNotice({ id: 'n7', level: 'warning', title: 'Slow tests', at: 6 })).toEqual({ id: 'n7', at: 6, kind: 'notice', level: 'warning', text: 'Slow tests' })
  expect(eventFromNotice({ level: 'loud', title: 'x' })).toBeUndefined()
  expect(eventFromNotice({ level: 'info', title: '' })).toBeUndefined()
})

test('unresolved failures: a later pass of the same workflow or target clears an earlier failure', () => {
  const ci = (at: number, outcome: 'ok' | 'failed', group: string): DigestEvent => ({ at, kind: 'ci', outcome, text: group, group })
  const events = [ci(1, 'failed', 'gh:test:main'), ci(2, 'ok', 'gh:test:main'), ci(3, 'failed', 'gh:lint:main'), ci(4, 'ok', 'gh:test:dev'), ci(5, 'failed', 'gh:test:dev')]
  expect(unresolved(events, 'ci').map(event => event.group)).toEqual(['gh:lint:main', 'gh:test:dev'])
  const deploys: DigestEvent[] = [
    { at: 1, kind: 'deploy', outcome: 'failed', text: 'shop → staging: timeout', group: 'shop:staging' },
    { at: 2, kind: 'deploy', outcome: 'ok', text: 'shop → staging', group: 'shop:staging' },
  ]
  expect(unresolved(deploys, 'deploy')).toEqual([])
})

test('merging events: the same thing within a minute is kept once, the list stays ordered and capped', () => {
  const a: DigestEvent = { at: 60_000, kind: 'pr', text: 'Add coupons' }
  const merged = mergeEvents([a], [{ ...a, at: 60_500 }, { at: 200_000, kind: 'pr', text: 'Fix cart' }, { at: 10, kind: 'pr', text: 'Old' }], 3)
  expect(merged.map(event => event.text)).toEqual(['Old', 'Add coupons', 'Fix cart'])
  expect(mergeEvents(merged, [{ at: 300_000, kind: 'pr', text: 'Newest' }], 3).map(event => event.text)).toEqual(['Add coupons', 'Fix cart', 'Newest'])
  // A channel notice is kept once by its id, however often the hub delivers it (at-least-once).
  const notice: DigestEvent = { id: 'n1', at: 1_000, kind: 'notice', level: 'error', text: 'CI failed' }
  expect(mergeEvents([notice], [{ ...notice, at: 9_000_000 }], 5)).toHaveLength(1)
})
