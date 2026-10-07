/**
 * The brain at work, without I/O: what one edit, one command, one finished turn, one bus event or one
 * knowledge file does to the graph; recall for a prompt with the ranker's scores; and learning from whether
 * Claude used what it was told. register.tsx feeds it from hooks and persists the result. Pure: no `$`.
 */
import { normalizeKey } from './features'
import { Brain, type EdgeType, type MemoryNode, type NodeKind } from './graph'
import {
  type Evidence,
  type Extracted,
  commandKey,
  declaredSymbols,
  errorLine,
  errorSignature,
  heuristicExtract,
  ownerPatternMatches,
  parseAdr,
  parseClaudeMd,
  parseCodeowners,
  parseGlossary,
  parseJournal,
  relativeImports,
  wasUsed,
} from './ingest'
import { type InjectionLog, type Recalled, composeNote, mayInject } from './inject'
import { type Ranker, blendedScore } from './ranker'
import { type Candidate, type Cue, DEFAULT_RECALL, type RecallOptions, candidateFeatures, heuristicScore, isInjectable, recall } from './recall'

export type MindConfig = {
  tokenBudget: number
  /** Score a memory needs to be injected. */
  minScore: number
  /** Feedback samples before the ranker's network takes part. */
  minSamples: number
  /** At most this many memories per note. */
  maxInjected: number
  recall: RecallOptions
}
export const DEFAULT_MIND: MindConfig = { tokenBudget: 600, minScore: 0.3, minSamples: 30, maxInjected: 8, recall: DEFAULT_RECALL }

export type Pending = { id: string; x: number[]; turn: number; activation: number }

export type ActiveItem = { id: string; kind: NodeKind; text: string; activation: number; score: number }

/** Working memory of one conversation (reset by /clear). */
export type Session = {
  turn: number
  injected: InjectionLog
  pending: Pending[]
  /** This turn: files edited (activation), symbols written (→ file), other nodes that fired. */
  turnFiles: Map<string, number>
  turnSymbols: Map<string, string>
  turnNodes: Map<string, number>
  /** File → the turn it was last read or edited. */
  filesInPlay: Map<string, number>
  /** Error node → when it last fired. */
  recentErrors: Map<string, number>
  /** Commands failing now, by command key: the error and the files edited since. */
  failing: Map<string, { errorId: string; line: string; files: Set<string> }>
  lastActive: ActiveItem[]
  /** Features of the last recall's candidates, for feedback a person gives in the panel. */
  lastX: Map<string, number[]>
}

export const newSession = (): Session => ({
  turn: 0,
  injected: new Map(),
  pending: [],
  turnFiles: new Map(),
  turnSymbols: new Map(),
  turnNodes: new Map(),
  filesInPlay: new Map(),
  recentErrors: new Map(),
  failing: new Map(),
  lastActive: [],
  lastX: new Map(),
})

const ERROR_RECENT_MS = 15 * 60_000
const MAX_FILES_IN_PLAY = 8
const SEEN_ACTIVE = 8

// ── Ingestion ──────────────────────────────────────────────────────────────────────────────────────

const fileId = (path: string): string => Brain.idFor('file', normalizeKey(path))

/** The file node for a path (created when new; linked to its CODEOWNERS owners). */
export function fileNode(brain: Brain, path: string, source: string, at: number): MemoryNode | undefined {
  const made = brain.upsert({ kind: 'file', text: path, key: path, source, at, salience: 0.2 })
  if (made?.isNew === true) {
    for (const owner of brain.nodes.values()) {
      if (owner.kind === 'person' && owner.ref !== null && ownerPatternMatches(owner.ref, path)) brain.link(owner.id, made.node.id, 'mentions', 0.5, at)
    }
  }
  return made?.node
}

/** Adds extracted memories, linked to the files they name (and to `files` given), and returns them. */
export function addExtracted(brain: Brain, items: readonly Extracted[], options: { source: string; at: number; salience: number; files?: readonly string[]; isInPrompt?: boolean }): MemoryNode[] {
  const out: MemoryNode[] = []
  for (const item of items) {
    const created = item.date === undefined ? undefined : Date.parse(`${item.date}T12:00:00Z`)
    const made = brain.upsert({
      kind: item.kind,
      text: item.text,
      source: options.source,
      at: options.at,
      salience: options.salience,
      ...(item.key === undefined ? {} : { key: item.key }),
      ...(item.ref === undefined ? {} : { ref: item.ref }),
      ...(options.isInPrompt === true ? { isInPrompt: true } : {}),
      ...(created !== undefined && Number.isFinite(created) ? { created } : {}),
      ...(item.files === undefined ? {} : { paths: item.files }),
    })
    if (made === undefined) continue
    const type: EdgeType = item.kind === 'decision' ? 'decided-for' : item.kind === 'lesson' ? 'fixed-by' : 'mentions'
    for (const path of new Set([...(item.files ?? []), ...(options.files ?? [])])) {
      const file = fileNode(brain, path, options.source, options.at)
      if (file !== undefined) brain.link(made.node.id, file.id, type, (item.files ?? []).includes(path) ? 0.6 : 0.4, options.at)
    }
    out.push(made.node)
  }
  return out
}

/** An edit: the file, the symbols it declares, the modules it imports; all of it active this turn. */
export function ingestEdit(brain: Brain, session: Session, edit: { path: string; code: string; at: number }): string[] {
  const file = fileNode(brain, edit.path, 'edit', edit.at)
  if (file === undefined) return []
  const ids = [file.id]
  session.turnFiles.set(edit.path, 1)
  session.filesInPlay.set(edit.path, session.turn)
  for (const failing of session.failing.values()) failing.files.add(edit.path)
  for (const name of declaredSymbols(edit.code)) {
    const symbol = brain.upsert({ kind: 'symbol', text: name, key: name, ref: edit.path, source: 'edit', at: edit.at, salience: 0.15 })
    if (symbol === undefined) continue
    brain.link(symbol.node.id, file.id, 'mentions', 0.5, edit.at)
    session.turnSymbols.set(name, edit.path)
    ids.push(symbol.node.id)
  }
  for (const target of relativeImports(edit.path, edit.code)) {
    for (const suffix of ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '/index.ts', '/index.js']) {
      const id = fileId(`${target}${suffix}`)
      if (brain.nodes.has(id)) {
        brain.link(file.id, id, 'depends-on', 0.4, edit.at)
        break
      }
    }
  }
  return ids
}

export type CommandOutcome = { kind: 'none' } | { kind: 'failed'; errorId: string } | { kind: 'fixed'; errorId: string; lessonId: string; fix: string }

/** A build or test command: a failure becomes an error node; the same command passing after edits, a fix. */
export function ingestCommand(brain: Brain, session: Session, run: { command: string; output: string; hasFailed: boolean; at: number }): CommandOutcome {
  const key = commandKey(run.command)
  if (key === '') return { kind: 'none' }
  if (run.hasFailed) {
    const line = errorLine(run.output) ?? `${key} failed`
    const error = brain.upsert({ kind: 'error', text: `${key}: ${line}`, key: `${key}|${errorSignature(line)}`, source: 'bash', at: run.at, salience: 0.3 })
    if (error === undefined) return { kind: 'none' }
    session.recentErrors.set(error.node.id, run.at)
    session.turnNodes.set(error.node.id, 0.8)
    const earlier = session.failing.get(key)
    session.failing.set(key, { errorId: error.node.id, line, files: earlier?.files ?? new Set() })
    return { kind: 'failed', errorId: error.node.id }
  }
  const failing = session.failing.get(key)
  if (failing === undefined) return { kind: 'none' }
  session.failing.delete(key)
  const files = [...failing.files]
  if (files.length === 0) return { kind: 'none' }
  const shown = files.slice(0, 4).join(', ')
  const lesson = brain.upsert({
    kind: 'lesson',
    text: `Fix for "${failing.line}" (${key}): changed ${shown}`,
    key: `fix|${errorSignature(failing.line)}`,
    source: 'bash',
    at: run.at,
    salience: 0.45,
    paths: files,
  })
  if (lesson === undefined) return { kind: 'none' }
  brain.link(failing.errorId, lesson.node.id, 'fixed-by', 0.6, run.at)
  for (const path of files) {
    const file = fileNode(brain, path, 'bash', run.at)
    if (file === undefined) continue
    brain.link(lesson.node.id, file.id, 'mentions', 0.5, run.at)
    brain.link(failing.errorId, file.id, 'fixed-by', 0.4, run.at)
  }
  session.turnNodes.set(lesson.node.id, 0.8)
  session.recentErrors.delete(failing.errorId)
  return { kind: 'fixed', errorId: failing.errorId, lessonId: lesson.node.id, fix: `\`${key}\` failed with "${failing.line}" and passed after editing ${shown}` }
}

export type KnowledgeFile = 'claude-md' | 'adr' | 'glossary' | 'journal' | 'codeowners'

/** One existing knowledge file; returns how many memories it gave. */
export function importKnowledge(brain: Brain, kind: KnowledgeFile, path: string, text: string, at: number): number {
  switch (kind) {
    case 'claude-md': {
      const current = new Set(addExtracted(brain, parseClaudeMd(text).map(item => ({ ...item, ref: path })), { source: 'claude-md', at, salience: 0.5, isInPrompt: true }).map(node => node.id))
      // A rule taken out of CLAUDE.md is no longer in the system prompt: it may be recalled again.
      for (const node of brain.nodes.values()) if (node.isInPrompt && node.ref === path && !current.has(node.id)) node.isInPrompt = false
      return current.size
    }
    case 'adr': {
      const adr = parseAdr(path, text)
      return adr === undefined ? 0 : addExtracted(brain, [adr], { source: 'adr', at, salience: 0.6 }).length
    }
    case 'glossary':
      return addExtracted(brain, parseGlossary(text), { source: 'glossary', at, salience: 0.4 }).length
    case 'journal':
      return addExtracted(brain, parseJournal(text), { source: 'journal', at, salience: 0.35 }).length
    case 'codeowners': {
      const people = addExtracted(brain, parseCodeowners(text), { source: 'codeowners', at, salience: 0.3 })
      for (const person of people) {
        for (const file of brain.nodes.values()) {
          if (file.kind === 'file' && person.ref !== null && ownerPatternMatches(person.ref, file.text)) brain.link(person.id, file.id, 'mentions', 0.5, at)
        }
      }
      return people.length
    }
  }
}

export type BusEvent = { topic: string; data: unknown; source: string; at: number }

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined)

/** A standard event from the hub's bus; returns the nodes it touched. */
export function ingestBusEvent(brain: Brain, session: Session, event: BusEvent): string[] {
  const data = (event.data ?? {}) as Record<string, unknown>
  const at = event.at
  switch (event.topic) {
    case 'decision.recorded': {
      const title = str(data.title)
      if (title === undefined) return []
      const path = str(data.path)
      const summary = str(data.summary)
      const items: Extracted[] = [{ kind: 'decision', text: summary === undefined ? title : `${title}: ${summary}`, ...(path === undefined ? {} : { ref: path, key: `adr:${path}` }) }]
      return addExtracted(brain, items, { source: 'bus', at, salience: 0.55 }).map(node => node.id)
    }
    case 'lesson.learned': {
      const lesson = str(data.lesson)
      if (lesson === undefined) return []
      const path = str(data.path)
      return addExtracted(brain, [{ kind: 'lesson', text: lesson, ...(path === undefined ? {} : { files: [path] }) }], { source: 'bus', at, salience: 0.55 }).map(node => node.id)
    }
    case 'error.repeated': {
      const signature = str(data.signature)
      if (signature === undefined) return []
      const where = str(data.command) ?? str(data.tool) ?? 'command'
      const made = brain.upsert({ kind: 'error', text: `${where.slice(0, 60)}: ${signature} (×${Number(data.count) || 3})`, key: `bus|${signature}`, source: 'bus', at, salience: 0.4 })
      if (made === undefined) return []
      session.recentErrors.set(made.node.id, at)
      session.turnNodes.set(made.node.id, 0.8)
      return [made.node.id]
    }
    case 'test.result': {
      if (event.source === 'mods-hub' || data.outcome !== 'failed' || !Array.isArray(data.failures)) return []
      const runner = str(data.runner) ?? 'tests'
      const ids: string[] = []
      for (const failure of data.failures.slice(0, 3)) {
        const name = str(failure)
        if (name === undefined) continue
        const made = brain.upsert({ kind: 'error', text: `${runner} failed: ${name}`, key: `test|${runner}|${name}`, source: 'bus', at, salience: 0.3 })
        if (made === undefined) continue
        session.recentErrors.set(made.node.id, at)
        ids.push(made.node.id)
      }
      return ids
    }
    case 'git.commit': {
      const message = str(data.message)
      return message === undefined ? [] : addExtracted(brain, heuristicExtract(message), { source: 'bus', at, salience: 0.35 }).map(node => node.id)
    }
    default:
      return []
  }
}

// ── Recall ─────────────────────────────────────────────────────────────────────────────────────────

export type Ranked = Candidate & { x: number[]; heuristic: number; learnt: number | null; score: number }

/** The cue for this moment: the text, the files in play (recent first), the errors still fresh. */
export function cueFor(session: Session, text: string, at: number): Cue {
  const files = [...session.filesInPlay]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_FILES_IN_PLAY)
    .map(([path, turn]) => [path, Math.max(0.3, 1 - 0.25 * (session.turn - turn))] as const)
  const nodes = [...session.recentErrors].filter(([, when]) => at - when < ERROR_RECENT_MS).map(([id]) => [id, 0.8] as const)
  return { text, files, nodes, now: at }
}

/** Spreading activation, then the ranker's score for each candidate, best first. */
export function rankFor(brain: Brain, ranker: Ranker, cue: Cue, config: MindConfig = DEFAULT_MIND): Ranked[] {
  const ranked = recall(brain, cue, config.recall).map(candidate => {
    const x = candidateFeatures(brain, candidate, cue.now)
    const heuristic = heuristicScore(x)
    const { score, learnt } = blendedScore(ranker, x, heuristic, config.minSamples)
    return { ...candidate, x, heuristic, learnt, score }
  })
  return ranked.sort((a, b) => b.score - a.score)
}

const recalledOf = (brain: Brain, item: Ranked): Recalled => {
  const via = item.via === undefined ? undefined : brain.nodes.get(item.via.id)
  return {
    id: item.id,
    node: item.node,
    score: item.score,
    activation: item.activation,
    matched: item.matched,
    ...(item.via === undefined || via === undefined ? {} : { via: { text: via.kind === 'file' ? via.text : via.text.slice(0, 60), type: item.via.type } }),
  }
}

/** Marks what fired: the winners' last activation, and the active list the panel shows. */
function noteActivity(session: Session, ranked: readonly Ranked[], at: number): void {
  for (const item of ranked.slice(0, 16)) {
    item.node.lastActivated = at
    item.node.lastActivation = item.activation
  }
  session.lastActive = [...ranked]
    .sort((a, b) => b.activation - a.activation)
    .slice(0, SEEN_ACTIVE)
    .map(item => ({ id: item.id, kind: item.node.kind, text: item.node.text, activation: item.activation, score: item.score }))
  session.lastX = new Map(ranked.slice(0, 32).map(item => [item.id, item.x]))
}

export type Injection = { note: string; ids: string[]; ranked: Ranked[] }

/**
 * The memories to tell Claude for a prompt: injectable (knowledge, not already in CLAUDE.md), scored above
 * `minScore`, not told yet in this conversation (unless reactivated strongly), within the token budget.
 */
export function prepareInjection(brain: Brain, ranker: Ranker, session: Session, prompt: string, at: number, config: MindConfig = DEFAULT_MIND): Injection {
  const ranked = rankFor(brain, ranker, cueFor(session, prompt, at), config)
  noteActivity(session, ranked, at)
  const chosen = ranked
    .filter(item => isInjectable(item.node) && item.score >= config.minScore && mayInject(session.injected, item.id, item.activation, session.turn))
    .slice(0, config.maxInjected)
  const { text, ids } = composeNote(chosen.map(item => recalledOf(brain, item)), config.tokenBudget)
  for (const id of ids) {
    const item = chosen.find(one => one.id === id) as Ranked
    session.injected.set(id, { turn: session.turn, activation: item.activation })
    session.pending.push({ id, x: item.x, turn: session.turn, activation: item.activation })
    item.node.shown += 1
  }
  return { note: text, ids, ranked }
}

/** Recall for Claude's own query (brain_recall): any injectable memory, best first, counted for feedback. */
export function recallForTool(brain: Brain, ranker: Ranker, session: Session, query: string, limit: number, at: number, config: MindConfig = DEFAULT_MIND): Recalled[] {
  const ranked = rankFor(brain, ranker, cueFor(session, query, at), config)
  noteActivity(session, ranked, at)
  const chosen = ranked.filter(item => KNOWLEDGE(item.node)).slice(0, limit)
  for (const item of chosen) {
    if (!session.pending.some(pending => pending.id === item.id)) session.pending.push({ id: item.id, x: item.x, turn: session.turn, activation: item.activation })
    item.node.shown += 1
  }
  return chosen.map(item => recalledOf(brain, item))
}

const KNOWLEDGE = (node: MemoryNode): boolean => isInjectable(node) || (node.isInPrompt && node.kind !== 'file')

// ── Learning at the end of a turn ──────────────────────────────────────────────────────────────────

export type TurnReport = { used: string[]; ignored: string[]; trained: number; extracted: string[]; hebbianPairs: number }

/** What one turn left behind: the memories told and awaiting judgement, and what fired. */
export type TurnState = { turn: number; pending: Pending[]; files: Map<string, number>; symbols: Map<string, string>; nodes: Map<string, number> }

/** Takes the finished turn out of the session at once, so a prompt typed meanwhile starts clean. */
export function takeTurn(session: Session): TurnState {
  const state: TurnState = { turn: session.turn, pending: session.pending, files: session.turnFiles, symbols: session.turnSymbols, nodes: session.turnNodes }
  session.pending = []
  session.turnFiles = new Map()
  session.turnSymbols = new Map()
  session.turnNodes = new Map()
  return state
}

/**
 * The turn is over: each memory Claude was told is judged used (its answer or edits reference it) or ignored;
 * the ranker learns from that (an ignore counts once it repeats), salience follows, the turn's statements of
 * decisions/conventions/lessons become memories, and everything that fired together is wired together.
 */
export function finishTurn(brain: Brain, ranker: Ranker, state: TurnState, turn: { prompt: string; answer: string; at: number }): TurnReport {
  const at = turn.at
  const evidence: Evidence = { text: turn.answer, files: new Set(state.files.keys()), symbols: new Set(state.symbols.keys()) }
  const idf = (term: string): number => brain.index.idf(term)
  const coactive: [string, number][] = [
    ...[...state.files].map(([path, activation]) => [fileId(path), activation] as [string, number]),
    ...[...state.symbols.keys()].map(name => [Brain.idFor('symbol', normalizeKey(name)), 0.6] as [string, number]),
    ...state.nodes,
  ]
  const report: TurnReport = { used: [], ignored: [], trained: 0, extracted: [], hebbianPairs: 0 }

  for (const pending of state.pending) {
    const node = brain.nodes.get(pending.id)
    if (node === undefined) continue
    if (wasUsed(node, evidence, idf)) {
      node.uses += 1
      node.ignored = 0
      brain.reinforce(node, 0.25, at)
      ranker.train(pending.x, 1)
      report.trained += 1
      report.used.push(node.id)
      coactive.push([node.id, Math.max(0.6, pending.activation)])
    } else {
      node.ignored += 1
      report.ignored.push(node.id)
      if (node.ignored >= 2) {
        ranker.train(pending.x, 0)
        report.trained += 1
        brain.weaken(node, 0.1, at)
      }
    }
  }

  const statements = [...heuristicExtract(turn.prompt), ...heuristicExtract(turn.answer)]
  for (const node of addExtracted(brain, statements, { source: 'transcript', at, salience: 0.35, files: [...state.files.keys()] })) {
    report.extracted.push(node.id)
    coactive.push([node.id, 0.7])
  }

  report.hebbianPairs = brain.hebbian(coactive, at)
  return report
}

/** A person's judgement in the panel: pin is "keep it" (a positive sample), forget a negative one. */
export function personFeedback(ranker: Ranker, session: Session, id: string, isKept: boolean): boolean {
  const x = session.lastX.get(id)
  if (x === undefined) return false
  ranker.train(x, isKept ? 1 : 0)
  return true
}

/** The strongest neighbourhood of a node, two levels deep, for the panel's text graph. */
export function neighbourhood(brain: Brain, id: string, at: number, width = 4): { node: MemoryNode; w: number; type: EdgeType; children: { node: MemoryNode; w: number; type: EdgeType }[] }[] {
  return brain.neighbours(id, at, width).map(({ node, edge, w }) => ({
    node,
    w,
    type: edge.type,
    children: brain
      .neighbours(node.id, at, width + 1)
      .filter(child => child.node.id !== id)
      .slice(0, Math.max(1, width - 2))
      .map(child => ({ node: child.node, w: child.w, type: child.edge.type })),
  }))
}
