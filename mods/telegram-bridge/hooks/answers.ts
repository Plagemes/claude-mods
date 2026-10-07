export const MAX_OPTIONS = 8

/** A question waiting for the owner's answer: Claude's `ask`, a phone prompt to confirm, a permission prompt. */
export type Pending = {
  id: string
  kind: 'ask' | 'confirm' | 'permission'
  question: string
  options: string[]
  chatId: string
  /** The message that carries the question (and its buttons). */
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

/** Whether a pending question's options are a yes/no pair, so "sì" / "no" and the buttons choose between them. */
export const isYesNo = (options: readonly string[]): boolean =>
  options.length === 2 && YES.has(plain(options[0] ?? '')) && NO.has(plain(options[1] ?? ''))

/** The options shown to the owner: theirs, trimmed and capped. */
export const optionsFor = (options: readonly string[] | undefined): string[] =>
  (options ?? [])
    .map(option => option.trim())
    .filter(option => option !== '')
    .slice(0, MAX_OPTIONS)

/** The answer a tapped button stands for. */
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

/** The question as the chat shows it: the buttons carry the options, so only free-text questions say how to answer. */
export const questionText = (question: string, options: readonly string[], who: string): string => {
  const lines = [`❓ *${who}* asks:`, question.trim()]
  if (options.length === 0) lines.push('', '_Reply to this message with your answer._')
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

/** The button data of a pending question's option, and the way back. Telegram allows 64 bytes. */
export const callbackData = (pendingId: string, index: number): string => `q:${pendingId}:${index}`

export const parseCallback = (data: string): { pendingId: string; index: number } | null => {
  const match = /^q:([\w-]{1,40}):(\d{1,2})$/.exec(data)
  return match === null ? null : { pendingId: match[1] ?? '', index: Number(match[2]) }
}
