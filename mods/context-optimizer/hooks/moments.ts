/**
 * When to compact: at a task boundary (a commit, green tests, a cleared todo list, a new topic) once the context is
 * full enough, never twice in a row. Pure: no `$`, no I/O.
 */
import { simpleCommands } from './shared/shell'
import { isTestCommand, summarizeRun } from './shared/test-runners'

export type Milestone = 'commit' | 'tests'
export type MomentReason = 'commit' | 'tests' | 'todos' | 'topic'

export const REASON_LABEL: Readonly<Record<MomentReason, string>> = {
  commit: 'after a commit',
  tests: 'tests are green',
  todos: 'the todo list is done',
  topic: 'a new topic starts',
}

/** What a successful Bash command finished: a commit (or push, or PR), a green test run, or nothing notable. */
export function milestoneOf(command: string, output: string): Milestone | undefined {
  for (const cmd of simpleCommands(command)) {
    const [, sub, third] = cmd.argv
    if (cmd.name === 'git' && (sub === 'commit' || sub === 'push')) return 'commit'
    if (cmd.name === 'gh' && sub === 'pr' && (third === 'create' || third === 'merge')) return 'commit'
  }
  if (isTestCommand(command) && summarizeRun(command, output, false).outcome === 'passed') return 'tests'
  return undefined
}

const STOP_WORDS = new Set(
  'about above after again also always another because been before being below between both but can cannot could does doing done down each even every from have having here into just like make many more most much must need only other over please same should since some such than that their them then there these they thing this those though through under until very want were what when where which while will with would your yours could the and for are not you all any how its our out use now get new let one two way may say see too yes'.split(' '),
)

/** The content words of a prompt (4+ letters, no stop words, lowercased). */
export function keywords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? []
  return new Set(words.filter(word => !STOP_WORDS.has(word)))
}

/** Overlap of two word sets (Jaccard); 1 for identical, 0 for disjoint. */
export function similarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const word of a) if (b.has(word)) shared += 1
  return shared / (a.size + b.size - shared)
}

const MIN_TOPIC_WORDS = 4
const TOPIC_SIMILARITY = 0.08

/** Whether a prompt starts a new topic: enough words of its own, and almost none shared with the recent prompts. */
export function isNewTopic(recent: readonly ReadonlySet<string>[], prompt: string): boolean {
  const words = keywords(prompt)
  if (recent.length === 0 || words.size < MIN_TOPIC_WORDS) return false
  const before = new Set(recent.flatMap(set => [...set]))
  return similarity(words, before) < TOPIC_SIMILARITY
}

export type MomentInput = {
  percent: number | undefined
  suggestAt: number
  milestone: Milestone | undefined
  /** All todos completed this turn (there were open ones before). */
  isTodoListDone: boolean
  isTopicChange: boolean
  /** Todos still open: a commit in the middle of a task list is not a boundary. */
  openTodos: number
  turn: number
  lastSuggestedTurn: number | undefined
  cooldownTurns: number
}

/** The reason this is a good moment to compact, or undefined. */
export function detectMoment(input: MomentInput): MomentReason | undefined {
  if (input.percent === undefined || input.percent < input.suggestAt) return undefined
  if (input.lastSuggestedTurn !== undefined && input.turn - input.lastSuggestedTurn < input.cooldownTurns) return undefined
  if (input.isTopicChange) return 'topic'
  if (input.isTodoListDone) return 'todos'
  if (input.openTodos > 0) return undefined
  return input.milestone
}
