/**
 * What reaches Claude: a compact note of the memories that matter for this prompt, each with when and why it
 * was recalled, within a token budget; and the rule that tells a memory once per conversation unless it comes
 * back strongly. Pure: no `$`.
 */
import { approxTokens } from './features'
import type { EdgeType, MemoryNode } from './graph'

export type Recalled = {
  id: string
  node: MemoryNode
  score: number
  activation: number
  matched: readonly string[]
  via?: { text: string; type: EdgeType }
}

export const NOTE_HEADER = 'Project memory (project-brain) recalled for this prompt; use what is relevant, ignore the rest:'

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

const LEAD: Record<string, (node: MemoryNode) => string> = {
  decision: node => `decided ${day(node.created)}`,
  convention: () => 'convention',
  lesson: node => `lesson ${day(node.created)}`,
  term: () => 'term',
  person: () => 'owner',
  task: () => 'open task',
  note: () => 'note',
}

const VIA: Record<EdgeType, string> = {
  mentions: 'about',
  'co-edited': 'edited with',
  'fixed-by': 'fix for',
  'decided-for': 'decided for',
  'depends-on': 'depends on',
  related: 'related to',
}

/** Readable matched terms: stems as they are, `file:x` as x, `sym:x` as x; bigrams and paths left out. */
const readable = (matched: readonly string[]): string[] =>
  [...new Set(matched.filter(term => !term.includes('_') && !term.startsWith('path:')).map(term => term.replace(/^(?:file|sym):/, '')))].slice(0, 4)

/** Why it was recalled, in a few words. */
export function whyOf(item: Recalled): string {
  const words = readable(item.matched)
  if (words.length > 0) return `matches ${words.join(', ')}`
  if (item.via !== undefined) return `${VIA[item.via.type]} ${item.via.text}`
  return 'strongly linked'
}

/** One line: `- decided 2026-10-02: use Postgres for orders (matches postgres, order) [d1x2]`. */
export function noteLine(item: Recalled): string {
  const lead = (LEAD[item.node.kind] ?? (() => item.node.kind))(item.node)
  return `- ${lead}: ${item.node.text} (${whyOf(item)}) [${item.id}]`
}

/** The note within `budgetTokens`, best first; the ids it holds. Empty text when nothing fits. */
export function composeNote(items: readonly Recalled[], budgetTokens: number): { text: string; ids: string[] } {
  const lines = [NOTE_HEADER]
  const ids: string[] = []
  let used = approxTokens(NOTE_HEADER)
  for (const item of items) {
    const line = noteLine(item)
    const cost = approxTokens(line) + 1
    if (used + cost > budgetTokens) continue
    lines.push(line)
    ids.push(item.id)
    used += cost
  }
  return ids.length === 0 ? { text: '', ids } : { text: lines.join('\n'), ids }
}

export type InjectionLog = Map<string, { turn: number; activation: number }>

/** Activation at which a memory already told in this conversation is told again. */
export const REACTIVATION = 0.9
/** …and only after this many prompts since. */
export const REACTIVATION_TURNS = 8

/** Once per conversation per memory, unless it is reactivated strongly well after it was told. */
export function mayInject(log: InjectionLog, id: string, activation: number, turn: number): boolean {
  const told = log.get(id)
  if (told === undefined) return true
  return activation >= REACTIVATION && turn - told.turn >= REACTIVATION_TURNS
}
