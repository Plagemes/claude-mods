export const MAX_OPTIONS = 9

/** A question waiting for the owner's answer: Claude's `ask`, a phone prompt to confirm, a permission prompt. */
export type Pending = {
  id: string
  kind: 'ask' | 'confirm' | 'permission'
  question: string
  options: string[]
  chatId: string
  /** The message that carries the question. */
  messageId: string
  createdAt: number
  expiresAt: number
  /** For a confirm: the prompt to run. */
  payload?: string
}

export type Answer = { text: string; choice?: number; verdict?: 'approve' | 'reject' }

const YES = new Set(['yes', 'y', 'ok', 'okay', 'sì', 'si', 'certo', 'vai', 'go', 'approve', 'approva', 'confirm', 'conferma', 'allow', 'consenti', 'run', 'esegui', '1'])
const NO = new Set(['no', 'n', 'nope', 'reject', 'rifiuta', 'deny', 'nega', 'annulla', 'cancel', 'stop', '2'])

const plain = (text: string): string =>
  text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/u, '')
    .replace(/^(?:option|opzione|choice|scelta|n[.°]|#)\s*(?=\d)/u, '')

/** Whether a pending question's options are a yes/no pair, so "sì" / "no" and ✅ / ❌ choose between them. */
export const isYesNo = (options: readonly string[]): boolean =>
  options.length === 2 && YES.has(plain(options[0] ?? '')) && NO.has(plain(options[1] ?? ''))

/** The options shown to the owner: theirs, trimmed and capped. */
export const optionsFor = (options: readonly string[] | undefined): string[] =>
  (options ?? [])
    .map(option => option.trim())
    .filter(option => option !== '')
    .slice(0, MAX_OPTIONS)

/** The answer option number `index` stands for. */
export const fromChoice = (pending: Pending, index: number): Answer | null => {
  const text = pending.options[index]
  if (text === undefined) return null
  return { text, choice: index, verdict: isYesNo(pending.options) ? (index === 0 ? 'approve' : 'reject') : undefined }
}

/**
 * Reads the owner's reply as an answer to a pending question: a number picks an option, an option's text (or a
 * unique start of it) picks it, yes/no words answer a yes/no question, and any other text is a free answer.
 */
export const matchAnswer = (pending: Pending, reply: { text: string }): Answer | null => {
  const yesNo = pending.options.length === 0 || isYesNo(pending.options)
  const text = reply.text.trim()
  if (text === '') return null
  const word = plain(text)
  if (pending.options.length > 0) {
    const number = Number(word)
    if (Number.isInteger(number) && number >= 1 && number <= pending.options.length) return fromChoice(pending, number - 1)
    const exact = pending.options.findIndex(option => plain(option) === word)
    if (exact >= 0) return fromChoice(pending, exact)
    const starts = pending.options.map((option, index) => ({ option, index })).filter(({ option }) => word.length >= 3 && plain(option).startsWith(word))
    if (starts.length === 1 && starts[0] !== undefined) return { text: starts[0].option, choice: starts[0].index }
  }
  if (yesNo && YES.has(word)) return { text: pending.options[0] ?? 'yes', choice: pending.options.length > 0 ? 0 : undefined, verdict: 'approve' }
  if (yesNo && NO.has(word)) return { text: pending.options[1] ?? 'no', choice: pending.options.length > 0 ? 1 : undefined, verdict: 'reject' }
  return { text }
}

const APPROVE_REACTIONS = new Set(['+1', 'thumbsup', 'white_check_mark', 'heavy_check_mark', 'ok_hand', '👍', '✅', '👌', '✔️'])
const REJECT_REACTIONS = new Set(['-1', 'thumbsdown', 'x', 'no_entry', 'negative_squared_cross_mark', '👎', '❌', '🚫'])
const KEYCAP_NAMES = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']

/** Which number key an emoji is (Unicode `3️⃣`, or a name like `three`), as an option index; -1 when it is none. */
const keycapIndex = (emoji: string, name: string): number => {
  const digit = /^([1-9])\uFE0F?\u20E3$/.exec(emoji)
  return digit !== null ? Number(digit[1]) - 1 : KEYCAP_NAMES.indexOf(name)
}

/**
 * Reads the owner's reaction (a Unicode emoji, or an emoji name) as an answer: a number keycap picks an option,
 * a thumbs-up or check approves and a thumbs-down or cross rejects a yes/no question. Anything else is no answer.
 */
export const reactionAnswer = (pending: Pending, emoji: string): Answer | null => {
  const name = (emoji.split('::')[0] ?? '').replace(/^:|:$/g, '')
  const keycap = keycapIndex(emoji, name)
  if (keycap >= 0 && keycap < pending.options.length) return fromChoice(pending, keycap)
  const yesNo = pending.options.length === 0 || isYesNo(pending.options)
  const verdict = APPROVE_REACTIONS.has(name) ? 'approve' : REJECT_REACTIONS.has(name) ? 'reject' : undefined
  if (verdict === undefined || !yesNo) return null
  const choice = verdict === 'approve' ? 0 : 1
  return { text: pending.options[choice] ?? (verdict === 'approve' ? 'yes' : 'no'), choice: pending.options.length > 0 ? choice : undefined, verdict }
}

const keycap = (n: number): string => `${n}\uFE0F\u20E3`

/** The reactions the bot adds to a question so the owner can just tap one: ✅ ❌ for yes/no, number keycaps for options. */
export const reactionHints = (options: readonly string[]): string[] =>
  isYesNo(options) ? ['✅', '❌'] : options.map((_, index) => keycap(index + 1))

/** The reactions worth reading on a question: the hints, and 👍 👎 for a yes/no. Free-text questions are answered by replying. */
export const reactionTargets = (pending: Pending): string[] =>
  isYesNo(pending.options) ? ['✅', '❌', '👍', '👎'] : pending.options.map((_, index) => keycap(index + 1))

/** The question as the channel shows it: numbered options, and how to answer. */
export const questionText = (question: string, options: readonly string[], who: string): string => {
  const lines = [`❓ *${who}* asks:`, question.trim()]
  if (options.length > 0) lines.push('', ...options.map((option, index) => `*${index + 1}.* ${option}`))
  lines.push('', isYesNo(options) ? '_Reply yes / no, or react ✅ / ❌._' : options.length > 0 ? '_Reply with a number, or react with its number._' : '_Reply here with your answer._')
  return lines.join('\n')
}

/** Which pending question a reply answers: the one it replies to, else the newest in that chat. */
export const pendingFor = (pending: readonly Pending[], chatId: string, replyToId: string | undefined, now: number): Pending | undefined => {
  const open = pending.filter(item => item.expiresAt > now)
  if (replyToId !== undefined) {
    const quoted = open.find(item => item.chatId === chatId && item.messageId === replyToId)
    if (quoted !== undefined) return quoted
  }
  return open.filter(item => item.chatId === chatId).sort((a, b) => b.createdAt - a.createdAt)[0]
}
