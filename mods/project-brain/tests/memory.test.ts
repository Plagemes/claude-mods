import { expect, test } from 'claude-code/testing'

import { approxTokens, featuresOf } from '../hooks/features'
import { Brain, type NodeKind } from '../hooks/graph'
import { commandKey, errorLine, heuristicExtract, ownerPatternMatches, parseAdr, parseCodeowners, parseExtraction, parseGlossary, wasUsed } from '../hooks/ingest'
import { NOTE_HEADER, type Recalled, composeNote, mayInject } from '../hooks/inject'
import { addExtracted, finishTurn, importKnowledge, ingestCommand, ingestEdit, newSession, prepareInjection, takeTurn } from '../hooks/mind'
import { Ranker, prng } from '../hooks/ranker'
import { recall } from '../hooks/recall'

const T0 = Date.UTC(2026, 9, 2, 9)
const MINUTE = 60_000

const EN_TRANSCRIPT = `Sure. After comparing options we decided to use Postgres for the orders service, since we need transactions.
From now on, always run \`pnpm test --filter orders\` before pushing.
The problem was that the pool was never released; fixed it by closing clients in a finally block in src/db.ts.
Do you want me to update the README?`

const IT_TRANSCRIPT = `Abbiamo deciso di usare Redis per la cache delle sessioni.
D'ora in poi usa sempre pnpm, non usare mai npm in questo repo.
Il problema era il fuso orario: risolto con date-fns-tz in src/utils/date.ts.`

test('ingestion from fake transcripts: decisions, conventions and lessons in English and Italian', () => {
  const en = heuristicExtract(EN_TRANSCRIPT)
  expect(en.map(item => item.kind)).toEqual(['decision', 'convention', 'lesson'])
  expect(en[2]?.files).toEqual(['src/db.ts'])
  expect(en.some(item => item.text.includes('README'))).toBe(false) // a question is no memory

  const it = heuristicExtract(IT_TRANSCRIPT)
  expect(it.map(item => item.kind)).toEqual(['decision', 'convention', 'lesson'])
  expect(it[2]?.files).toEqual(['src/utils/date.ts'])

  const brain = new Brain()
  const session = newSession()
  session.turn = 1
  ingestEdit(brain, session, { path: 'src/db.ts', code: 'export async function withClient(fn) {\n  const client = await pool.connect()\n}\n', at: T0 })
  const report = finishTurn(brain, new Ranker(), takeTurn(session), { prompt: 'Why do connections leak?', answer: `${EN_TRANSCRIPT}\n${IT_TRANSCRIPT}`, at: T0 })
  expect(report.extracted.length).toBeGreaterThanOrEqual(5)
  const kinds = [...brain.nodes.values()].map(node => node.kind)
  for (const kind of ['decision', 'convention', 'lesson', 'file', 'symbol'] as NodeKind[]) expect(kinds).toContain(kind)
  // Everything said this turn is wired to the file edited this turn.
  const db = [...brain.nodes.values()].find(node => node.kind === 'file' && node.text === 'src/db.ts')
  const decision = [...brain.nodes.values()].find(node => node.kind === 'decision' && node.text.includes('Postgres'))
  expect(db === undefined || decision === undefined ? undefined : brain.edge(db.id, decision.id)?.type).toBe('decided-for')
  expect(report.hebbianPairs).toBeGreaterThan(5)
})

test('a failing test, edits, then the same test passing becomes an error → fix lesson', () => {
  const brain = new Brain()
  const session = newSession()
  const failed = ingestCommand(brain, session, { command: 'npx vitest run src/cart.test.ts', output: ' FAIL  src/cart.test.ts > totals\nAssertionError: expected 41 to be 42\n', hasFailed: true, at: T0 })
  expect(failed.kind).toBe('failed')
  ingestEdit(brain, session, { path: 'src/cart.ts', code: 'export const total = (items) => items.reduce(sum, 0)', at: T0 + MINUTE })
  const fixed = ingestCommand(brain, session, { command: 'npx vitest run src/cart.test.ts', output: 'Tests 3 passed', hasFailed: false, at: T0 + 2 * MINUTE })
  expect(fixed.kind).toBe('fixed')
  if (fixed.kind !== 'fixed') return
  const lesson = brain.get(fixed.lessonId)
  expect(lesson?.text).toContain('src/cart.ts')
  expect(lesson?.text).toContain('AssertionError')
  expect(brain.edge(fixed.errorId, fixed.lessonId)?.type).toBe('fixed-by')
  expect(fixed.fix).toContain('passed after editing src/cart.ts')
  // Next time the same error shows up, the fix is recalled through the error.
  const errorNode = brain.get(fixed.errorId)
  expect(recall(brain, { text: 'tests are red again', nodes: [[fixed.errorId, 0.8]], now: T0 + 3 * MINUTE }).map(c => c.id)).toContain(fixed.lessonId)
  expect(errorNode?.kind).toBe('error')
  expect(commandKey('npx vitest run src/cart.test.ts --reporter=dot')).toBe('npx vitest run')
  expect(commandKey('CI=1 pnpm --filter ./web test')).toBe('pnpm test')
  expect(errorLine('\u001b[31mError: Cannot find module "x"\u001b[0m')).toBe('Error: Cannot find module "x"')
})

test('existing knowledge: ADRs, glossary, CODEOWNERS, CLAUDE.md (marked as already in the prompt)', () => {
  const adr = parseAdr('docs/decisions/0003-postgres.md', '# 3. Use Postgres\n\nDate: 2026-09-14\n\n## Status\nAccepted\n\n## Decision\nWe store orders in Postgres via src/db.ts. Reads go through replicas.\n')
  expect(adr).toMatchObject({ kind: 'decision', ref: 'docs/decisions/0003-postgres.md', date: '2026-09-14', files: ['src/db.ts'] })
  expect(adr?.text).toBe('Use Postgres: We store orders in Postgres via src/db.ts.')
  expect(parseGlossary('| Term | Meaning |\n|---|---|\n| SKU | stock keeping unit |\n**Basket**: the cart before checkout\n').map(item => item.text)).toEqual([
    'SKU: stock keeping unit',
    'Basket: the cart before checkout',
  ])
  expect(parseCodeowners('# owners\nsrc/api/ @alice @org/backend\n*.css @bob\n').map(item => item.text)).toEqual(['@alice owns src/api/', '@org/backend owns src/api/', '@bob owns *.css'])
  expect(ownerPatternMatches('src/api/', 'src/api/routes/x.ts')).toBe(true)
  expect(ownerPatternMatches('*.css', 'web/theme.css')).toBe(true)
  expect(ownerPatternMatches('/docs/', 'src/docs/x.md')).toBe(false)

  const brain = new Brain()
  ingestEdit(brain, newSession(), { path: 'src/api/routes.ts', code: '', at: T0 })
  expect(importKnowledge(brain, 'codeowners', 'CODEOWNERS', 'src/api/ @alice\n', T0)).toBe(1)
  const alice = [...brain.nodes.values()].find(node => node.kind === 'person')
  const routes = [...brain.nodes.values()].find(node => node.text === 'src/api/routes.ts')
  expect(alice !== undefined && routes !== undefined && brain.edge(alice.id, routes.id) !== undefined).toBe(true)
  expect(importKnowledge(brain, 'claude-md', 'CLAUDE.md', '# Rules\n- Always use pnpm, never npm.\n- Tests live next to the code.\n', T0)).toBe(2)
  expect([...brain.nodes.values()].filter(node => node.isInPrompt)).toHaveLength(2)
  // A rule taken out of CLAUDE.md may be recalled again.
  importKnowledge(brain, 'claude-md', 'CLAUDE.md', '# Rules\n- Always use pnpm, never npm.\n', T0)
  expect([...brain.nodes.values()].filter(node => node.isInPrompt).map(node => node.text)).toEqual(['Always use pnpm, never npm.'])
  expect(importKnowledge(brain, 'adr', 'docs/decisions/0003-postgres.md', '# 3. Use Postgres\n\n## Decision\nOrders live in Postgres.\n', T0)).toBe(1)
  const decision = [...brain.nodes.values()].find(node => node.kind === 'decision')
  expect(decision === undefined ? '' : new Date(decision.created).toISOString()).toBe(new Date(T0).toISOString())
})

test('the model extraction reply is validated; secrets never reach the graph', () => {
  const reply = 'Here you go:\n{"items":[{"kind":"decision","text":"Use Postgres for orders (src/db.ts)","files":["src/db.ts"]},{"kind":"bogus","text":"nope nope"},{"kind":"lesson","text":"x"}]}'
  expect(parseExtraction(reply)).toEqual([{ kind: 'decision', text: 'Use Postgres for orders (src/db.ts)', files: ['src/db.ts'] }])
  expect(parseExtraction('no json')).toEqual([])
  const brain = new Brain()
  const token = `ghp_${'a1'.repeat(18)}`
  const [node] = addExtracted(brain, [{ kind: 'convention', text: `Deploy with token ${token} via the CI secret` }], { source: 'model', at: T0, salience: 0.5 })
  expect(node?.text).not.toContain(token)
  expect(node?.text).toContain('[REDACTED:')
})

function memory(id: string, kind: NodeKind, text: string, created = T0): Recalled {
  const brain = new Brain()
  const node = brain.upsert({ kind, text, source: 'user', at: created })?.node
  if (node === undefined) throw new Error('no node')
  return { id, node, score: 0.8, activation: 0.9, matched: ['postgr', 'order', 'order_postgr'] }
}

test('injection: within the token budget, with when and why, once per conversation', () => {
  const items = Array.from({ length: 20 }, (_, i) => memory(`d${i}`, 'decision', `Decision number ${i}: use Postgres for orders and keep migrations reversible in every service we run`))
  const note = composeNote(items, 120)
  expect(approxTokens(note.text)).toBeLessThanOrEqual(120)
  expect(note.ids.length).toBeGreaterThan(0)
  expect(note.ids.length).toBeLessThan(20)
  expect(note.text.startsWith(NOTE_HEADER)).toBe(true)
  expect(note.text).toContain('- decided 2026-10-02: Decision number 0')
  expect(note.text).toContain('(matches postgr, order)')
  expect(composeNote(items, 10)).toEqual({ text: '', ids: [] })

  const log = new Map([['d1', { turn: 1, activation: 0.7 }]])
  expect(mayInject(log, 'd2', 0.5, 2)).toBe(true)
  expect(mayInject(log, 'd1', 0.95, 3)).toBe(false)
  expect(mayInject(log, 'd1', 0.6, 20)).toBe(false)
  expect(mayInject(log, 'd1', 0.95, 20)).toBe(true)

  const brain = new Brain()
  importKnowledge(brain, 'claude-md', 'CLAUDE.md', '- Always use pnpm for every script in this repo.\n', T0)
  addExtracted(brain, [{ kind: 'decision', text: 'We chose Postgres for the orders service because of transactions' }], { source: 'user', at: T0, salience: 0.6 })
  const session = newSession()
  session.turn = 1
  const first = prepareInjection(brain, new Ranker(), session, 'add a refund column to the orders table in postgres, run it with pnpm', T0)
  expect(first.note).toContain('Postgres for the orders service')
  expect(first.note).not.toContain('pnpm') // CLAUDE.md is already in the system prompt
  session.turn = 2
  expect(prepareInjection(brain, new Ranker(), session, 'and the postgres orders index?', T0).note).toBe('')
})

test('feedback: a used memory is reinforced and trains the ranker; one ignored twice is a negative sample', () => {
  const brain = new Brain()
  const ranker = new Ranker()
  const [postgres] = addExtracted(brain, [{ kind: 'decision', text: 'Orders live in Postgres; use the withClient helper from src/db.ts' }], { source: 'user', at: T0, salience: 0.4 })
  const [css] = addExtracted(brain, [{ kind: 'convention', text: 'Orders page buttons use design tokens, never raw hex colours' }], { source: 'user', at: T0, salience: 0.4 })
  const session = newSession()
  session.turn = 1
  const injected = prepareInjection(brain, ranker, session, 'orders query is slow', T0)
  expect(injected.ids).toContain(postgres?.id)
  expect(injected.ids).toContain(css?.id)
  ingestEdit(brain, session, { path: 'src/db.ts', code: 'export const withClient = async () => {}', at: T0 + MINUTE })
  const report = finishTurn(brain, ranker, takeTurn(session), { prompt: 'orders query is slow', answer: 'I wrapped the query in withClient in src/db.ts.', at: T0 + MINUTE })
  expect(report.used).toEqual([postgres?.id])
  expect(report.ignored).toEqual([css?.id])
  expect(report.trained).toBe(1)
  expect(postgres?.uses).toBe(1)
  expect(brain.salienceOf(postgres ?? css!, T0 + MINUTE)).toBeGreaterThan(0.5)
  // Ignored a second time: now it is a negative sample.
  session.pending.push({ id: css?.id ?? '', x: new Array(16).fill(0.3), turn: 2, activation: 0.5 })
  expect(finishTurn(brain, ranker, takeTurn(session), { prompt: 'x', answer: 'Done.', at: T0 + 2 * MINUTE }).trained).toBe(1)
  expect(ranker.samples).toBe(2)
  expect(wasUsed({ text: 'Use Redis for sessions', ref: null, features: featuresOf('Use Redis for sessions') }, { text: 'Sessions now go to Redis as decided.', files: new Set(), symbols: new Set() }, () => 1)).toBe(true)
})

test('consolidation merges near-duplicates, keeps links, prunes weak memories and respects the cap', () => {
  const brain = new Brain({ ...new Brain().params, maxNodes: 6 })
  const a = brain.upsert({ kind: 'convention', text: 'Always run the linter before committing changes to main', source: 'transcript', at: T0 })?.node
  // Inserted as a near-duplicate: becomes the same memory at once.
  expect(brain.upsert({ kind: 'convention', text: 'Always run the linter before committing changes to main!', source: 'transcript', at: T0 })?.isNew).toBe(false)
  const b = brain.upsert({ kind: 'convention', text: 'Always run the linter before committing changes to the main branch of the repo', source: 'model', at: T0 + 1 })?.node
  expect(b?.id).not.toBe(a?.id)
  const file = brain.upsert({ kind: 'file', text: '.eslintrc.json', source: 'edit', at: T0 })?.node
  brain.link(b?.id ?? '', file?.id ?? '', 'mentions', 0.7, T0)
  const report = brain.consolidate(T0 + MINUTE)
  expect(report.merged).toBe(1)
  expect(brain.get(b?.id ?? '')).toBeUndefined()
  expect(brain.edge(a?.id ?? '', file?.id ?? '')?.w ?? 0).toBeGreaterThan(0.69) // moved over, minus a minute's decay
  expect(brain.get(a?.id ?? '')?.text).toContain('of the repo') // the model's wording outranks a heuristic's

  for (let i = 0; i < 10; i += 1) brain.upsert({ kind: 'note', text: `scratch note ${i} about topic ${i * 7919}`, source: 'transcript', at: T0, salience: 0.01 })
  const later = T0 + 30 * 24 * 60 * MINUTE
  const capped = brain.consolidate(later)
  expect(capped.nodes).toBeLessThanOrEqual(6)
  expect(brain.get(a?.id ?? '')).toBeDefined()
})

test('persistence round-trip: nodes, edges, counters, flags and tombstones survive', () => {
  const brain = new Brain()
  const session = newSession()
  ingestEdit(brain, session, { path: 'src/a.ts', code: 'export function alphaThing() {}', at: T0 })
  ingestEdit(brain, session, { path: 'src/b.ts', code: 'import { alphaThing } from "./a"\nexport class BetaService {}', at: T0 })
  const [rule] = addExtracted(brain, [{ kind: 'convention', text: 'Services are classes named *Service in src/' }], { source: 'user', at: T0, salience: 0.6, files: ['src/b.ts'] })
  if (rule !== undefined) {
    rule.isPinned = true
    rule.uses = 3
  }
  brain.hebbian([[brain.nodes.keys().next().value ?? '', 1], [rule?.id ?? '', 1]], T0)
  const gone = addExtracted(brain, [{ kind: 'note', text: 'temporary note to be forgotten soon' }], { source: 'transcript', at: T0, salience: 0.3 })[0]
  brain.forget(gone?.id ?? '', T0)
  const file = JSON.parse(JSON.stringify(brain.toFile(T0)))
  const copy = Brain.fromFile(file)
  expect(copy.nodes.size).toBe(brain.nodes.size)
  expect(copy.edgeCount).toBe(brain.edgeCount)
  expect(copy.get(rule?.id ?? '')).toMatchObject({ isPinned: true, uses: 3, text: rule?.text })
  const b = [...copy.nodes.values()].find(node => node.text === 'src/b.ts')
  const a = [...copy.nodes.values()].find(node => node.text === 'src/a.ts')
  expect(a !== undefined && b !== undefined ? copy.edge(a.id, b.id)?.type : undefined).toBe('depends-on')
  expect(copy.index.search(['sym:betaservice']).length).toBe(1)
  // A forgotten memory does not come back from automatic ingestion…
  expect(addExtracted(copy, [{ kind: 'note', text: 'temporary note to be forgotten soon' }], { source: 'transcript', at: T0, salience: 0.3 })).toEqual([])
  // …and another session's save is absorbed.
  const other = Brain.fromFile(file)
  addExtracted(other, [{ kind: 'lesson', text: 'Flaky e2e tests came from a shared port 3000' }], { source: 'user', at: T0, salience: 0.5 })
  expect(copy.absorb(other.toFile(T0 + MINUTE))).toBe(1)
  expect(Brain.fromFile({ v: 2 }).nodes.size).toBe(0)
})

test('benchmark: recall over 5k nodes and 50k edges takes under 50 ms', { timeoutMs: 30_000 }, () => {
  const random = prng(2026)
  const vocabulary = Array.from({ length: 3000 }, (_, i) => `w${i.toString(36)}x`)
  const kinds: NodeKind[] = ['decision', 'convention', 'lesson', 'file', 'symbol', 'error', 'term', 'note']
  const brain = new Brain({ ...new Brain().params, maxNodes: 10_000, maxEdges: 100_000 })
  const ids: string[] = []
  for (let i = 0; i < 5000; i += 1) {
    const kind = kinds[i % kinds.length] as NodeKind
    const text = kind === 'file' ? `src/module${i}/file${i}.ts` : Array.from({ length: 12 }, () => vocabulary[Math.floor(random() ** 2 * vocabulary.length)]).join(' ')
    const made = brain.upsert({ kind, text, key: `k${i}`, source: 'user', at: T0 })
    if (made !== undefined) ids.push(made.node.id)
  }
  while (brain.edgeCount < 50_000) {
    const a = ids[Math.floor(random() * ids.length)] as string
    const b = ids[Math.floor(random() ** 3 * ids.length)] as string // some hubs
    brain.link(a, b, 'related', 0.1 + random() * 0.9, T0)
  }
  expect(brain.nodes.size).toBe(5000)
  expect(brain.edgeCount).toBe(50_000)
  const queries = Array.from({ length: 20 }, () => Array.from({ length: 8 }, () => vocabulary[Math.floor(random() * 400)]).join(' '))
  recall(brain, { text: queries[0] ?? '', now: T0 })
  const started = Date.now()
  let found = 0
  for (const query of queries) found += recall(brain, { text: query, files: [['src/module3/file3.ts', 1]], now: T0 + MINUTE }).length
  const perRecall = (Date.now() - started) / queries.length
  expect(found).toBeGreaterThan(0)
  expect(perRecall).toBeLessThan(50)
})
