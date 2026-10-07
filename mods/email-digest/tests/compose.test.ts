import { expect, test } from 'claude-code/testing'

import { classifyCommit, composeDigest, escapeHtml, isSimilar, periodLabel, subjectOf, tidy } from '../hooks/compose'
import type { DigestInput, DigestOptions } from '../hooks/compose'
import type { DigestEvent, Journal } from '../hooks/sources'
import { wallToEpoch } from '../hooks/zones'

const ZONE = 'Europe/Rome'
/** A local time on Wednesday 7 October 2026 in Rome. */
const at = (h: number, m = 0): number => Date.UTC(2026, 9, 7, h - 2, m)
const DAY = { from: Date.UTC(2026, 9, 6, 22), to: at(17) }

const COMMITS = [
  { sha: 'aaa1111', author: 'Ada', at: at(9), subject: 'feat(cart): add discount codes (#42)' },
  { sha: 'bbb2222', author: 'Bob', at: at(10), subject: 'fix: checkout total rounding.' },
  { sha: 'ccc3333', author: 'Ada', at: at(11), subject: 'Improve search speed' },
  { sha: 'ddd4444', author: 'Ada', at: at(12), subject: 'chore: bump deps [skip ci]' },
  { sha: 'eee5555', author: 'Bob', at: at(13), subject: 'docs: update readme' },
  { sha: 'fff6666', author: 'Bob', at: at(14), subject: 'fix: Checkout total rounding' },
]

const EVENTS: DigestEvent[] = [
  { at: at(10), kind: 'ci', outcome: 'failed', text: 'test (main)', group: 'gh:test:main', url: 'https://ci.example/1' },
  { at: at(11), kind: 'ci', outcome: 'ok', text: 'build (main)', group: 'gh:build:main' },
  { at: at(12), kind: 'ci', outcome: 'failed', text: 'lint (main)', group: 'gh:lint:main' },
  { at: at(13), kind: 'ci', outcome: 'ok', text: 'lint (main)', group: 'gh:lint:main' },
  { at: at(13), kind: 'deploy', outcome: 'ok', text: 'shop → production v1.4.0', group: 'shop:production' },
  { at: at(14), kind: 'pr', text: 'Add coupons', url: 'https://gh.example/pr/7' },
  { at: at(15), kind: 'decision', text: 'Use Postgres' },
  { at: at(15), kind: 'notice', level: 'critical', text: 'Disk almost full' },
  { at: at(15), kind: 'test', outcome: 'ok', text: 'vitest: 120 passed, 0 failed' },
]

const JOURNAL: Journal = { date: '2026-10-07', done: ['Customers can now apply a discount code at checkout'], questions: ['Which VAT rate for Switzerland?'], todos: ['Add a regression test', 'Write the release notes'] }

const input = (extra: Partial<DigestInput> = {}): DigestInput => ({ project: 'Shop', period: 'daily', ...DAY, zone: ZONE, commits: COMMITS, events: EVENTS, journals: [JOURNAL], ...extra })
const options = (extra: Partial<DigestOptions> = {}): DigestOptions => ({ tone: 'client', language: 'en', includeCost: false, signature: '', ...extra })
const itemsOf = (digest: ReturnType<typeof composeDigest>, id: string): string[] => digest.sections.find(section => section.id === id)?.items ?? []

test('commits in plain words: conventional prefixes and first words decide the kind, noise is removed', () => {
  expect(classifyCommit('feat(cart): add discount codes (#42)')).toEqual({ category: 'new', text: 'Cart: add discount codes' })
  expect(classifyCommit('fix: checkout total rounding.')).toEqual({ category: 'fix', text: 'Checkout total rounding' })
  expect(classifyCommit('perf: faster search')).toEqual({ category: 'improved', text: 'Faster search' })
  expect(classifyCommit('Add invoice export')).toEqual({ category: 'new', text: 'Add invoice export' })
  expect(classifyCommit('Fixed the login loop')).toEqual({ category: 'fix', text: 'Fixed the login loop' })
  expect(classifyCommit('chore(deps): bump lodash [skip ci]')).toEqual({ category: 'maintenance', text: 'Deps: bump lodash' })
  expect(classifyCommit('docs: explain setup').category).toBe('docs')
  expect(classifyCommit('WIP: fix typo').text).toBe('Fix typo')
  expect(classifyCommit('Tweak colours').category).toBe('improved')
  expect(classifyCommit('Colours, again').category).toBe('other')
  expect(tidy('Do the thing (#12)  ')).toBe('Do the thing')
  expect(isSimilar('Fixed the login redirect loop', 'fix: login redirect loop')).toBe(true)
  expect(isSimilar('Customers can apply a discount code', 'Update readme')).toBe(false)
  expect(isSimilar('Fix typo', 'Fix typo')).toBe(false)
})

test('subject and period labels: a day, a week inside a month, across months and years; English and Italian', () => {
  expect(subjectOf({ project: 'Shop', period: 'daily', ...DAY, zone: ZONE }, 'en')).toBe('Shop · Daily update · 7 Oct 2026')
  expect(subjectOf({ project: 'Shop', period: 'daily', ...DAY, zone: ZONE }, 'it')).toBe('Shop · Aggiornamento giornaliero · 7 ott 2026')
  const midnight = (y: number, m: number, d: number): number => wallToEpoch({ y, m, d, h: 0, mi: 0, s: 0 }, ZONE)
  const week = (from: number[], to: number[]) => periodLabel('weekly', midnight(from[0] ?? 0, from[1] ?? 1, from[2] ?? 1), midnight(to[0] ?? 0, to[1] ?? 1, (to[2] ?? 1) + 1), ZONE, 'en')
  expect(week([2026, 10, 5], [2026, 10, 11])).toBe('5–11 Oct 2026')
  expect(week([2026, 9, 28], [2026, 10, 4])).toBe('28 Sep – 4 Oct 2026')
  expect(week([2026, 12, 29], [2027, 1, 4])).toBe('29 Dec 2026 – 4 Jan 2027')
})

test('client tone: plain bullets without hashes or authors, journal lines first, chores folded into one line, CI trouble said simply', () => {
  const digest = composeDigest(input(), options())
  expect(digest.isEmpty).toBe(false)
  expect(itemsOf(digest, 'done')).toEqual([
    'Customers can now apply a discount code at checkout',
    'Cart: add discount codes',
    'Checkout total rounding',
    'Improve search speed',
    'Plus 2 behind-the-scenes changes (tests, tooling, documentation).',
  ])
  expect(itemsOf(digest, 'shipped')).toEqual(['Deployed: shop → production v1.4.0', 'In review: Add coupons'])
  expect(itemsOf(digest, 'next')).toEqual(['Add a regression test', 'Write the release notes'])
  expect(itemsOf(digest, 'blockers')).toEqual(['Some automated checks are failing; we are looking into it.', 'Open question: Which VAT rate for Switzerland?'])
  expect(digest.sections.find(section => section.id === 'health')).toBeUndefined()
  expect(digest.sections.find(section => section.id === 'alerts')).toBeUndefined()
  expect(digest.text).not.toMatch(/aaa1111|Ada|https?:\/\//)
  expect(digest.text.startsWith('Hello,\n\nHere is a short update on Shop for today, 7 Oct 2026.\n\nWhat was done\n- ')).toBe(true)
})

test('manager tone: a count line, the main items, build health, alerts as a count, no links', () => {
  const digest = composeDigest(input({ journals: [] }), options({ tone: 'manager' }))
  expect(itemsOf(digest, 'done')[0]).toBe('5 changes: 1 new, 1 fixed, 1 improved, 1 docs, 1 maintenance')
  expect(itemsOf(digest, 'done')).toContain('New: Cart: add discount codes')
  expect(itemsOf(digest, 'health')).toEqual(['Builds: 2 passed, 2 failed'])
  expect(itemsOf(digest, 'blockers')).toEqual(['CI: test (main)'])
  expect(itemsOf(digest, 'alerts')).toEqual(['1 alert needed attention (1 critical).'])
  expect(digest.text).not.toMatch(/https?:\/\//)
})

test('technical tone: hashes, authors, links, the latest test run and the loud alerts', () => {
  const digest = composeDigest(input({ journals: [] }), options({ tone: 'technical' }))
  expect(itemsOf(digest, 'done')).toContain('aaa1111 [New] Cart: add discount codes (Ada)')
  expect(itemsOf(digest, 'done')).toContain('ddd4444 [Maintenance] Bump deps (Ada)')
  expect(itemsOf(digest, 'shipped')).toContain('In review: Add coupons <https://gh.example/pr/7>')
  expect(itemsOf(digest, 'health')).toEqual(['Builds: 2 passed, 2 failed', 'Latest tests: vitest: 120 passed, 0 failed ✓'])
  expect(itemsOf(digest, 'blockers')).toEqual(['CI: test (main) <https://ci.example/1>'])
  expect(itemsOf(digest, 'alerts')).toEqual(['[critical] Disk almost full'])
  expect(digest.html).toContain('<a href="https://ci.example/1">link</a>')
})

test('Italian: the digest speaks Italian, the commit messages stay as written', () => {
  const digest = composeDigest(input(), options({ language: 'it' }))
  expect(digest.subject).toBe('Shop · Aggiornamento giornaliero · 7 ott 2026')
  expect(digest.text).toContain('Buongiorno,')
  expect(digest.text).toContain('Cosa è stato fatto')
  expect(digest.text).toContain('Prossimi passi')
  expect(digest.text).toContain('Blocchi e domande')
  expect(digest.text).toContain('Più 2 interventi dietro le quinte')
  expect(digest.text).toContain('Cart: add discount codes')
  expect(composeDigest(input({ events: [], journals: [] }), options({ language: 'it', tone: 'manager' })).sections.find(section => section.id === 'blockers')?.paragraph).toBe('Nessun blocco.')
})

test('blockers: a failure the same workflow later fixed is not a blocker; with none, a sentence says so', () => {
  const calm = composeDigest(input({ events: EVENTS.filter(event => event.group !== 'gh:test:main'), journals: [] }), options())
  expect(calm.sections.find(section => section.id === 'blockers')).toMatchObject({ items: [], paragraph: 'Nothing is blocking us right now.' })
  expect(calm.text).toContain('Nothing is blocking us right now.')
  const managerCalm = composeDigest(input({ events: [], journals: [] }), options({ tone: 'manager' }))
  expect(managerCalm.sections.find(section => section.id === 'blockers')?.paragraph).toBe('No blockers.')
})

test('cost line: only when asked for, with its scope; a one-off note and the signature close the email', () => {
  const plain = composeDigest(input({ costUsd: 12.4 }), options())
  expect(plain.sections.find(section => section.id === 'cost')).toBeUndefined()
  const withCost = composeDigest(input({ costUsd: 12.4, note: 'Demo on Friday' }), options({ includeCost: true, signature: 'Ada\nAcme Studio' }))
  expect(itemsOf(withCost, 'cost')).toEqual(['AI usage cost: $12.40'])
  expect(composeDigest(input({ costUsd: 250, costScope: 'all' }), options({ includeCost: true })).sections.find(section => section.id === 'cost')?.items).toEqual(['AI usage cost: $250 (all projects)'])
  expect(withCost.text.endsWith('Note\nDemo on Friday\n\nAda\nAcme Studio\n')).toBe(true)
  expect(composeDigest(input({ costUsd: 0 }), options({ includeCost: true })).sections.find(section => section.id === 'cost')).toBeUndefined()
})

test('an empty period says so and is flagged for the scheduler; a note alone makes it worth sending', () => {
  const empty = composeDigest(input({ commits: [], events: [], journals: [] }), options())
  expect(empty.isEmpty).toBe(true)
  expect(empty.text).toContain('No activity was recorded in this period.')
  const onlySessions = composeDigest(input({ commits: [], events: [{ at: at(10), kind: 'session', text: '30 min', usd: 1 }], journals: [] }), options())
  expect(onlySessions.isEmpty).toBe(true)
  expect(composeDigest(input({ commits: [], events: [], journals: [], note: 'Back Monday' }), options()).isEmpty).toBe(false)
})

test('the HTML body escapes everything it was given and keeps the structure', () => {
  const digest = composeDigest(input({ commits: [{ sha: 'x', author: 'A', at: at(9), subject: 'fix: <script>alert(1)</script> & "quotes"' }], events: [], journals: [], note: '<b>hi</b>' }), options({ signature: 'A & B' }))
  expect(digest.html).not.toContain('<script>')
  expect(digest.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;')
  expect(digest.html).toContain('&lt;b&gt;hi&lt;/b&gt;')
  expect(digest.html).toContain('<h3')
  expect(digest.html).toContain('<ul')
  expect(digest.html).toContain('A &amp; B')
  expect(escapeHtml(`<a href="x">&</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;')
})

test('a long list is cut with a count of the rest; the weekly digest covers a week', () => {
  const many = Array.from({ length: 25 }, (_unused, index) => ({ sha: `s${index}`, author: 'A', at: at(9) + index * 60_000, subject: `feat: feature number ${index} for the shop` }))
  const digest = composeDigest(input({ commits: many, events: [], journals: [] }), options())
  expect(itemsOf(digest, 'done')).toHaveLength(11)
  expect(itemsOf(digest, 'done')[10]).toBe('…and 15 more')
  const weekly = composeDigest(input({ period: 'weekly', from: Date.UTC(2026, 9, 4, 22), to: at(17) }), options({ tone: 'manager' }))
  expect(weekly.subject).toBe('Shop · Weekly update · 5–7 Oct 2026')
})
