import type { Register } from 'claude-code'

/** Prompts typed by a person, as opposed to notifications, scheduled runs and other plugins. */
const PERSON_ORIGINS: readonly string[] = ['composer', 'bridge']
const TOAST_MS = 7000
const SHORT_PROMPT_WORDS = 3
const BROKEN_REPORT_WORDS = 8
const SHORT_PROMPT_CHARS = 12

/** A prompt for a built-in mode (slash command, `!` shell, `#` memory), which is not a request to lint. */
const NOT_A_REQUEST = /^\s*[/!#]/
const LATIN_ONLY = /^[\u0000-ɏ]*$/

/** Signs that the prompt names something: a file, path, identifier, number, link, quote or @mention. */
const NAMES_A_TARGET = /[\w-]+\.[a-z]{1,5}\b|[\\/]\S|`[^`]+`|[a-z][A-Z]|\w_\w|@\S|#\d|https?:|"[^"]+"|\d/
const BROKEN_REPORT =
  /\b(doesn'?t|does not|don'?t|do not|isn'?t|is not|won'?t|still not|not) (work|working|works)\b|\b(still )?(broken|failing|crash(es|ing)?)\b/
const VAGUE_FIX =
  /^(please )?(can you |could you )?(fix|solve|debug|improve|update|change|check|handle|finish|redo) (it|this|that|them|these|those|everything|things?|stuff)( (up|now|please|again))?$/

const ACTION_VERBS = new Set([
  'fix', 'add', 'update', 'change', 'refactor', 'improve', 'implement', 'write', 'make', 'optimize', 'optimise',
  'clean', 'rewrite', 'remove', 'delete', 'rename', 'debug', 'handle', 'finish', 'build', 'create',
])
const PRONOUN_WORDS = new Set([
  'it', 'this', 'that', 'them', 'these', 'those', 'there', 'here', 'the', 'a', 'please', 'pls', 'now', 'again',
  'too', 'also', 'and', 'then', 'just', 'so', 'one', 'thing', 'things', 'stuff', 'something', 'anything', 'everything',
])
/** Short replies and one-word commands that are complete requests on their own. */
const COMPLETE_SHORT_PROMPTS = new Set([
  'yes', 'no', 'ok', 'okay', 'y', 'n', 'yep', 'nope', 'sure', 'thanks', 'thank you', 'thx', 'continue', 'go', 'go on',
  'go ahead', 'proceed', 'stop', 'cancel', 'done', 'next', 'retry', 'again', 'undo', 'revert', 'commit', 'push', 'test',
  'tests', 'build', 'lint', 'status', 'diff', 'lgtm', 'great', 'nice', 'cool', 'perfect', 'good', 'fine', 'right',
  'correct', 'exactly',
])

/** The tip for the first way a prompt looks vague; undefined when it looks specific enough. */
const tipFor = (text: string): string | undefined => {
  if (NOT_A_REQUEST.test(text) || !LATIN_ONLY.test(text)) return undefined

  const plain = text.toLowerCase().replace(/[.!,]+/g, ' ').replace(/\s+/g, ' ').trim()
  const words = plain.match(/[a-z0-9']+/g) ?? []
  const hasTarget = NAMES_A_TARGET.test(text)
  const isQuestion = text.trim().endsWith('?')

  if (words.length <= BROKEN_REPORT_WORDS && BROKEN_REPORT.test(plain) && !hasTarget) {
    return 'Say what happened versus what you expected, and paste the exact error.'
  }
  if (VAGUE_FIX.test(plain.replace(/\?$/, ''))) {
    return 'Say what to change and where: a file, a function or an error message.'
  }
  if (words.length > 0 && words.every(word => PRONOUN_WORDS.has(word))) {
    return 'Name what you mean: a file, a function, an error or a ticket.'
  }
  if (words.length <= SHORT_PROMPT_WORDS && ACTION_VERBS.has(words[0] ?? '') && !hasTarget) {
    return 'Name the file, function or ticket you mean.'
  }
  const isTinyAndUnclear =
    words.length <= 2 && plain.length < SHORT_PROMPT_CHARS && !hasTarget && !isQuestion && !COMPLETE_SHORT_PROMPTS.has(plain)
  return isTinyAndUnclear ? 'Add the goal and any constraint, so Claude does not have to guess.' : undefined
}

export const register: Register = (on, options) => {
  const isStrict = options.strict === true
  let heldBack: string | undefined

  on('prompt.submit', async ($, e, next) => {
    const isOrdinary =
      PERSON_ORIGINS.includes(e.origin.kind) && e.turnId === undefined && (e.attachments?.length ?? 0) === 0
    const tip = isOrdinary ? tipFor(e.text) : undefined
    if (tip === undefined) return next(e)

    if (!isStrict) {
      $.ui.toast(tip, { timeoutMs: TOAST_MS })
      return next(e)
    }

    if (heldBack === e.text) {
      heldBack = undefined
      return next(e)
    }
    heldBack = e.text
    return { drop: `prompt-lint: this prompt looks vague. ${tip} Send it again unchanged to go ahead anyway.` }
  })
}
