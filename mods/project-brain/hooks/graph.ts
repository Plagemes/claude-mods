/**
 * The memory graph: typed nodes (decisions, conventions, lessons, files, symbols, errors, terms, people, tasks,
 * notes) joined by weighted, typed edges that strengthen when their ends fire together (Hebbian) and fade
 * when unused (exponential decay, applied lazily from each edge's last reinforcement). Pure: no `$`.
 */
import { TextIndex } from './bm25'
import { featuresOf, hashKey, jaccard, normalizeKey } from './features'
import { redactText } from './shared/secrets'

export type NodeKind = 'decision' | 'convention' | 'lesson' | 'file' | 'symbol' | 'error' | 'term' | 'person' | 'task' | 'note'
export const NODE_KINDS: readonly NodeKind[] = ['decision', 'convention', 'lesson', 'file', 'symbol', 'error', 'term', 'person', 'task', 'note']
/** Kinds that carry knowledge worth telling Claude; files, symbols and errors are the associations between them. */
export const KNOWLEDGE_KINDS: ReadonlySet<NodeKind> = new Set(['decision', 'convention', 'lesson', 'term', 'person', 'task', 'note'])

export type EdgeType = 'mentions' | 'co-edited' | 'fixed-by' | 'decided-for' | 'depends-on' | 'related'
export const EDGE_TYPES: readonly EdgeType[] = ['mentions', 'co-edited', 'fixed-by', 'decided-for', 'depends-on', 'related']

export type MemoryNode = {
  id: string
  kind: NodeKind
  /** Masked, one line, at most MAX_TEXT characters. */
  text: string
  key: string
  /** Where it came from: claude-md, adr, glossary, journal, codeowners, edit, bash, transcript, model, bus, tool, user, summary. */
  source: string
  /** A file or ADR it is about. */
  ref: string | null
  salience: number
  salienceAt: number
  created: number
  updated: number
  lastActivated: number
  lastActivation: number
  /** Times it was recalled and then used, recalled (shown to Claude), and ignored in a row. */
  uses: number
  shown: number
  ignored: number
  isPinned: boolean
  /** Already in the system prompt (CLAUDE.md): never injected again. */
  isInPrompt: boolean
  features: string[]
  featureSet: Set<string>
}

export type Edge = { a: string; b: string; w: number; type: EdgeType; t: number }

export type BrainParams = {
  /** Hebbian learning rate η. */
  eta: number
  /** Upper bound of an edge's weight. */
  wMax: number
  /** An unused edge loses half its weight in this time. */
  halfLifeMs: number
  /** Salience halves in this time without reinforcement. */
  salienceHalfLifeMs: number
  maxNodes: number
  maxEdges: number
  /** Feature overlap (Jaccard) at which a new memory is the same as an existing one. */
  dupThreshold: number
  /** Overlap at which consolidation merges two memories. */
  mergeThreshold: number
  /** Edges weaker than this are pruned while consolidating. */
  pruneWeight: number
}

const MINUTE = 60_000
const DAY = 86_400_000
export const DEFAULT_PARAMS: BrainParams = {
  eta: 0.25,
  wMax: 1,
  halfLifeMs: 14 * DAY,
  salienceHalfLifeMs: 60 * DAY,
  maxNodes: 4000,
  maxEdges: 40_000,
  dupThreshold: 0.8,
  mergeThreshold: 0.6,
  pruneWeight: 0.02,
}

export const MAX_TEXT = 280
/** At most this many co-active nodes take part in one Hebbian update (pairs grow quadratically). */
const MAX_COACTIVE = 24
/** A pair whose activations multiply to less than this does not create a new edge. */
const MIN_NEW_EDGE = 0.1
const DEFAULT_SALIENCE = 0.3
const TOMBSTONE_MS = 90 * DAY
const WEAK_NODE_AGE_MS = 3 * DAY
const WEAK_SALIENCE = 0.03
const WEAK_EDGE = 0.05
const RARE_TERMS = 4

/** Who may overwrite a memory's wording: a person or Claude's tool over a model, a model over a heuristic. */
const SOURCE_RANK: Record<string, number> = { user: 5, tool: 5, summary: 4, model: 4, adr: 3, 'claude-md': 3, glossary: 3, codeowners: 3, bus: 3, journal: 2, transcript: 1, bash: 1, edit: 1 }

const PREFIX: Record<NodeKind, string> = { decision: 'd', convention: 'c', lesson: 'l', file: 'f', symbol: 's', error: 'e', term: 't', person: 'p', task: 'k', note: 'n' }

// ── Math ───────────────────────────────────────────────────────────────────────────────────────────

/** The Hebbian step, soft-bounded: Δw = η·a_i·a_j·(wMax − w), so w approaches wMax and never passes it. */
export const hebbianStep = (w: number, ai: number, aj: number, eta: number, wMax: number): number =>
  Math.min(wMax, Math.max(0, w + eta * ai * aj * (wMax - w)))

/** Exponential decay: the weight left after `elapsedMs` with half-life `halfLifeMs`. */
export const decayed = (w: number, elapsedMs: number, halfLifeMs: number): number =>
  elapsedMs <= 0 || halfLifeMs <= 0 ? w : w * Math.pow(2, -elapsedMs / halfLifeMs)

const round = (value: number, digits: number): number => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** Masks secrets and personal data, keeps one line, caps the length. */
export function cleanText(text: string, max = MAX_TEXT): string {
  const masked = redactText(text).text.replace(/\s+/g, ' ').trim()
  return masked.length > max ? `${masked.slice(0, max - 1)}…` : masked
}

const edgeTypeFor = (a: NodeKind, b: NodeKind): EdgeType => {
  const kinds = new Set([a, b])
  if (a === 'file' && b === 'file') return 'co-edited'
  if (kinds.has('error') && (kinds.has('lesson') || kinds.has('file'))) return 'fixed-by'
  if (kinds.has('decision') && (kinds.has('file') || kinds.has('symbol'))) return 'decided-for'
  if (kinds.has('symbol') || kinds.has('file')) return 'mentions'
  return 'related'
}

/** A memory's features: its text's, plus its file (`ref`) and, for a symbol, the symbol itself. */
export function nodeFeatures(kind: NodeKind, text: string, ref: string | null, paths: readonly string[] = [], symbols: readonly string[] = []): string[] {
  if (kind === 'file') return featuresOf(text, { paths: [text] })
  const extraPaths = ref !== null && /[/.]/.test(ref) && kind !== 'symbol' ? [ref, ...paths] : [...paths]
  const ownSymbol = kind === 'symbol' ? [text.split(/\s/)[0] ?? text] : []
  return featuresOf(text, { paths: extraPaths, symbols: [...ownSymbol, ...symbols] })
}

// ── Persistence shapes ─────────────────────────────────────────────────────────────────────────────

export type BrainMeta = {
  /** Imported files and the mtime they were read at. */
  imported: Record<string, number>
  /** Forgotten ids, so automatic ingestion does not bring them back. */
  tombstones: Record<string, number>
  /** Clusters already summarised, by their key. */
  summarized: Record<string, number>
  lastSleep: number
}

type NodeRow = [string, NodeKind, string, string, string, string | null, number, number, number, number, number, number, number, number, number, number]
/** Edge rows: node positions, weight, type index, and minutes between the last reinforcement and the save. */
type EdgeRow = [number, number, number, number, number]
export type BrainFile = { v: 1; rev: number; savedAt: number; meta: BrainMeta; nodes: NodeRow[]; edges: EdgeRow[] }

const FLAG_PINNED = 1
const FLAG_IN_PROMPT = 2

export type UpsertInput = {
  kind: NodeKind
  text: string
  source: string
  at: number
  key?: string
  ref?: string | null
  salience?: number
  isInPrompt?: boolean
  isPinned?: boolean
  paths?: readonly string[]
  symbols?: readonly string[]
  /** When it happened, if earlier than `at` (an ADR's date). */
  created?: number
}

export type ConsolidationReport = { merged: number; prunedEdges: number; prunedNodes: number; nodes: number; edges: number }

export type BrainStats = { nodes: number; edges: number; knowledge: number; byKind: Record<NodeKind, number>; pinned: number }

// ── The graph ──────────────────────────────────────────────────────────────────────────────────────

export class Brain {
  readonly nodes = new Map<string, MemoryNode>()
  readonly adj = new Map<string, Map<string, Edge>>()
  readonly index = new TextIndex()
  edgeCount = 0
  rev = 0
  meta: BrainMeta = { imported: {}, tombstones: {}, summarized: {}, lastSleep: 0 }

  constructor(readonly params: BrainParams = DEFAULT_PARAMS) {}

  static idFor(kind: NodeKind, key: string): string {
    return `${PREFIX[kind]}${hashKey(`${kind}|${key}`)}`
  }

  get(id: string): MemoryNode | undefined {
    return this.nodes.get(id)
  }

  /** Effective salience now (pinned memories stay at 1). */
  salienceOf(node: MemoryNode, now: number): number {
    return node.isPinned ? 1 : decayed(node.salience, now - node.salienceAt, this.params.salienceHalfLifeMs)
  }

  /** Raises salience towards 1 by `amount` of the way. */
  reinforce(node: MemoryNode, amount: number, at: number): void {
    const current = this.salienceOf(node, at)
    node.salience = Math.min(1, current + amount * (1 - current))
    node.salienceAt = at
  }

  /** Lowers salience by a factor (0..1). */
  weaken(node: MemoryNode, factor: number, at: number): void {
    node.salience = this.salienceOf(node, at) * (1 - factor)
    node.salienceAt = at
  }

  private indexNode(node: MemoryNode): void {
    this.index.add(node.id, node.features)
  }

  /** The memories most like `features` among `kind` (rare shared terms first), with their overlap. */
  similar(kind: NodeKind | undefined, features: ReadonlySet<string>, exclude?: string): { node: MemoryNode; overlap: number }[] {
    const rare = [...features].filter(term => this.index.df(term) > 0).sort((a, b) => this.index.df(a) - this.index.df(b)).slice(0, RARE_TERMS)
    const seen = new Set<string>()
    const out: { node: MemoryNode; overlap: number }[] = []
    for (const term of rare) {
      for (const id of this.index.docs(term)?.keys() ?? []) {
        if (seen.has(id) || id === exclude) continue
        seen.add(id)
        const node = this.nodes.get(id)
        if (node === undefined || (kind !== undefined && node.kind !== kind)) continue
        out.push({ node, overlap: jaccard(features, node.featureSet) })
      }
    }
    return out.sort((a, b) => b.overlap - a.overlap)
  }

  /**
   * Adds a memory, or reinforces the one it repeats (same key, or a near-duplicate of the same kind).
   * Returns undefined when the text is empty or the memory was forgotten and the source is automatic.
   */
  upsert(input: UpsertInput): { node: MemoryNode; isNew: boolean } | undefined {
    const text = cleanText(input.text)
    if (text === '') return undefined
    const key = input.key === undefined ? normalizeKey(text) : normalizeKey(input.key)
    if (key === '') return undefined
    const id = Brain.idFor(input.kind, key)
    const rank = SOURCE_RANK[input.source] ?? 1
    const isPersonal = rank >= 5
    if (this.meta.tombstones[id] !== undefined) {
      if (!isPersonal) return undefined
      delete this.meta.tombstones[id]
    }
    const ref = input.ref === undefined || input.ref === null ? null : cleanText(input.ref, 200)
    const existing = this.nodes.get(id)
    if (existing !== undefined) return { node: this.refresh(existing, input, text, ref, rank), isNew: false }
    const features = nodeFeatures(input.kind, text, ref, input.paths, input.symbols)
    const featureSet = new Set(features)
    if (KNOWLEDGE_KINDS.has(input.kind)) {
      const twin = this.similar(input.kind, featureSet)[0]
      if (twin !== undefined && twin.overlap >= this.params.dupThreshold) return { node: this.refresh(twin.node, input, text, ref, rank), isNew: false }
    }
    const node: MemoryNode = {
      id,
      kind: input.kind,
      text,
      key,
      source: input.source,
      ref,
      salience: input.salience ?? DEFAULT_SALIENCE,
      salienceAt: input.at,
      created: Math.min(input.at, input.created ?? input.at),
      updated: input.at,
      lastActivated: input.at,
      lastActivation: 0,
      uses: 0,
      shown: 0,
      ignored: 0,
      isPinned: input.isPinned === true,
      isInPrompt: input.isInPrompt === true,
      features,
      featureSet,
    }
    this.nodes.set(id, node)
    this.indexNode(node)
    return { node, isNew: true }
  }

  private refresh(node: MemoryNode, input: UpsertInput, text: string, ref: string | null, rank: number): MemoryNode {
    this.reinforce(node, 0.15, input.at)
    if (input.salience !== undefined && input.salience > node.salience) node.salience = input.salience
    node.updated = input.at
    node.isInPrompt ||= input.isInPrompt === true
    node.isPinned ||= input.isPinned === true
    if (rank > (SOURCE_RANK[node.source] ?? 1) && text !== node.text && node.kind !== 'file') {
      this.setText(node, text)
      node.source = input.source
    }
    if (node.ref === null && ref !== null) node.ref = ref
    return node
  }

  private setText(node: MemoryNode, text: string): void {
    this.index.removeKnown(node.id, node.featureSet)
    node.text = text
    node.features = nodeFeatures(node.kind, text, node.ref)
    node.featureSet = new Set(node.features)
    this.indexNode(node)
  }

  /** A person's edit of a memory's text (masked like everything stored). */
  edit(id: string, text: string, at: number): boolean {
    const node = this.nodes.get(id)
    const clean = cleanText(text)
    if (node === undefined || clean === '') return false
    this.setText(node, clean)
    node.source = 'user'
    node.updated = at
    return true
  }

  // ── Edges ──

  edge(a: string, b: string): Edge | undefined {
    return this.adj.get(a)?.get(b)
  }

  /** The edge's weight now, decay applied. */
  weightOf(edge: Edge, now: number): number {
    return decayed(edge.w, now - edge.t, this.params.halfLifeMs)
  }

  /** Creates an edge with weight `w`, or raises an existing one to at least `w`. */
  link(a: string, b: string, type: EdgeType, w: number, at: number): Edge | undefined {
    if (a === b || !this.nodes.has(a) || !this.nodes.has(b)) return undefined
    const existing = this.edge(a, b)
    if (existing !== undefined) {
      existing.w = Math.min(this.params.wMax, Math.max(this.weightOf(existing, at), w))
      existing.t = at
      return existing
    }
    const edge: Edge = { a, b, w: Math.min(this.params.wMax, w), type, t: at }
    this.attach(edge)
    return edge
  }

  private attach(edge: Edge): void {
    for (const [from, to] of [
      [edge.a, edge.b],
      [edge.b, edge.a],
    ] as const) {
      let list = this.adj.get(from)
      if (list === undefined) {
        list = new Map()
        this.adj.set(from, list)
      }
      list.set(to, edge)
    }
    this.edgeCount += 1
  }

  unlink(a: string, b: string): void {
    if (this.adj.get(a)?.delete(b) === true) {
      this.adj.get(b)?.delete(a)
      this.edgeCount -= 1
    }
  }

  degree(id: string): number {
    return this.adj.get(id)?.size ?? 0
  }

  /** Neighbours by current weight, strongest first. */
  neighbours(id: string, now: number, limit = Number.POSITIVE_INFINITY): { node: MemoryNode; edge: Edge; w: number }[] {
    const out: { node: MemoryNode; edge: Edge; w: number }[] = []
    for (const [other, edge] of this.adj.get(id) ?? []) {
      const node = this.nodes.get(other)
      if (node !== undefined) out.push({ node, edge, w: this.weightOf(edge, now) })
    }
    out.sort((a, b) => b.w - a.w)
    return Number.isFinite(limit) ? out.slice(0, limit) : out
  }

  /**
   * Hebbian learning over nodes that fired together: every pair's edge moves by Δw = η·a_i·a_j·(wMax − w)
   * from its decayed weight; a pair with no edge gets one when a_i·a_j is large enough. Returns the pairs updated.
   */
  hebbian(active: readonly (readonly [string, number])[], at: number): number {
    const strongest = new Map<string, number>()
    for (const [id, a] of active) if (a > 0 && this.nodes.has(id)) strongest.set(id, Math.max(a, strongest.get(id) ?? 0))
    const firing = [...strongest].sort((x, y) => y[1] - x[1]).slice(0, MAX_COACTIVE)
    let updated = 0
    for (let i = 0; i < firing.length; i += 1) {
      const [idA, ai] = firing[i] as [string, number]
      const nodeA = this.nodes.get(idA) as MemoryNode
      nodeA.lastActivated = at
      nodeA.lastActivation = Math.max(nodeA.lastActivation * 0.5, ai)
      for (let j = i + 1; j < firing.length; j += 1) {
        const [idB, aj] = firing[j] as [string, number]
        const existing = this.edge(idA, idB)
        if (existing === undefined) {
          if (ai * aj < MIN_NEW_EDGE) continue
          const nodeB = this.nodes.get(idB) as MemoryNode
          this.attach({ a: idA, b: idB, w: hebbianStep(0, ai, aj, this.params.eta, this.params.wMax), type: edgeTypeFor(nodeA.kind, nodeB.kind), t: at })
        } else {
          existing.w = hebbianStep(this.weightOf(existing, at), ai, aj, this.params.eta, this.params.wMax)
          existing.t = at
        }
        updated += 1
      }
    }
    return updated
  }

  // ── Removal ──

  remove(id: string): void {
    const node = this.nodes.get(id)
    if (node === undefined) return
    for (const other of [...(this.adj.get(id)?.keys() ?? [])]) this.unlink(id, other)
    this.adj.delete(id)
    this.index.removeKnown(id, node.featureSet)
    this.nodes.delete(id)
  }

  /** Removes a memory and remembers that it was forgotten. */
  forget(id: string, at: number): boolean {
    if (!this.nodes.has(id)) return false
    this.remove(id)
    this.meta.tombstones[id] = at
    return true
  }

  /** Folds `gone` into `keep`: edges (strongest wins), counters, flags; the wording of the better source (then the more salient). */
  merge(keep: MemoryNode, gone: MemoryNode, at: number): void {
    for (const [other, edge] of [...(this.adj.get(gone.id) ?? [])]) {
      if (other === keep.id) continue
      const w = this.weightOf(edge, at)
      this.link(keep.id, other, edge.type, w, at)
    }
    const goneRank = SOURCE_RANK[gone.source] ?? 1
    const keepRank = SOURCE_RANK[keep.source] ?? 1
    if (goneRank > keepRank || (goneRank === keepRank && this.salienceOf(gone, at) > this.salienceOf(keep, at))) {
      this.setText(keep, gone.text)
      keep.source = gone.source
    }
    keep.salience = Math.max(this.salienceOf(keep, at), this.salienceOf(gone, at))
    keep.salienceAt = at
    keep.uses += gone.uses
    keep.shown += gone.shown
    keep.ignored = Math.min(keep.ignored, gone.ignored)
    keep.isPinned ||= gone.isPinned
    keep.isInPrompt ||= gone.isInPrompt
    keep.created = Math.min(keep.created, gone.created)
    keep.updated = Math.max(keep.updated, gone.updated)
    keep.lastActivated = Math.max(keep.lastActivated, gone.lastActivated)
    if (keep.ref === null) keep.ref = gone.ref
    this.remove(gone.id)
  }

  // ── Sleep ──

  /** Merges near-duplicates, prunes weak edges and nodes, and keeps the store under its caps. */
  consolidate(now: number): ConsolidationReport {
    let prunedEdges = 0
    for (const [id, list] of this.adj) {
      for (const [other, edge] of [...list]) {
        if (id < other && this.weightOf(edge, now) < this.params.pruneWeight) {
          this.unlink(id, other)
          prunedEdges += 1
        }
      }
    }

    let merged = 0
    const ordered = [...this.nodes.values()].filter(node => KNOWLEDGE_KINDS.has(node.kind)).sort((a, b) => a.created - b.created)
    for (const node of ordered) {
      if (!this.nodes.has(node.id)) continue
      for (const { node: twin, overlap } of this.similar(node.kind, node.featureSet, node.id)) {
        if (overlap < this.params.mergeThreshold) break
        if (!this.nodes.has(twin.id)) continue
        this.merge(node, twin, now)
        merged += 1
      }
    }

    let prunedNodes = 0
    for (const node of [...this.nodes.values()]) {
      if (node.isPinned || node.isInPrompt || now - node.updated < WEAK_NODE_AGE_MS) continue
      const strongest = this.neighbours(node.id, now, 1)[0]?.w ?? 0
      if (this.salienceOf(node, now) < WEAK_SALIENCE && strongest < WEAK_EDGE) {
        this.remove(node.id)
        prunedNodes += 1
      }
    }

    if (this.nodes.size > this.params.maxNodes) {
      const value = (node: MemoryNode): number =>
        node.isPinned || node.isInPrompt
          ? Number.POSITIVE_INFINITY
          : this.salienceOf(node, now) + 0.5 * (this.neighbours(node.id, now, 1)[0]?.w ?? 0) + 0.3 * decayed(1, now - node.lastActivated, 30 * DAY)
      const ranked = [...this.nodes.values()].map(node => ({ node, value: value(node) })).sort((a, b) => a.value - b.value)
      for (const { node } of ranked.slice(0, this.nodes.size - this.params.maxNodes)) {
        this.remove(node.id)
        prunedNodes += 1
      }
    }

    if (this.edgeCount > this.params.maxEdges) {
      const all: { a: string; b: string; w: number }[] = []
      for (const [id, list] of this.adj) for (const [other, edge] of list) if (id < other) all.push({ a: id, b: other, w: this.weightOf(edge, now) })
      all.sort((x, y) => x.w - y.w)
      for (const edge of all.slice(0, this.edgeCount - this.params.maxEdges)) {
        this.unlink(edge.a, edge.b)
        prunedEdges += 1
      }
    }

    for (const [id, at] of Object.entries(this.meta.tombstones)) if (now - at > TOMBSTONE_MS) delete this.meta.tombstones[id]
    this.meta.lastSleep = now
    return { merged, prunedEdges, prunedNodes, nodes: this.nodes.size, edges: this.edgeCount }
  }

  /**
   * Groups of at least `minSize` knowledge memories bound together (directly, or through a shared file or
   * symbol) by edges of at least `minWeight`, not summarised yet: what consolidation may summarise.
   */
  clusters(now: number, minSize = 4, minWeight = 0.35): { key: string; members: MemoryNode[] }[] {
    const parent = new Map<string, string>()
    const find = (id: string): string => {
      let root = id
      while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root) as string
      parent.set(id, root)
      return root
    }
    const join = (a: string, b: string): void => {
      parent.set(find(a), find(b))
    }
    const knowledge = [...this.nodes.values()].filter(node => KNOWLEDGE_KINDS.has(node.kind) && node.source !== 'summary')
    for (const node of knowledge) parent.set(node.id, node.id)
    for (const node of knowledge) {
      for (const { node: other, w } of this.neighbours(node.id, now)) {
        if (w < minWeight) break
        if (parent.has(other.id)) join(node.id, other.id)
        else if (!KNOWLEDGE_KINDS.has(other.kind)) {
          for (const { node: far, w: farW } of this.neighbours(other.id, now, 12)) {
            if (farW >= minWeight && parent.has(far.id)) join(node.id, far.id)
          }
        }
      }
    }
    const groups = new Map<string, MemoryNode[]>()
    for (const node of knowledge) groups.set(find(node.id), [...(groups.get(find(node.id)) ?? []), node])
    const out: { key: string; members: MemoryNode[] }[] = []
    for (const members of groups.values()) {
      if (members.length < minSize) continue
      const key = hashKey(members.map(node => node.id).sort().join(','))
      if (this.meta.summarized[key] === undefined) out.push({ key, members })
    }
    return out.sort((a, b) => b.members.length - a.members.length)
  }

  stats(): BrainStats {
    const byKind = Object.fromEntries(NODE_KINDS.map(kind => [kind, 0])) as Record<NodeKind, number>
    let pinned = 0
    for (const node of this.nodes.values()) {
      byKind[node.kind] += 1
      if (node.isPinned) pinned += 1
    }
    const knowledge = NODE_KINDS.filter(kind => KNOWLEDGE_KINDS.has(kind)).reduce((sum, kind) => sum + byKind[kind], 0)
    return { nodes: this.nodes.size, edges: this.edgeCount, knowledge, byKind, pinned }
  }

  // ── Persistence ──

  toFile(savedAt: number): BrainFile {
    const ids = [...this.nodes.keys()]
    const position = new Map(ids.map((id, i) => [id, i]))
    const nodes: NodeRow[] = [...this.nodes.values()].map(node => [
      node.id,
      node.kind,
      node.text,
      node.key,
      node.source,
      node.ref,
      round(node.salience, 4),
      node.salienceAt,
      node.created,
      node.updated,
      node.lastActivated,
      round(node.lastActivation, 3),
      node.uses,
      node.shown,
      node.ignored,
      (node.isPinned ? FLAG_PINNED : 0) | (node.isInPrompt ? FLAG_IN_PROMPT : 0),
    ])
    const edges: EdgeRow[] = []
    for (const [id, list] of this.adj) {
      for (const [other, edge] of list) {
        if (id >= other) continue
        edges.push([position.get(id) as number, position.get(other) as number, round(edge.w, 4), EDGE_TYPES.indexOf(edge.type), Math.max(0, Math.round((savedAt - edge.t) / MINUTE))])
      }
    }
    return { v: 1, rev: this.rev, savedAt, meta: this.meta, nodes, edges }
  }

  /** Adds the nodes and edges of a file this brain lacks (another session's save); tombstones on either side win. */
  absorb(file: BrainFile): number {
    let added = 0
    const tombstones = { ...file.meta.tombstones, ...this.meta.tombstones }
    this.meta.tombstones = tombstones
    for (const id of Object.keys(tombstones)) if (this.nodes.has(id)) this.remove(id)
    const ids: string[] = []
    for (const row of file.nodes) {
      const node = nodeFromRow(row)
      ids.push(node?.id ?? '')
      if (node === undefined || this.nodes.has(node.id) || tombstones[node.id] !== undefined) continue
      this.nodes.set(node.id, node)
      this.indexNode(node)
      added += 1
    }
    for (const [ai, bi, w, type, minutesAgo] of file.edges) {
      const a = ids[ai]
      const b = ids[bi]
      if (a === undefined || b === undefined || a === '' || b === '' || !this.nodes.has(a) || !this.nodes.has(b) || this.edge(a, b) !== undefined) continue
      this.attach({ a, b, w, type: EDGE_TYPES[type] ?? 'related', t: file.savedAt - minutesAgo * MINUTE })
    }
    this.meta.imported = { ...file.meta.imported, ...this.meta.imported }
    this.meta.summarized = { ...file.meta.summarized, ...this.meta.summarized }
    this.meta.lastSleep = Math.max(this.meta.lastSleep, file.meta.lastSleep)
    this.rev = Math.max(this.rev, file.rev)
    return added
  }

  static fromFile(file: unknown, params: BrainParams = DEFAULT_PARAMS): Brain {
    const brain = new Brain(params)
    if (!isBrainFile(file)) return brain
    brain.meta = {
      imported: { ...(file.meta.imported ?? {}) },
      tombstones: { ...(file.meta.tombstones ?? {}) },
      summarized: { ...(file.meta.summarized ?? {}) },
      lastSleep: Number(file.meta.lastSleep) || 0,
    }
    brain.absorb({ ...file, meta: brain.meta })
    brain.rev = file.rev
    return brain
  }
}

function nodeFromRow(row: NodeRow): MemoryNode | undefined {
  const [id, kind, text, key, source, ref, salience, salienceAt, created, updated, lastActivated, lastActivation, uses, shown, ignored, flags] = row
  if (typeof id !== 'string' || !NODE_KINDS.includes(kind) || typeof text !== 'string') return undefined
  const node: MemoryNode = {
    id,
    kind,
    text,
    key: String(key),
    source: String(source),
    ref: typeof ref === 'string' ? ref : null,
    salience: Number(salience) || 0,
    salienceAt: Number(salienceAt) || 0,
    created: Number(created) || 0,
    updated: Number(updated) || 0,
    lastActivated: Number(lastActivated) || 0,
    lastActivation: Number(lastActivation) || 0,
    uses: Number(uses) || 0,
    shown: Number(shown) || 0,
    ignored: Number(ignored) || 0,
    isPinned: (flags & FLAG_PINNED) !== 0,
    isInPrompt: (flags & FLAG_IN_PROMPT) !== 0,
    features: [],
    featureSet: new Set(),
  }
  node.features = nodeFeatures(kind, text, node.ref)
  node.featureSet = new Set(node.features)
  return node
}

export function isBrainFile(value: unknown): value is BrainFile {
  if (typeof value !== 'object' || value === null) return false
  const file = value as Partial<BrainFile>
  return file.v === 1 && typeof file.savedAt === 'number' && Array.isArray(file.nodes) && Array.isArray(file.edges) && typeof file.meta === 'object' && file.meta !== null
}
