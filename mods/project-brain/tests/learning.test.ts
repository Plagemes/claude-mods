import { expect, test } from 'claude-code/testing'

import { featuresOf, jaccard, stem } from '../hooks/features'
import { Brain, DEFAULT_PARAMS, decayed, hebbianStep } from '../hooks/graph'
import { Ranker, blendedScore, prng } from '../hooks/ranker'
import { DEFAULT_RECALL, recall } from '../hooks/recall'

const DAY = 86_400_000
const T0 = Date.UTC(2026, 9, 1, 12)
const close = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps

test('features: EN and IT stems meet, paths and symbols become features', () => {
  expect(stem('decided')).toBe(stem('decide'))
  expect(stem('decisions')).toBe(stem('decisione'))
  expect(stem('conventions')).toBe(stem('convenzione'))
  expect(stem('testing')).toBe(stem('tests'))
  const features = featuresOf('Abbiamo deciso: usiamo Postgres in src/db/client.ts via createPool()')
  expect(features).toContain('path:src/db/client.ts')
  expect(features).toContain('file:client.ts')
  expect(features).toContain('sym:createpool')
  expect(features).toContain(stem('postgres'))
  expect(features.some(feature => feature.includes('_'))).toBe(true)
  expect(features).not.toContain('abbiamo')
  expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBe(1 / 3)
})

test('Hebbian update: Δw = η·a_i·a_j·(wMax − w), bounded, symmetric, saturating', () => {
  expect(hebbianStep(0, 1, 1, 0.25, 1)).toBe(0.25)
  expect(close(hebbianStep(0.25, 1, 1, 0.25, 1), 0.25 + 0.25 * 0.75)).toBe(true)
  expect(close(hebbianStep(0.5, 0.4, 0.5, 0.2, 1), 0.5 + 0.2 * 0.4 * 0.5 * 0.5)).toBe(true)
  expect(hebbianStep(0.3, 0, 1, 0.25, 1)).toBe(0.3)
  let w = 0
  for (let i = 0; i < 200; i += 1) w = hebbianStep(w, 1, 1, 0.5, 1)
  expect(w).toBeLessThanOrEqual(1)
  expect(w).toBeGreaterThan(0.99)

  const brain = new Brain()
  const a = brain.upsert({ kind: 'file', text: 'src/a.ts', source: 'edit', at: T0 })?.node.id ?? ''
  const b = brain.upsert({ kind: 'file', text: 'src/b.ts', source: 'edit', at: T0 })?.node.id ?? ''
  const c = brain.upsert({ kind: 'file', text: 'src/c.ts', source: 'edit', at: T0 })?.node.id ?? ''
  expect(brain.hebbian([[a, 1], [b, 1], [c, 0.05]], T0)).toBe(1) // a·c = b·c = 0.05: too weak to wire new edges
  expect(brain.edge(a, c)).toBeUndefined()
  const ab = brain.edge(a, b)
  expect(ab?.type).toBe('co-edited')
  expect(ab?.w).toBe(0.25)
  expect(brain.edge(b, a)).toBe(ab)
  brain.hebbian([[a, 1], [b, 1]], T0)
  expect(close(brain.edge(a, b)?.w ?? 0, 0.4375)).toBe(true)
})

test('decay: an unused edge halves every half-life, and consolidation prunes what fades out', () => {
  expect(decayed(0.8, 14 * DAY, 14 * DAY)).toBe(0.4)
  expect(close(decayed(0.8, 28 * DAY, 14 * DAY), 0.2)).toBe(true)
  expect(decayed(0.8, 0, 14 * DAY)).toBe(0.8)

  const brain = new Brain({ ...DEFAULT_PARAMS, halfLifeMs: 7 * DAY })
  const a = brain.upsert({ kind: 'file', text: 'src/a.ts', source: 'edit', at: T0 })?.node.id ?? ''
  const b = brain.upsert({ kind: 'file', text: 'src/b.ts', source: 'edit', at: T0 })?.node.id ?? ''
  brain.link(a, b, 'co-edited', 0.5, T0)
  const edge = brain.edge(a, b)
  expect(edge === undefined ? 0 : brain.weightOf(edge, T0 + 7 * DAY)).toBe(0.25)
  // reinforcement starts from the decayed weight
  brain.hebbian([[a, 1], [b, 1]], T0 + 7 * DAY)
  expect(close(brain.edge(a, b)?.w ?? 0, 0.25 + 0.25 * 0.75)).toBe(true)
  const report = brain.consolidate(T0 + 7 * DAY + 70 * DAY)
  expect(report.prunedEdges).toBe(1)
  expect(brain.edge(a, b)).toBeUndefined()
})

/** decision —decided-for→ db.ts —co-edited→ migrations; a convention on db.ts; an unrelated lesson. */
function toyBrain() {
  const brain = new Brain()
  const add = (kind: Parameters<Brain['upsert']>[0]['kind'], text: string): string => brain.upsert({ kind, text, source: 'user', at: T0 })?.node.id ?? ''
  const ids = {
    postgres: add('decision', 'Use Postgres for the orders service because we need transactions'),
    db: add('file', 'src/db.ts'),
    migrations: add('file', 'migrations/001_init.sql'),
    review: add('convention', 'Every schema change ships as a reviewed down-migration too'),
    pool: add('lesson', 'Connection pool exhaustion was fixed by closing clients in finally blocks'),
    css: add('convention', 'Buttons use the design tokens from theme.css, never raw hex colours'),
  }
  brain.link(ids.postgres, ids.db, 'decided-for', 0.9, T0)
  brain.link(ids.db, ids.migrations, 'co-edited', 0.8, T0)
  brain.link(ids.migrations, ids.review, 'mentions', 0.8, T0)
  brain.link(ids.db, ids.pool, 'mentions', 0.6, T0)
  return { brain, ids }
}

test('spreading activation ranks a toy graph: seeds first, then by path strength, unrelated memories stay dark', () => {
  const { brain, ids } = toyBrain()
  const ranked = recall(brain, { text: 'how do we store orders in postgres?', now: T0 })
  const order = ranked.map(candidate => candidate.id)
  expect(order[0]).toBe(ids.postgres)
  expect(order).toContain(ids.db)
  expect(order).toContain(ids.review) // three hops away, no shared words
  expect(order).not.toContain(ids.css)
  const at = (id: string) => ranked.find(candidate => candidate.id === id)
  expect(at(ids.db)?.via?.id).toBe(ids.postgres)
  expect(at(ids.review)?.hops).toBe(3)
  expect(at(ids.db)?.activation ?? 0).toBeGreaterThan(at(ids.review)?.activation ?? 1)

  // A file in play lights its own neighbourhood without any words in common.
  const byFile = recall(brain, { text: 'tidy this up', files: [['src/db.ts', 1]], now: T0 })
  expect(byFile.slice(0, 3).map(candidate => candidate.id)).toContain(ids.postgres)
  expect(byFile.find(candidate => candidate.id === ids.pool)?.via?.type).toBe('mentions')

  // Lateral inhibition: with two winners only the two most active survive.
  const narrow = recall(brain, { text: 'orders postgres', now: T0 }, { ...DEFAULT_RECALL, winners: 2 })
  expect(narrow).toHaveLength(2)
  expect(narrow[0]?.id).toBe(ids.postgres)
})

test('MLP: back-propagation matches numerical gradients', () => {
  const ranker = new Ranker({ inputs: 5, hidden: 4, learningRate: 0.1, l2: 0.01, seed: 3 })
  const x = [0.2, -0.4, 0.9, 0.1, 0.5]
  for (const y of [0, 1]) {
    const grad = ranker.gradients(x, y)
    const eps = 1e-5
    const row = ranker.w1[1] as number[]
    const keep = row[2] as number
    row[2] = keep + eps
    const up = ranker.loss(x, y)
    row[2] = keep - eps
    const down = ranker.loss(x, y)
    row[2] = keep
    expect(Math.abs((up - down) / (2 * eps) - (grad.w1[1]?.[2] ?? 0))).toBeLessThan(1e-6)
    const keep2 = ranker.w2[3] as number
    ranker.w2[3] = keep2 + eps
    const up2 = ranker.loss(x, y)
    ranker.w2[3] = keep2 - eps
    const down2 = ranker.loss(x, y)
    ranker.w2[3] = keep2
    expect(Math.abs((up2 - down2) / (2 * eps) - (grad.w2[3] ?? 0))).toBeLessThan(1e-6)
  }
  // Deterministic initialisation.
  expect(new Ranker().w1).toEqual(new Ranker().w1)
})

test('MLP: learns a synthetic rule online (used when activation and lexical match are both high)', () => {
  const ranker = new Ranker({ inputs: 16, hidden: 8, learningRate: 0.2, l2: 1e-4, seed: 11 })
  const random = prng(42)
  const sample = (): { x: number[]; y: number } => {
    const x = Array.from({ length: 16 }, () => random())
    return { x, y: (x[0] ?? 0) > 0.5 && (x[1] ?? 0) > 0.5 ? 1 : 0 }
  }
  for (let i = 0; i < 6000; i += 1) {
    const { x, y } = sample()
    ranker.train(x, y)
  }
  let right = 0
  for (let i = 0; i < 500; i += 1) {
    const { x, y } = sample()
    if ((ranker.predict(x) >= 0.5 ? 1 : 0) === y) right += 1
  }
  expect(right / 500).toBeGreaterThan(0.9)
  expect(ranker.accuracy() ?? 0).toBeGreaterThan(0.85)

  // The heuristic decides alone until 30 samples, then the network blends in.
  const fresh = new Ranker()
  expect(blendedScore(fresh, new Array(16).fill(0.5), 0.42, 30)).toEqual({ score: 0.42, learnt: null })
  expect(blendedScore(ranker, new Array(16).fill(0.5), 0.42, 30).learnt).not.toBeNull()

  const copy = Ranker.fromFile(JSON.parse(JSON.stringify(ranker.toFile())), ranker.config)
  const probe = sample().x
  expect(copy.predict(probe)).toBe(ranker.predict(probe))
  expect(copy.samples).toBe(6000)
})
