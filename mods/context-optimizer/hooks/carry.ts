/**
 * The carry-over: what must survive a compaction (decisions, open todos, files in play, the last test run), the
 * focus handed to /compact, and the note given back to Claude afterwards. Pure: no `$`, no I/O.
 */

export type CarryOver = {
  at: number
  /** The turn it was taken at. */
  turn: number
  decisions: string[]
  todos: string[]
  files: string[]
  tests?: string
  branch?: string
}

const MAX_DECISIONS = 6
const MAX_TODOS = 8
const MAX_FILES = 10
const MAX_ITEM = 160
const MAX_FOCUS = 600
/** A sentence of a prompt that settles something. */
const DECISION = /\b(?:let'?s|we(?:'ll| will| should| decided)|decided?|go with|stick (?:to|with)|use \S+ (?:instead|rather)|instead of|don'?t|do not|never|always|must(?:n'?t)?|prefer|keep (?:it|the|using)|switch to|from now on)\b/i

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Sentences of a prompt that read as decisions or standing instructions. */
export function decisionsIn(prompt: string): string[] {
  return prompt
    .split(/(?<=[.!?])\s+|\n+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length >= 12 && DECISION.test(sentence))
    .map(sentence => clip(sentence, MAX_ITEM))
}

/** Adds items to a recent-first list, without repeats, keeping at most `max`. */
export function remember(list: readonly string[], items: readonly string[], max: number): string[] {
  const added = items.filter(item => item !== '')
  return [...added.reverse(), ...list.filter(item => !added.includes(item))].slice(0, max)
}

export function makeCarry(input: Omit<CarryOver, 'decisions' | 'todos' | 'files'> & { decisions: readonly string[]; todos: readonly string[]; files: readonly string[] }): CarryOver {
  return {
    ...input,
    decisions: input.decisions.slice(0, MAX_DECISIONS).map(item => clip(item, MAX_ITEM)),
    todos: input.todos.slice(0, MAX_TODOS).map(item => clip(item, MAX_ITEM)),
    files: input.files.slice(0, MAX_FILES),
  }
}

export const isEmptyCarry = (carry: CarryOver): boolean =>
  carry.decisions.length === 0 && carry.todos.length === 0 && carry.files.length === 0 && carry.tests === undefined

/** The focus for `/compact <focus>`: what the summary must keep. */
export function focusOf(carry: CarryOver): string {
  const parts = [
    carry.decisions.length > 0 ? `the decisions (${carry.decisions.slice(0, 3).join('; ')})` : '',
    carry.todos.length > 0 ? `the open todos (${carry.todos.slice(0, 4).join('; ')})` : '',
    carry.files.length > 0 ? `the files in play (${carry.files.slice(0, 6).join(', ')})` : '',
  ].filter(part => part !== '')
  return clip(parts.length === 0 ? 'Keep the current task, what is done and what is next.' : `Keep ${parts.join(', ')}.`, MAX_FOCUS)
}

/** What is added to the compaction's instructions so the summary keeps the carry-over. */
export const compactInstructions = (carry: CarryOver): string =>
  `context-optimizer: the summary must keep these verbatim where they still apply.\n${carryLines(carry).join('\n')}`

function carryLines(carry: CarryOver): string[] {
  return [
    carry.decisions.length > 0 ? `- Decisions: ${carry.decisions.join(' | ')}` : '',
    carry.todos.length > 0 ? `- Open todos: ${carry.todos.join(' | ')}` : '',
    carry.files.length > 0 ? `- Files in play: ${carry.files.join(', ')}` : '',
    carry.tests === undefined ? '' : `- Last test run: ${carry.tests}`,
    carry.branch === undefined ? '' : `- Branch: ${carry.branch}`,
  ].filter(line => line !== '')
}

/** The note Claude reads with the first prompt after the compaction. */
export const carryText = (carry: CarryOver): string =>
  [`[context-optimizer] Carry-over saved before the conversation was compacted (turn ${carry.turn}); it still applies unless the user says otherwise:`, ...carryLines(carry)].join('\n')

/** Paths shown relative to the project root when inside it. */
export const relativeTo = (root: string, path: string): string => (root !== '' && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path)
