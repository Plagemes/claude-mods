import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput, Timer } from 'claude-code'

import type { BrainActive, BrainStatsView } from '../types'
import { Brain, DEFAULT_PARAMS, type BrainParams, KNOWLEDGE_KINDS, type MemoryNode, type NodeKind, isBrainFile, utf8Bytes } from './graph'
import { EXTRACTION_SYSTEM, SUMMARY_SYSTEM, type TurnDigest, extractionPrompt, isBuildCommand, parseExtraction, summaryPrompt } from './ingest'
import { featuresOf } from './features'
import { whyOf } from './inject'
import {
  DEFAULT_MIND,
  type KnowledgeFile,
  type MindConfig,
  type Session,
  type TurnState,
  addExtracted,
  finishTurn,
  takeTurn,
  importKnowledge,
  ingestBusEvent,
  ingestCommand,
  ingestEdit,
  neighbourhood,
  newSession,
  personFeedback,
  prepareInjection,
  recallForTool,
} from './mind'
import { Ranker } from './ranker'
import { redactText } from './shared/secrets'
import { isTestCommand } from './shared/test-runners'

// ── Constants ───────────────────────────────────────────────────────────────────────────────────────

const NAME = 'project-brain'
const VERSION = '1.0.0'
const PANE = 'project-brain'
const HUB_PANE = 'claude-mods'
const TAB = 'brain'
const TAB_ORDER = 60
const TOOL_RECALL = 'mcp__project-brain__brain_recall'
const TOOL_REMEMBER = 'mcp__project-brain__brain_remember'
const BRAIN_DIR = '.claude/brain'
const GRAPH_FILE = 'graph.json'
const RANKER_FILE = 'ranker.json'
const SAVE_DELAY_MS = 5_000
const TICK_MS = 60_000
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const MODEL_TIMEOUT_MS = 45_000
const MODEL_MAX_TOKENS = 700
/** Finished turns batched into one extraction call, and the longest a turn waits for its batch. */
const EXTRACT_BATCH = 3
const EXTRACT_MAX_WAIT_MS = 10 * MINUTE_MS
const SUMMARIES_PER_SLEEP = 2
const MAX_CODE_CHARS = 20_000
const MAX_DIGEST_CHARS = 4_000
const MAX_KNOWLEDGE_FILES = 200
const MAX_KNOWLEDGE_BYTES = 512 * 1024
const DEFAULT_TOOL_LIMIT = 6
const MAX_TOOL_LIMIT = 12
const FACT_TOP = 10
/** Keeps the saved graph well under what one `$.fs.read` returns (4 MiB). */
const MAX_NODES_CAP = 6_000
/**
 * The most the saved graph may weigh: `$.fs.write` and `$.fs.read` refuse over 4 MiB, and long or non-Latin
 * texts can pass that below the node cap. Over it, the weakest memories and links go before the save.
 */
const MAX_SAVE_BYTES = 3.75 * 1024 * 1024
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])
const KNOWLEDGE_KINDS_LIST = ['decision', 'convention', 'lesson', 'term', 'person', 'task', 'note'] as const

/** Single knowledge files, and folders of them, imported once (again when they change). */
const KNOWLEDGE_FILES: readonly (readonly [KnowledgeFile, string])[] = [
  ['claude-md', 'CLAUDE.md'],
  ['claude-md', '.claude/CLAUDE.md'],
  ['glossary', 'GLOSSARY.md'],
  ['glossary', 'docs/GLOSSARY.md'],
  ['glossary', 'docs/glossary.md'],
  ['codeowners', 'CODEOWNERS'],
  ['codeowners', '.github/CODEOWNERS'],
  ['codeowners', 'docs/CODEOWNERS'],
]
const KNOWLEDGE_DIRS: readonly (readonly [KnowledgeFile, string])[] = [
  ['adr', 'docs/decisions'],
  ['adr', 'docs/adr'],
  ['adr', 'doc/adr'],
  ['adr', 'adr'],
  ['journal', '.claude/journal'],
]

const RECALL_DESCRIPTION =
  "Search this project's long-term memory: decisions, conventions, lessons, terms, owners. It follows links between files, " +
  'symbols and errors, so it also finds memories sharing no words with the query. Use it before deciding something that ' +
  'may be decided already, or when a failure looks familiar.'
const RECALL_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'A few distinctive words or file names.' },
    limit: { type: 'integer', minimum: 1, maximum: MAX_TOOL_LIMIT, description: `Memories to return (default ${DEFAULT_TOOL_LIMIT}).` },
  },
  required: ['query'],
}
const REMEMBER_DESCRIPTION =
  "Save one durable fact to this project's long-term memory: a decision and its reason, a convention, a lesson, a term or an " +
  'owner. One self-contained sentence naming the files. No secrets.'
const REMEMBER_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'One self-contained sentence.' },
    kind: { type: 'string', enum: [...KNOWLEDGE_KINDS_LIST], description: 'Default note.' },
  },
  required: ['text'],
}
const BRAIN_USAGE = 'Usage: /brain [search <words> | remember <text> | pin <id> | unpin <id> | forget <id> | sleep | stats | import]'

// ── State the panel draws from ──────────────────────────────────────────────────────────────────────

const EMPTY_STATS: BrainStatsView = { isLoaded: false, nodes: 0, edges: 0, knowledge: 0, pinned: 0, samples: 0, accuracy: null, isLearnt: false, lastSleep: 0, injected: 0 }

const activeAtom = atom({ plugin: 'project-brain', key: 'active' } as const, [] as BrainActive[])
const statsAtom = atom({ plugin: 'project-brain', key: 'stats' } as const, EMPTY_STATS)
const revAtom = atom({ plugin: 'project-brain', key: 'rev' } as const, 0)
const queryAtom = atom({ plugin: 'project-brain', key: 'query' } as const, '')
const editingAtom = atom({ plugin: 'project-brain', key: 'editing' } as const, null as string | null)
const focusAtom = atom({ plugin: 'project-brain', key: 'focus' } as const, null as string | null)

// ── The per-load runtime ────────────────────────────────────────────────────────────────────────────

type Settings = {
  isInjecting: boolean
  tokenBudget: number
  useModel: boolean
  model: string
  callsPerHour: number
  halfLifeMs: number
  maxNodes: number
  idleMs: number
}

type Runtime = {
  settings: Settings
  mind: MindConfig
  root: string
  dir: string
  brain: Brain | undefined
  ranker: Ranker | undefined
  loading: Promise<void> | undefined
  /** The graph file's mtime as this session last wrote or read it: a newer one is another session's save. */
  diskMtime: number
  /** False when a saved brain exists but could not be read: saving would destroy it. */
  isWritable: boolean
  saveTimer: Timer | undefined
  idleTimer: Timer | undefined
  ticker: Timer | undefined
  session: Session
  lastPrompt: string
  digests: TurnDigest[]
  firstDigestAt: number
  fixes: string[]
  modelCalls: number[]
  busSince: number
  isSleeping: boolean
  injected: number
  /** Whether brain_recall is registered: it waits until the brain holds a memory worth searching. */
  isRecallOffered: boolean
}

const newRuntime = (settings: Settings): Runtime => ({
  settings,
  mind: { ...DEFAULT_MIND, tokenBudget: settings.isInjecting ? settings.tokenBudget : 0 },
  root: '',
  dir: '',
  brain: undefined,
  ranker: undefined,
  loading: undefined,
  diskMtime: 0,
  isWritable: true,
  saveTimer: undefined,
  idleTimer: undefined,
  ticker: undefined,
  session: newSession(),
  lastPrompt: '',
  digests: [],
  firstDigestAt: 0,
  fixes: [],
  modelCalls: [],
  busSince: 0,
  isSleeping: false,
  injected: 0,
  isRecallOffered: false,
})

const clampNumber = (value: unknown, low: number, high: number, fallback: number): number => {
  const n = Number(value)
  return value !== undefined && value !== null && value !== '' && Number.isFinite(n) ? Math.min(high, Math.max(low, n)) : fallback
}

const brainParams = (settings: Settings): BrainParams => ({ ...DEFAULT_PARAMS, halfLifeMs: settings.halfLifeMs, maxNodes: settings.maxNodes, maxEdges: settings.maxNodes * 10 })

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const ago = (ms: number): string => (ms < MINUTE_MS ? 'just now' : ms < HOUR_MS ? `${Math.floor(ms / MINUTE_MS)}m ago` : ms < DAY_MS ? `${Math.floor(ms / HOUR_MS)}h ago` : `${Math.floor(ms / DAY_MS)}d ago`)

const relativePath = (root: string, path: string): string | undefined => {
  if (root !== '' && path.startsWith(`${root}/`)) return path.slice(root.length + 1)
  return path.startsWith('/') ? undefined : path.replace(/^\.\//, '')
}

const isPerson = (origin: { kind: string; asUser?: boolean }): boolean => PERSON_ORIGINS.has(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)

const bashOutput = (ran: { result?: unknown; text?: string }): string => {
  const result = ran.result as { stdout?: unknown; stderr?: unknown } | undefined
  if (result !== undefined && result !== null && typeof result === 'object' && typeof result.stdout === 'string') {
    return `${result.stdout}\n${typeof result.stderr === 'string' ? result.stderr : ''}`
  }
  return ran.text ?? (typeof ran.result === 'string' ? ran.result : '')
}

// ── Loading and saving ──────────────────────────────────────────────────────────────────────────────

async function readJson($: EngineInterface, path: string): Promise<unknown> {
  try {
    return JSON.parse(await $.fs.read(path)) as unknown
  } catch {
    return undefined
  }
}

async function mtimeOf($: EngineInterface, path: string): Promise<number> {
  try {
    return (await $.fs.stat(path)).mtimeMs
  } catch {
    return 0
  }
}

async function loadBrain($: EngineInterface, rt: Runtime): Promise<void> {
  let root = ''
  try {
    root = (await $.session.repo())?.root ?? ''
  } catch {
    root = ''
  }
  rt.root = root === '' ? await $.session.root() : root
  rt.dir = `${rt.root}/${BRAIN_DIR}`
  const path = `${rt.dir}/${GRAPH_FILE}`
  rt.diskMtime = await mtimeOf($, path)
  let saved: unknown
  if (rt.diskMtime > 0) {
    let text: string | undefined
    try {
      text = await $.fs.read(path)
    } catch (error) {
      // There but unreadable (too large, permissions): never overwrite it with an empty brain.
      rt.isWritable = false
      $.ui.log(`${NAME}: ${path} could not be read (${errorText(error)}); this session will not save over it`, { to: 'debug' })
    }
    try {
      saved = text === undefined ? undefined : (JSON.parse(text) as unknown)
    } catch {
      await $.fs.write(`${rt.dir}/graph.broken-${await $.clock.now()}.json`, text ?? '').catch(() => undefined)
    }
  }
  rt.brain = Brain.fromFile(saved, brainParams(rt.settings))
  rt.ranker = Ranker.fromFile(await readJson($, `${rt.dir}/${RANKER_FILE}`))
  startTicker($, rt)
}

/** The brain, loaded on first use (also after a hot reload, which starts a fresh runtime). */
async function ensureBrain($: EngineInterface, rt: Runtime): Promise<{ brain: Brain; ranker: Ranker }> {
  if (rt.brain === undefined || rt.ranker === undefined) {
    rt.loading ??= loadBrain($, rt)
    await rt.loading
  }
  return { brain: rt.brain as Brain, ranker: rt.ranker as Ranker }
}

/** Writes the graph and the ranker, first absorbing what another session saved meanwhile. */
async function save($: EngineInterface, rt: Runtime): Promise<void> {
  rt.saveTimer?.cancel()
  rt.saveTimer = undefined
  const { brain, ranker } = await ensureBrain($, rt)
  if (!rt.isWritable) return
  const path = `${rt.dir}/${GRAPH_FILE}`
  const now = await $.clock.now()
  if ((await mtimeOf($, path)) > rt.diskMtime) {
    const disk = await readJson($, path)
    // Another session's save is merged in, then held to the caps (absorbing never prunes on its own).
    if (isBrainFile(disk)) {
      brain.absorb(disk)
      brain.enforceCaps(now, brain.params.maxNodes, brain.params.maxEdges)
    }
  }
  brain.rev += 1
  try {
    await $.fs.write(path, fittedJson(brain, now))
    await $.fs.write(`${rt.dir}/${RANKER_FILE}`, JSON.stringify(ranker.toFile()))
    rt.diskMtime = await mtimeOf($, path)
  } catch (error) {
    $.ui.log(`${NAME}: could not save the brain: ${errorText(error)}`, { to: 'debug' })
  }
}

/** The graph as JSON within MAX_SAVE_BYTES, dropping the weakest tenth of memories and links until it fits. */
function fittedJson(brain: Brain, now: number): string {
  let json = JSON.stringify(brain.toFile(now))
  for (let pass = 0; pass < 12 && utf8Bytes(json) > MAX_SAVE_BYTES && brain.nodes.size > 0; pass += 1) {
    brain.enforceCaps(now, Math.floor(brain.nodes.size * 0.9), Math.floor(brain.edgeCount * 0.9))
    json = JSON.stringify(brain.toFile(now))
  }
  return json
}

/** The graph changed: redraw the panel, save a little later. */
async function changed($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.saveTimer === undefined) rt.saveTimer = $.clock.after(SAVE_DELAY_MS, () => void save($, rt))
  await refreshView($, rt)
}

async function refreshView($: EngineInterface, rt: Runtime): Promise<void> {
  const { brain, ranker } = await ensureBrain($, rt)
  const stats = brain.stats()
  await update($, statsAtom, () => ({
    isLoaded: true,
    nodes: stats.nodes,
    edges: stats.edges,
    knowledge: stats.knowledge,
    pinned: stats.pinned,
    samples: ranker.samples,
    accuracy: ranker.accuracy(),
    isLearnt: ranker.samples >= rt.mind.minSamples,
    lastSleep: brain.meta.lastSleep,
    injected: rt.injected,
  }))
  await update($, activeAtom, () => rt.session.lastActive.map(item => ({ ...item })))
  await update($, revAtom, rev => rev + 1)
}

// ── The hub (soft): facts and events pulled from the bus ────────────────────────────────────────────

/** Puts a fact on the hub's blackboard (`project-brain.<name>`); nothing without a hub. */
async function hubShare($: EngineInterface, name: string, value: Parameters<EngineInterface['mods']['share']>[0]['value']): Promise<void> {
  try {
    await $.mods.share({ name, value })
  } catch {
    // No hub: facts are for other mods only.
  }
}

/** This session's bus events since `since`; empty without a hub. */
async function hubRecent($: EngineInterface, since: number): Promise<Awaited<ReturnType<EngineInterface['mods']['recent']>>> {
  try {
    return await $.mods.recent({ since, limit: 50 })
  } catch {
    return []
  }
}

async function pullBus($: EngineInterface, rt: Runtime): Promise<void> {
  const events = await hubRecent($, rt.busSince)
  if (events.length === 0) return
  const { brain } = await ensureBrain($, rt)
  let touched = 0
  let isIdle = false
  for (const event of events) {
    rt.busSince = Math.max(rt.busSince, event.at)
    if (event.source === NAME) continue
    if (event.topic === 'session.idle') isIdle = true
    touched += ingestBusEvent(brain, rt.session, { topic: event.topic, data: event.data, source: event.source, at: event.at }).length
  }
  if (touched > 0) await changed($, rt)
  if (isIdle) $.clock.after(0, () => void sleep($, rt, 'idle'))
}

async function shareFacts($: EngineInterface, rt: Runtime): Promise<void> {
  const { brain, ranker } = await ensureBrain($, rt)
  const now = await $.clock.now()
  const stats = brain.stats()
  await hubShare($, 'stats', { nodes: stats.nodes, edges: stats.edges, knowledge: stats.knowledge, samples: ranker.samples, accuracy: ranker.accuracy() })
  const top = [...brain.nodes.values()]
    .filter(node => KNOWLEDGE_KINDS.has(node.kind))
    .sort((a, b) => brain.salienceOf(b, now) - brain.salienceOf(a, now))
    .slice(0, FACT_TOP)
    .map(node => ({ id: node.id, kind: node.kind, text: node.text }))
  await hubShare($, 'top', top)
}

// ── Importing what the project already knows ────────────────────────────────────────────────────────

async function importOne($: EngineInterface, rt: Runtime, kind: KnowledgeFile, path: string, isForced: boolean): Promise<number> {
  const { brain } = await ensureBrain($, rt)
  const absolute = `${rt.root}/${path}`
  let mtime = 0
  try {
    const stat = await $.fs.stat(absolute)
    if (stat.kind !== 'file' || stat.size > MAX_KNOWLEDGE_BYTES) return 0
    mtime = stat.mtimeMs
  } catch {
    return 0
  }
  if (!isForced && brain.meta.imported[path] === mtime) return 0
  try {
    const count = importKnowledge(brain, kind, path, await $.fs.read(absolute), await $.clock.now())
    brain.meta.imported[path] = mtime
    return count
  } catch {
    return 0
  }
}

async function importAll($: EngineInterface, rt: Runtime, isForced = false): Promise<number> {
  await ensureBrain($, rt)
  let count = 0
  for (const [kind, path] of KNOWLEDGE_FILES) count += await importOne($, rt, kind, path, isForced)
  let files = 0
  for (const [kind, dir] of KNOWLEDGE_DIRS) {
    let entries: Awaited<ReturnType<EngineInterface['fs']['list']>> = []
    try {
      entries = await $.fs.list(`${rt.root}/${dir}`)
    } catch {
      continue
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.kind !== 'file' || !/\.(?:md|markdown|txt)$/i.test(entry.name) || files >= MAX_KNOWLEDGE_FILES) continue
      files += 1
      count += await importOne($, rt, kind, `${dir}/${entry.name}`, isForced)
    }
  }
  if (count > 0) {
    await changed($, rt)
    await shareFacts($, rt)
    await offerRecall($, rt)
  }
  return count
}

// ── The background model ────────────────────────────────────────────────────────────────────────────

function mayCallModel(rt: Runtime, now: number): boolean {
  rt.modelCalls = rt.modelCalls.filter(at => now - at < HOUR_MS)
  return rt.settings.useModel && rt.settings.callsPerHour > 0 && rt.modelCalls.length < rt.settings.callsPerHour
}

/** One small completion, secrets masked first; undefined when it did not answer. */
async function callModel($: EngineInterface, rt: Runtime, system: string, prompt: string): Promise<string | undefined> {
  rt.modelCalls.push(await $.clock.now())
  try {
    const result = await $.model.complete({ model: rt.settings.model, system, prompt: redactText(prompt).text, maxTokens: MODEL_MAX_TOKENS, timeoutMs: MODEL_TIMEOUT_MS })
    return result.isAnswered ? result.text : undefined
  } catch (error) {
    $.ui.log(`${NAME}: model call refused: ${errorText(error)}`, { to: 'debug' })
    return undefined
  }
}

/** Sends the waiting turns to the model and adds the decisions, conventions and lessons it finds. */
async function flushExtraction($: EngineInterface, rt: Runtime): Promise<number> {
  const now = await $.clock.now()
  if (rt.digests.length === 0 || !mayCallModel(rt, now)) return 0
  const batch = rt.digests.splice(0, EXTRACT_BATCH * 2)
  rt.firstDigestAt = rt.digests.length === 0 ? 0 : now
  const reply = await callModel($, rt, EXTRACTION_SYSTEM, extractionPrompt(batch))
  if (reply === undefined) return 0
  const { brain } = await ensureBrain($, rt)
  const at = await $.clock.now()
  const added = addExtracted(brain, parseExtraction(reply), { source: 'model', at, salience: 0.5 })
  brain.hebbian(added.map(node => [node.id, 0.6] as const), at)
  if (added.length > 0) await changed($, rt)
  return added.length
}

/** Summarises a few unsummarised clusters into one note each. */
async function summarise($: EngineInterface, rt: Runtime): Promise<number> {
  const { brain } = await ensureBrain($, rt)
  let made = 0
  for (const cluster of brain.clusters(await $.clock.now()).slice(0, SUMMARIES_PER_SLEEP)) {
    const now = await $.clock.now()
    if (!mayCallModel(rt, now)) break
    const members = [...cluster.members].sort((a, b) => brain.salienceOf(b, now) - brain.salienceOf(a, now)).slice(0, 8)
    const reply = await callModel($, rt, SUMMARY_SYSTEM, summaryPrompt(members.map(node => node.text)))
    brain.meta.summarized[cluster.key] = now
    if (reply === undefined || reply.trim().length < 8) continue
    const note = brain.upsert({ kind: 'note', text: reply.trim(), key: `summary:${cluster.key}`, source: 'summary', at: now, salience: 0.5 })
    if (note === undefined) continue
    for (const member of members) brain.link(note.node.id, member.id, 'related', 0.5, now)
    made += 1
  }
  return made
}

// ── Sleep: consolidation ────────────────────────────────────────────────────────────────────────────

async function sleep($: EngineInterface, rt: Runtime, reason: 'idle' | 'command'): Promise<string> {
  if (rt.isSleeping) return 'Already consolidating.'
  rt.isSleeping = true
  try {
    const { brain } = await ensureBrain($, rt)
    const extracted = await flushExtraction($, rt)
    const summaries = await summarise($, rt)
    const report = brain.consolidate(await $.clock.now())
    await save($, rt)
    await refreshView($, rt)
    await hubPublish($, { topic: 'x.project-brain.updated', data: { reason, ...report, extracted, summaries } })
    await shareFacts($, rt)
    return `Consolidated: ${report.merged} merged, ${report.prunedNodes} memories and ${report.prunedEdges} links pruned, ${summaries} summaries, ${extracted} learnt; ${report.nodes} memories, ${report.edges} links.`
  } finally {
    rt.isSleeping = false
  }
}

function scheduleIdle($: EngineInterface, rt: Runtime): void {
  rt.idleTimer?.cancel()
  rt.idleTimer = $.clock.after(rt.settings.idleMs, () => void sleep($, rt, 'idle'))
}

async function tick($: EngineInterface, rt: Runtime): Promise<void> {
  await pullBus($, rt)
  const now = await $.clock.now()
  if (rt.digests.length > 0 && now - rt.firstDigestAt >= EXTRACT_MAX_WAIT_MS) await flushExtraction($, rt)
}

// ── Hooks' work ─────────────────────────────────────────────────────────────────────────────────────

/** Recall for a prompt: the note to attach (empty when nothing qualifies). */
async function beforePrompt($: EngineInterface, rt: Runtime, text: string): Promise<string> {
  const { brain, ranker } = await ensureBrain($, rt)
  const now = await $.clock.now()
  rt.session.turn += 1
  rt.lastPrompt = text
  scheduleIdle($, rt)
  const injection = prepareInjection(brain, ranker, rt.session, text, now, rt.mind)
  rt.injected += injection.ids.length
  $.clock.after(0, () => void afterRecall($, rt, injection.ids, 'prompt'))
  return injection.note
}

async function afterRecall($: EngineInterface, rt: Runtime, ids: readonly string[], via: 'prompt' | 'tool'): Promise<void> {
  const { brain } = await ensureBrain($, rt)
  await changed($, rt)
  if (ids.length === 0) return
  const memories = ids.map(id => brain.get(id)).filter((node): node is MemoryNode => node !== undefined)
  await hubPublish($, { topic: 'x.project-brain.recalled', data: { via, memories: memories.map(node => ({ id: node.id, kind: node.kind, text: node.text })) } })
}

async function observeEdit($: EngineInterface, rt: Runtime, path: string, code: string): Promise<void> {
  const { brain } = await ensureBrain($, rt)
  const relative = relativePath(rt.root, path)
  if (relative === undefined || relative.startsWith(`${BRAIN_DIR}/`)) return
  ingestEdit(brain, rt.session, { path: relative, code: code.slice(0, MAX_CODE_CHARS), at: await $.clock.now() })
  await changed($, rt)
}

async function observeRead($: EngineInterface, rt: Runtime, path: string): Promise<void> {
  await ensureBrain($, rt)
  const relative = relativePath(rt.root, path)
  if (relative !== undefined) rt.session.filesInPlay.set(relative, rt.session.turn)
}

async function observeCommand($: EngineInterface, rt: Runtime, command: string, output: string, hasFailed: boolean): Promise<void> {
  const { brain } = await ensureBrain($, rt)
  const outcome = ingestCommand(brain, rt.session, { command, output, hasFailed, at: await $.clock.now() })
  if (outcome.kind === 'none') return
  if (outcome.kind === 'fixed') rt.fixes.push(outcome.fix)
  await changed($, rt)
}

/**
 * This turn as the transcript holds it: the person's last prompt and every assistant text since (decisions are
 * often stated between tool calls, not only in the final answer). Empty when the transcript cannot be read.
 */
async function turnTexts($: EngineInterface): Promise<{ prompt?: string; answer?: string }> {
  try {
    const messages = await $.session.messages()
    if (!Array.isArray(messages)) return {}
    const rows = messages as readonly { role: string; text: string }[]
    let start = rows.length - 1
    while (start >= 0 && !(rows[start]?.role === 'user' && (rows[start]?.text ?? '').trim() !== '')) start -= 1
    const answer = rows
      .slice(start + 1)
      .filter(row => row.role === 'assistant' && row.text.trim() !== '')
      .map(row => row.text)
      .join('\n')
    return { ...(start >= 0 ? { prompt: rows[start]?.text ?? '' } : {}), ...(answer === '' ? {} : { answer }) }
  } catch {
    return {}
  }
}

/** After a main-loop turn: feedback, learning, extraction, wiring; then the bus. */
async function afterTurn($: EngineInterface, rt: Runtime, state: TurnState, lastPrompt: string, fixes: string[], finalAnswer: string): Promise<void> {
  const { brain, ranker } = await ensureBrain($, rt)
  const transcript = await turnTexts($)
  const prompt = lastPrompt !== '' ? lastPrompt : (transcript.prompt ?? '')
  const answer = transcript.answer !== undefined && transcript.answer.includes(finalAnswer) ? transcript.answer : finalAnswer
  const at = await $.clock.now()
  finishTurn(brain, ranker, state, { prompt, answer, at })
  if (rt.settings.useModel && (prompt !== '' || answer !== '')) {
    if (rt.digests.length === 0) rt.firstDigestAt = at
    rt.digests.push({ turn: state.turn, prompt: prompt.slice(0, MAX_DIGEST_CHARS), answer: answer.slice(0, MAX_DIGEST_CHARS), files: [...state.files.keys()], fixes })
  }
  await changed($, rt)
  scheduleIdle($, rt)
  if (rt.digests.length >= EXTRACT_BATCH) await flushExtraction($, rt)
  await pullBus($, rt)
}

/** Registers brain_recall once the brain holds a memory; an empty brain has nothing to search, so the tool stays out of the prompt. */
async function offerRecall($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.isRecallOffered) return
  try {
    const { brain } = await ensureBrain($, rt)
    if (brain.stats().knowledge === 0) return
    await $.tool.register({ name: 'brain_recall', description: RECALL_DESCRIPTION, inputSchema: RECALL_SCHEMA })
    rt.isRecallOffered = true
  } catch (error) {
    $.ui.log(`${NAME}: registration failed: ${errorText(error)}`, { to: 'debug' })
  }
}

// ── Tools for Claude ────────────────────────────────────────────────────────────────────────────────

async function toolRecall($: EngineInterface, rt: Runtime, query: string, limit: number): Promise<string> {
  const { brain, ranker } = await ensureBrain($, rt)
  if (query === '') return 'brain_recall: the query is empty; pass a few distinctive words, e.g. {"query": "orders database"}.'
  const found = recallForTool(brain, ranker, rt.session, query, limit, await $.clock.now(), rt.mind)
  $.clock.after(0, () => void afterRecall($, rt, found.map(item => item.id), 'tool'))
  if (found.length === 0) return `No memories recalled for "${query}" (${brain.stats().knowledge} memories known).`
  const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
  return [
    `Memories recalled for "${query}" (most relevant first):`,
    ...found.map((item, index) => `${index + 1}. [${item.node.kind} · ${day(item.node.created)} · ${item.id}] ${item.node.text} (${whyOf(item)}; score ${item.score.toFixed(2)})`),
  ].join('\n')
}

async function remember($: EngineInterface, rt: Runtime, text: string, kind: NodeKind, source: 'tool' | 'user'): Promise<MemoryNode | undefined> {
  const { brain } = await ensureBrain($, rt)
  const at = await $.clock.now()
  const files = [...new Set([...rt.session.turnFiles.keys(), ...[...rt.session.filesInPlay].filter(([, turn]) => turn >= rt.session.turn - 1).map(([path]) => path)])].slice(0, 4)
  const [node] = addExtracted(brain, [{ kind, text }], { source, at, salience: 0.65, files })
  if (node === undefined) return undefined
  rt.session.turnNodes.set(node.id, 0.9)
  await changed($, rt)
  await offerRecall($, rt)
  return node
}

// ── The /brain command and the panel's buttons ──────────────────────────────────────────────────────

async function openPanel($: EngineInterface): Promise<boolean> {
  if (await hubShowTab($, TAB)) return true
  return (await $.ui.open({ id: PANE, title: 'Brain' })).isPlaced
}

async function togglePin($: EngineInterface, rt: Runtime, id: string): Promise<string> {
  const { brain, ranker } = await ensureBrain($, rt)
  const node = brain.get(id)
  if (node === undefined) return `No memory ${id}.`
  node.isPinned = !node.isPinned
  if (node.isPinned) {
    brain.reinforce(node, 0.5, await $.clock.now())
    personFeedback(ranker, rt.session, id, true)
  }
  await changed($, rt)
  return node.isPinned ? `Pinned: ${node.text}` : `Unpinned: ${node.text}`
}

async function forgetMemory($: EngineInterface, rt: Runtime, id: string): Promise<string> {
  const { brain, ranker } = await ensureBrain($, rt)
  const node = brain.get(id)
  if (node === undefined) return `No memory ${id}.`
  personFeedback(ranker, rt.session, id, false)
  brain.forget(id, await $.clock.now())
  if ((await read($, focusAtom)) === id) await update($, focusAtom, () => null)
  await changed($, rt)
  return `Forgot: ${node.text}`
}

async function editMemory($: EngineInterface, rt: Runtime, id: string, text: string): Promise<void> {
  const { brain } = await ensureBrain($, rt)
  brain.edit(id, text, await $.clock.now())
  await update($, editingAtom, () => null)
  await changed($, rt)
}

function describeStats(stats: BrainStatsView, now: number): string {
  const ranker = stats.isLearnt
    ? `ranker learnt from ${stats.samples} samples${stats.accuracy === null ? '' : `, ${Math.round(stats.accuracy * 100)}% right lately`}`
    : `ranker warming up (${stats.samples}/${DEFAULT_MIND.minSamples} samples; heuristic until then)`
  const slept = stats.lastSleep === 0 ? 'never consolidated' : `consolidated ${ago(now - stats.lastSleep)}`
  return `${stats.nodes} memories (${stats.knowledge} knowledge, ${stats.pinned} pinned) · ${stats.edges} links · ${ranker} · ${slept} · ${stats.injected} recalled this session`
}

async function runBrain($: EngineInterface, rt: Runtime, args: string): Promise<string> {
  const { brain, ranker } = await ensureBrain($, rt)
  const [word = '', ...rest] = args.trim().split(/\s+/)
  const tail = rest.join(' ').trim()
  switch (word.toLowerCase()) {
    case '': {
      await refreshView($, rt)
      return (await openPanel($)) ? 'Brain panel opened.' : 'Brain panel opened; widen the terminal to see it.'
    }
    case 'search': {
      await update($, queryAtom, () => tail)
      await openPanel($)
      const found = recallForTool(brain, ranker, rt.session, tail, DEFAULT_TOOL_LIMIT, await $.clock.now(), rt.mind)
      await refreshView($, rt)
      return found.length === 0 ? `Nothing recalled for "${tail}".` : found.map(item => `[${item.id}] ${item.node.kind}: ${item.node.text}`).join('\n')
    }
    case 'remember': {
      if (tail === '') return BRAIN_USAGE
      const node = await remember($, rt, tail, 'note', 'user')
      return node === undefined ? 'Nothing to remember.' : `Remembered [${node.id}]: ${node.text}`
    }
    case 'pin':
    case 'unpin': {
      const node = brain.get(tail)
      if (node === undefined) return `No memory ${tail}.`
      return node.isPinned === (word === 'pin') ? `Already ${word}ned.` : togglePin($, rt, tail)
    }
    case 'forget':
      return forgetMemory($, rt, tail)
    case 'sleep':
      return sleep($, rt, 'command')
    case 'stats': {
      await refreshView($, rt)
      return describeStats(await read($, statsAtom), await $.clock.now())
    }
    case 'import': {
      const count = await importAll($, rt, true)
      return `Imported ${count} memories from CLAUDE.md, ADRs, glossary, journal and CODEOWNERS.`
    }
    default:
      return BRAIN_USAGE
  }
}

// ── The panel ───────────────────────────────────────────────────────────────────────────────────────

const BAR = 10
const bar = (value: number): string => {
  const filled = Math.max(0, Math.min(BAR, Math.round(value * BAR)))
  return `${'█'.repeat(filled)}${'░'.repeat(BAR - filled)}`
}
const strokeOf = (w: number): string => (w >= 0.6 ? '━━' : w >= 0.3 ? '──' : '┄┄')
const KIND_LABEL: Record<string, string> = { decision: 'decision', convention: 'convention', lesson: 'lesson', file: 'file', symbol: 'symbol', error: 'error', term: 'term', person: 'owner', task: 'task', note: 'note' }
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text)

/** The memories the list shows: matching the search, or the most salient knowledge. */
function listed(brain: Brain, query: string, now: number, limit: number): MemoryNode[] {
  if (query.trim() !== '') {
    return brain.index
      .search(featuresOf(query))
      .map(hit => brain.get(hit.doc))
      .filter((node): node is MemoryNode => node !== undefined && node.kind !== 'file' && node.kind !== 'symbol')
      .slice(0, limit)
  }
  return [...brain.nodes.values()]
    .filter(node => KNOWLEDGE_KINDS.has(node.kind))
    .sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || brain.salienceOf(b, now) - brain.salienceOf(a, now))
    .slice(0, limit)
}

async function drawBrain($: EngineInterface, e: RenderInput<'Pane'>, rt: Runtime): Promise<RenderElement> {
  const { Box, Button, Text } = $.ui.resolve(e)
  await read($, revAtom)
  const stats = await read($, statsAtom)
  const active = await read($, activeAtom)
  const query = await read($, queryAtom)
  const editing = await read($, editingAtom)
  const focus = await read($, focusAtom)
  const { brain } = await ensureBrain($, rt)
  const now = await $.clock.now()
  const columns = Math.max(30, e.props.bodyColumns || 80)
  const rows = Math.max(4, Math.min(20, (e.props.scroll.bodyRows || 40) - 22))

  const center = (focus === null ? undefined : brain.get(focus)) ?? active.map(item => brain.get(item.id)).find(node => node !== undefined && KNOWLEDGE_KINDS.has(node.kind)) ?? listed(brain, '', now, 1)[0]
  const graphLines: string[] = []
  if (center !== undefined) {
    graphLines.push(`◉ ${clip(center.text, columns - 3)}`)
    const branches = neighbourhood(brain, center.id, now)
    branches.forEach((branch, i) => {
      const isLast = i === branches.length - 1
      graphLines.push(clip(`${isLast ? '└' : '├'}${strokeOf(branch.w)} ${KIND_LABEL[branch.node.kind]}: ${branch.node.text}  ${branch.type} ${branch.w.toFixed(2)}`, columns))
      branch.children.forEach((child, j) => {
        graphLines.push(clip(`${isLast ? ' ' : '│'}  ${j === branch.children.length - 1 ? '└' : '├'}${strokeOf(child.w)} ${KIND_LABEL[child.node.kind]}: ${child.node.text}  ${child.w.toFixed(2)}`, columns))
      })
    })
    if (branches.length === 0) graphLines.push('  (no links yet: it gets wired as you work with it)')
  }

  const searchField = (): RenderElement | null => {
    if (e.surface === 'mobile') return query === '' ? null : <Text dimColor>{`Search: ${query} (/brain search to change)`}</Text>
    const { Input } = $.ui.resolve(e)
    return <Input key="search" placeholder="Search memories" submitLabel="search" value={query} onInput={value => void update($, queryAtom, () => value)} onSubmit={value => void update($, queryAtom, () => value.trim())} />
  }

  const editField = (node: MemoryNode): RenderElement | null => {
    if (e.surface === 'mobile') return null
    const { Input } = $.ui.resolve(e)
    return <Input key={`edit-${node.id}`} label="edit: " value={node.text} submitLabel="save" autoFocus onSubmit={value => void editMemory($, rt, node.id, value)} />
  }

  const memories = listed(brain, query, now, rows)

  return (
    <Box key="brain" flexDirection="column">
      <Text bold>Brain</Text>
      <Text dimColor wrap="wrap">
        {stats.isLoaded ? describeStats(stats, now) : 'Loading the project memory…'}
      </Text>

      <Box key="active" marginTop={1} flexDirection="column">
        <Text bold>Active now</Text>
        {active.length === 0 ? (
          <Text dimColor>Nothing fired yet: memories light up as you prompt, edit and run tests.</Text>
        ) : (
          active.map(item => (
            <Box key={`active-${item.id}`} flexDirection="row" columnGap={1}>
              <Text color={item.activation >= 0.6 ? 'success' : 'subtle'}>{bar(item.activation)}</Text>
              <Text dimColor>{item.activation.toFixed(2)}</Text>
              <Text wrap="truncate-end">{`${KIND_LABEL[item.kind] ?? item.kind}: ${item.text}`}</Text>
            </Box>
          ))
        )}
      </Box>

      <Box key="graph" marginTop={1} flexDirection="column">
        <Text bold>Neighbourhood</Text>
        {graphLines.length === 0 ? <Text dimColor>No memories yet.</Text> : graphLines.map((line, i) => <Box key={`g-${i}`}><Text wrap="truncate-end">{line}</Text></Box>)}
      </Box>

      <Box key="memories" marginTop={1} flexDirection="column">
        <Text bold>Memories</Text>
        {searchField()}
        {memories.length === 0 ? (
          <Text dimColor>{query === '' ? 'No memories yet. They come from CLAUDE.md, ADRs, your work, and brain_remember.' : `Nothing matches "${query}".`}</Text>
        ) : (
          memories.map(node => (
            <Box key={`mem-${node.id}`} flexDirection="column">
              <Box flexDirection="row" columnGap={1}>
                <Text color={node.isPinned ? 'warning' : 'subtle'}>{node.isPinned ? '★' : '·'}</Text>
                <Text dimColor>{`${bar(brain.salienceOf(node, now)).slice(0, 5)} ${KIND_LABEL[node.kind] ?? node.kind}${node.isInPrompt ? ' (CLAUDE.md)' : ''}`}</Text>
                <Text wrap="truncate-end">{node.text}</Text>
              </Box>
              {editing === node.id ? (
                editField(node)
              ) : (
                <Box key={`mem-actions-${node.id}`} flexDirection="row" columnGap={1} marginLeft={2}>
                  <Button key={`pin-${node.id}`} plain label={node.isPinned ? '[unpin]' : '[pin]'} onPress={() => void togglePin($, rt, node.id)} />
                  <Button key={`edit-btn-${node.id}`} plain label="[edit]" onPress={() => void update($, editingAtom, () => node.id)} />
                  <Button key={`forget-${node.id}`} plain label="[forget]" onPress={() => void forgetMemory($, rt, node.id)} />
                  <Button key={`focus-${node.id}`} plain label="[graph]" onPress={() => void update($, focusAtom, () => node.id)} />
                  <Text dimColor>{node.id}</Text>
                </Box>
              )}
            </Box>
          ))
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor wrap="wrap">/brain search · remember · pin · forget · sleep · stats · import</Text>
      </Box>
    </Box>
  )
}

// ── Registration ────────────────────────────────────────────────────────────────────────────────────

async function startSession($: EngineInterface, rt: Runtime): Promise<void> {
  await ensureBrain($, rt)
  const steps = [
    () => offerRecall($, rt),
    () => $.tool.register({ name: 'brain_remember', description: REMEMBER_DESCRIPTION, inputSchema: REMEMBER_SCHEMA }),
    () =>
      registerCommand($, {
        name: 'brain',
        description: "Opens the project's Brain: what is active now, the strongest links, every memory (search, pin, edit, forget).",
        argumentHint: '[search <words> | remember <text> | pin <id> | forget <id> | sleep | stats | import]',
      }),
  ]
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      $.ui.log(`${NAME}: registration failed: ${errorText(error)}`, { to: 'debug' })
    }
  }
  // Waits until session.start has returned (afterStart): with every mod installed, waiting on the hub, the disk
  // or a process here ran session.start past its 10 s budget.
  afterStart($, 'project-brain', async () => {
    await hubHello(
      $,
      { version: VERSION, publishes: ['x.project-brain.recalled', 'x.project-brain.updated'], consumes: ['decision.recorded', 'lesson.learned', 'error.repeated', 'test.result', 'git.commit', 'session.idle'] },
      { id: TAB, title: 'Brain', order: TAB_ORDER, command: 'brain' },
    )
    await refreshView($, rt)
  })
  $.clock.after(0, () => void importAll($, rt))
}

function startTicker($: EngineInterface, rt: Runtime): void {
  rt.ticker?.cancel()
  rt.ticker = $.clock.every(TICK_MS, () => void tick($, rt))
}

async function endSession($: EngineInterface, rt: Runtime, reason: string): Promise<void> {
  rt.ticker?.cancel()
  rt.idleTimer?.cancel()
  if (rt.brain !== undefined) {
    rt.brain.consolidate(await $.clock.now())
    await save($, rt)
  }
  if (reason === 'clear') {
    rt.session = newSession()
    rt.digests = []
    startTicker($, rt)
  }
}

export const register: Register = (on, options) => {
  const rt = newRuntime({
    isInjecting: options.inject !== false,
    tokenBudget: clampNumber(options.tokenBudget, 50, 8_000, 600),
    useModel: options.useModel !== false,
    model: typeof options.model === 'string' && options.model.trim() !== '' ? options.model.trim() : 'haiku',
    callsPerHour: clampNumber(options.modelCallsPerHour, 0, 120, 6),
    halfLifeMs: clampNumber(options.halfLifeDays, 0.5, 365, 14) * DAY_MS,
    maxNodes: Math.round(clampNumber(options.maxNodes, 200, MAX_NODES_CAP, 4_000)),
    idleMs: clampNumber(options.idleMinutes, 1, 24 * 60, 10) * MINUTE_MS,
  })

  on('session.start', async ($, e, next) => {
    await startSession($, rt)
    return next(e)
  })
  on('session.end', async ($, e, next) => {
    await endSession($, rt, String(e.reason))
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!isPerson(e.origin) || e.text.trim() === '') return next(e)
    const note = await beforePrompt($, rt, e.text)
    return next(note === '' ? e : { ...e, context: [...(e.context ?? []), note] })
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit', 'Read', 'Bash'] }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) {
      if (e.tool === 'Bash' && ran.isError === true && (isTestCommand(e.command) || isBuildCommand(e.command))) {
        const command = e.command
        const output = bashOutput(ran)
        $.clock.after(0, () => void observeCommand($, rt, command, output, true))
      }
      return ran
    }
    if (e.tool === 'Bash') {
      if (isTestCommand(e.command) || isBuildCommand(e.command)) {
        const command = e.command
        const output = bashOutput(ran)
        $.clock.after(0, () => void observeCommand($, rt, command, output, false))
      }
    } else if (e.tool === 'Read') {
      const path = e.file_path
      $.clock.after(0, () => void observeRead($, rt, path))
    } else if ('file_path' in e && typeof e.file_path === 'string') {
      const path = e.file_path
      const input = e as { new_string?: unknown; content?: unknown; new_source?: unknown }
      const code = [input.new_string, input.content, input.new_source].find((value): value is string => typeof value === 'string') ?? ''
      $.clock.after(0, () => void observeEdit($, rt, path, code))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: TOOL_RECALL }, async ($, e) => {
    const input = e as { query?: unknown; limit?: unknown }
    const query = typeof input.query === 'string' ? input.query.trim() : ''
    return { result: await toolRecall($, rt, query, Math.round(clampNumber(input.limit, 1, MAX_TOOL_LIMIT, DEFAULT_TOOL_LIMIT))) }
  }).catch(() => ({ result: 'brain_recall: the project memory is not available right now.' }))
  on('tool.call', { tool: TOOL_REMEMBER }, async ($, e) => {
    const input = e as { text?: unknown; kind?: unknown }
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    if (text.length < 8) return { result: 'brain_remember: give one self-contained sentence to remember.' }
    const kind: NodeKind = KNOWLEDGE_KINDS_LIST.find(one => one === input.kind) ?? 'note'
    const node = await remember($, rt, text, kind, 'tool')
    return { result: node === undefined ? 'brain_remember: nothing was saved (empty after masking).' : `Remembered as ${node.kind} [${node.id}]: ${node.text}` }
  }).catch(() => ({ result: 'brain_remember: the project memory is not available right now; nothing was saved.' }))

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && !e.isAborted) {
      const answer = e.answer
      const state = takeTurn(rt.session)
      const prompt = rt.lastPrompt
      const fixes = rt.fixes
      rt.lastPrompt = ''
      rt.fixes = []
      $.clock.after(0, () => void afterTurn($, rt, state, prompt, fixes, answer))
    }
    return ran
  })

  on('command.run', { command: 'brain' }, async ($, e) => ({ text: await runBrain($, rt, e.args) }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawBrain($, e, rt))
  on('ui.render', { component: 'Pane', requestId: HUB_PANE }, async ($, e, next) => {
    if (!(await hubTabIs($, TAB))) return next(e)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {await next(e)}
        {await drawBrain($, e, rt)}
      </Box>
    )
  })
}

/** Registers a slash command. A refused name (Claude Code's own, or another mod's) is reported as a notice, never thrown, so the rest of session.start still runs. */
async function registerCommand($: EngineInterface, spec: Parameters<EngineInterface['command']['register']>[0]): Promise<boolean> {
  try {
    await $.command.register(spec)
    return true
  } catch (error) {
    $.ui.log(`${$.plugin.name}: /${spec.name} was not registered (${error instanceof Error ? error.message : String(error)}).`)
    return false
  }
}

// #region @vendored shared/hub-client.ts sha256:6b153e2e759f: edit the source, then run `node scripts/sync-shared.mjs`.
// mods-hub client (docs/MOD_CONTRACT.md): uses the hub when it is installed, keeps working when it is not.

type HubMods = EngineInterface['mods']

/** Publishes an event on the hub's bus; false when there is no hub or it refused the event. */
async function hubPublish($: EngineInterface, input: Parameters<HubMods['publish']>[0]): Promise<boolean> {
  try {
    await $.mods.publish(input)
    return true
  } catch {
    return false
  }
}

/**
 * Routes a notification through the hub (channels, silent, night, presence), or shows it as a toast when there is
 * no hub: `title — body`, for `fallback.timeoutMs` when given (the toast's own option).
 */
async function hubNotify($: EngineInterface, input: Parameters<HubMods['notify']>[0], fallback: { timeoutMs?: number } = {}): Promise<void> {
  try {
    await $.mods.notify(input)
  } catch {
    const text = input.body === undefined || input.body === '' ? input.title : `${input.title} — ${input.body}`
    if (fallback.timeoutMs === undefined) $.ui.toast(text)
    else $.ui.toast(text, { timeoutMs: fallback.timeoutMs })
  }
}

/** The global mode (presence, silent, night, interaction), or undefined when there is no hub. */
async function hubMode($: EngineInterface): Promise<Awaited<ReturnType<HubMods['mode']>> | undefined> {
  try {
    return await $.mods.mode()
  } catch {
    return undefined
  }
}

/** Announces this mod to the hub, with its panel tab when it has one; call once from `session.start`. */
async function hubHello($: EngineInterface, hello: Parameters<HubMods['hello']>[0], tab?: Parameters<HubMods['registerTab']>[0]): Promise<boolean> {
  try {
    await $.mods.hello(hello)
    if (tab !== undefined) await $.mods.registerTab(tab)
    return true
  } catch {
    return false
  }
}

/** Opens the shared panel on this mod's tab; false when there is no hub (open your own pane then). */
async function hubShowTab($: EngineInterface, id: string): Promise<boolean> {
  try {
    return (await $.mods.showTab({ id })).isPlaced
  } catch {
    return false
  }
}

/**
 * Stops, pauses or resumes the automatic work (`control.stop` / `control.pause` / `control.resume`) in this session
 * or, with `scope: 'all'`, in every session; false when there is no hub (stop what you run yourself then).
 */
async function hubStop($: EngineInterface, input: Parameters<HubMods['stop']>[0]): Promise<boolean> {
  try {
    await $.mods.stop(input)
    return true
  } catch {
    return false
  }
}

/** Puts a fact on the hub's blackboard as `<this mod>.<name>`; false when there is no hub or it refused the fact. */
async function hubShareFact($: EngineInterface, input: Parameters<HubMods['share']>[0]): Promise<boolean> {
  try {
    await $.mods.share(input)
    return true
  } catch {
    return false
  }
}

/** A fact from the hub's blackboard by its full key (`stack-detector.stack`); undefined when there is no hub or no such fact. */
async function hubReadFact($: EngineInterface, key: string): Promise<Awaited<ReturnType<HubMods['read']>> | undefined> {
  try {
    return (await $.mods.read({ key })) ?? undefined
  } catch {
    return undefined
  }
}

/** Whether the shared panel shows tab `id` now; read while drawing, it subscribes the drawing. */
async function hubTabIs($: EngineInterface, id: string): Promise<boolean> {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
  return value === id
}
/**
 * Runs a mod's start-up work (the hub hello, a first scan, loading what it keeps) once `session.start` has returned,
 * after a short delay staggered by the mod's name (0.15–1.35 s), so ~200 mods sharing one hooks worker do not all wait
 * on the hub, a process or the disk inside the session.start chain (`ran past its 10s budget`). A failure is logged
 * to the debug log. Call it from `session.start` in place of `await work()`; never await the hub there
 * (scripts/check-startup.mjs).
 */
function afterStart($: EngineInterface, mod: string, work: () => Promise<unknown>): void {
  let hash = 7
  for (let i = 0; i < mod.length; i += 1) hash = (hash * 31 + mod.charCodeAt(i)) % 1_200
  $.clock.after(150 + hash, () => {
    void work().catch(error => $.ui.log(`${mod}: start-up work failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' }))
  })
}
// #endregion @vendored shared/hub-client.ts
