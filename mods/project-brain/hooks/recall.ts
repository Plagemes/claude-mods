/**
 * Recall by spreading activation. Cues (the prompt's words, the files in play, recent errors) light up seed
 * nodes by feature overlap (BM25) and by identity; activation then flows 2–3 hops along weighted edges,
 * fading with each hop and normalised by fan-out, and lateral inhibition keeps only the k most active nodes
 * after every hop (k-winners-take-all). Pure: no `$`.
 */
import { featuresOf, fold } from './features'
import type { Brain, EdgeType, MemoryNode, NodeKind } from './graph'
import { KNOWLEDGE_KINDS } from './graph'

export type Cue = {
  /** The prompt (or a tool's query). */
  text: string
  /** Files in play, most recent first, with how strongly each is in play (0..1). */
  files?: readonly (readonly [string, number])[]
  /** Node ids to light directly (recent errors, memories in play), with their activation. */
  nodes?: readonly (readonly [string, number])[]
  now: number
}

export type RecallOptions = {
  /** How many lexical seeds to keep. */
  seeds: number
  /** How many hops activation spreads. */
  hops: number
  /** The fraction of activation that crosses one edge of weight 1. */
  decay: number
  /** k of k-winners-take-all: nodes left active after each hop. */
  winners: number
  /** Activation below this does not spread. */
  threshold: number
}

export const DEFAULT_RECALL: RecallOptions = { seeds: 24, hops: 3, decay: 0.6, winners: 48, threshold: 0.04 }

export type Candidate = {
  id: string
  node: MemoryNode
  activation: number
  /** Lexical match of the cue, 0..1 (the seed's normalised BM25 score). */
  seed: number
  /** Hops from the nearest seed. */
  hops: number
  /** Strongest edge weight on the path that brought the most activation in. */
  pathStrength: number
  /** The neighbour that brought the most activation in, and the edge's type. */
  via?: { id: string; type: EdgeType }
  /** Cue terms the node matched (stems, `file:`/`path:`/`sym:` features). */
  matched: string[]
}

type Working = { activation: number; seed: number; hops: number; pathStrength: number; via?: { id: string; type: EdgeType }; matched: string[]; best: number }

/** Lights the seeds: lexical (normalised BM25) and direct (files in play, given nodes). */
export function seedsOf(brain: Brain, cue: Cue, options: RecallOptions = DEFAULT_RECALL): Map<string, Working> {
  const paths = (cue.files ?? []).map(([path]) => path)
  const query = featuresOf(cue.text, { paths })
  const hits = brain.index.search(query, options.seeds)
  const top = hits[0]?.score ?? 0
  const seeds = new Map<string, Working>()
  for (const hit of hits) {
    const seed = top > 0 ? hit.score / top : 0
    seeds.set(hit.doc, { activation: seed, seed, hops: 0, pathStrength: 1, matched: hit.matched, best: 0 })
  }
  const direct = (id: string, activation: number): void => {
    if (!brain.nodes.has(id)) return
    const current = seeds.get(id)
    if (current === undefined) seeds.set(id, { activation, seed: 0, hops: 0, pathStrength: 1, matched: [], best: 0 })
    else current.activation = Math.max(current.activation, activation)
  }
  for (const [path, strength] of cue.files ?? []) {
    for (const id of brain.index.docs(`path:${fold(path)}`)?.keys() ?? []) {
      if (brain.nodes.get(id)?.kind === 'file') direct(id, strength)
    }
  }
  for (const [id, activation] of cue.nodes ?? []) direct(id, activation)
  return seeds
}

/** Fan-out normalisation: a hub's activation is shared among its many edges. */
const fan = (degree: number): number => 1 + Math.log(Math.max(1, degree))

/** Spreads activation from the seeds; returns every node left active, most active first. */
export function spread(brain: Brain, seeds: Map<string, Working>, now: number, options: RecallOptions = DEFAULT_RECALL): Map<string, Working> {
  const state = new Map<string, Working>()
  for (const [id, seed] of seeds) state.set(id, { ...seed, activation: Math.min(1, seed.activation) })
  let frontier = [...state.keys()].filter(id => (state.get(id)?.activation ?? 0) >= options.threshold)
  for (let hop = 1; hop <= options.hops && frontier.length > 0; hop += 1) {
    const incoming = new Map<string, { amount: number; best: number; via: string; type: EdgeType; w: number }>()
    for (const id of frontier) {
      const source = state.get(id)
      if (source === undefined) continue
      const share = fan(brain.degree(id))
      for (const [other, edge] of brain.adj.get(id) ?? []) {
        const w = brain.weightOf(edge, now)
        const amount = (options.decay * source.activation * w) / share
        if (amount < options.threshold / 4) continue
        const entry = incoming.get(other)
        if (entry === undefined) incoming.set(other, { amount, best: amount, via: id, type: edge.type, w })
        else {
          entry.amount += amount
          if (amount > entry.best) Object.assign(entry, { best: amount, via: id, type: edge.type, w })
        }
      }
    }
    const raised: string[] = []
    for (const [id, entry] of incoming) {
      const current = state.get(id)
      if (current === undefined) {
        state.set(id, { activation: Math.min(1, entry.amount), seed: 0, hops: hop, pathStrength: entry.w, via: { id: entry.via, type: entry.type }, matched: [], best: entry.best })
        raised.push(id)
      } else {
        const before = current.activation
        current.activation = Math.min(1, current.activation + entry.amount)
        if (entry.best > current.best && current.hops > 0) Object.assign(current, { best: entry.best, via: { id: entry.via, type: entry.type }, pathStrength: entry.w })
        if (current.activation - before >= options.threshold) raised.push(id)
      }
    }
    // Lateral inhibition: only the k most active survive the hop.
    if (state.size > options.winners) {
      const ranked = [...state].sort((a, b) => b[1].activation - a[1].activation)
      for (const [id] of ranked.slice(options.winners)) state.delete(id)
    }
    frontier = raised.filter(id => state.has(id) && (state.get(id)?.activation ?? 0) >= options.threshold)
  }
  return new Map([...state].sort((a, b) => b[1].activation - a[1].activation))
}

/** Seeds, then spreading: the ranked active set. */
export function recall(brain: Brain, cue: Cue, options: RecallOptions = DEFAULT_RECALL): Candidate[] {
  const active = spread(brain, seedsOf(brain, cue, options), cue.now, options)
  const out: Candidate[] = []
  for (const [id, working] of active) {
    const node = brain.nodes.get(id)
    if (node === undefined) continue
    out.push({
      id,
      node,
      activation: working.activation,
      seed: working.seed,
      hops: working.hops,
      pathStrength: working.pathStrength,
      ...(working.via === undefined ? {} : { via: working.via }),
      matched: working.matched,
    })
  }
  return out
}

// ── Ranker features ────────────────────────────────────────────────────────────────────────────────

export const FEATURE_COUNT = 16
const DAY = 86_400_000
const KIND_SLOT: Partial<Record<NodeKind, number>> = { decision: 10, convention: 11, lesson: 12, file: 13, symbol: 13, error: 14 }

/**
 * The 16 inputs the ranker sees for one candidate: activation, lexical match, salience, recency, freshness,
 * path strength, closeness (1/(1+hops)), past usefulness, ignored streak, connectedness, and the kind one-hot
 * (decision, convention, lesson, file/symbol, error, other).
 */
export function candidateFeatures(brain: Brain, candidate: Pick<Candidate, 'node' | 'activation' | 'seed' | 'hops' | 'pathStrength'>, now: number): number[] {
  const { node } = candidate
  const x = new Array<number>(FEATURE_COUNT).fill(0)
  x[0] = candidate.activation
  x[1] = candidate.seed
  x[2] = brain.salienceOf(node, now)
  x[3] = Math.pow(2, -Math.max(0, now - node.lastActivated) / (7 * DAY))
  x[4] = Math.pow(2, -Math.max(0, now - node.created) / (30 * DAY))
  x[5] = candidate.pathStrength
  x[6] = 1 / (1 + candidate.hops)
  x[7] = (node.uses + 1) / (node.shown + 2)
  x[8] = Math.min(1, node.ignored / 5)
  x[9] = Math.min(1, Math.log(1 + brain.degree(node.id)) / Math.log(51))
  x[KIND_SLOT[node.kind] ?? 15] = 1
  // Bounded inputs only: a NaN here would sort and score unpredictably.
  return x.map(value => (Number.isFinite(value) ? value : 0))
}

/** The hand-written score used until the ranker has learnt from enough feedback. */
export function heuristicScore(x: readonly number[]): number {
  const at = (i: number): number => x[i] ?? 0
  const kindPrior = at(10) + at(11) + at(12) > 0 ? 0.05 : 0
  const score = 0.42 * at(0) + 0.2 * at(1) + 0.12 * at(2) + 0.06 * at(3) + 0.1 * at(7) + 0.08 * at(5) * (1 - at(1)) - 0.2 * at(8) + kindPrior
  return Math.max(0, Math.min(1, score))
}

/** Whether a node may be told to Claude as a memory (not structure, not already in the system prompt). */
export const isInjectable = (node: MemoryNode): boolean => KNOWLEDGE_KINDS.has(node.kind) && !node.isInPrompt
