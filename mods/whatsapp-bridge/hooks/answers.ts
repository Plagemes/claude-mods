import { reactionMeaning } from './commands'

export const MAX_OPTIONS = 12

/** A question waiting for the owner's answer: Claude's `ask`, a phone prompt to confirm, a permission, a preview. */
export type Pending = {
  id: string
  kind: 'ask' | 'confirm' | 'permission' | 'preview' | 'bug' | 'alert'
  question: string
  options: string[]
  chatId: string
  messageId: string
  createdAt: number
  expiresAt: number
  /** For a confirm: the prompt to run; for a bug draft: the issue; for an alert: what to retry. */
  payload?: string
}

export type Answer = { text: string; choice?: number; verdict?: 'approve' | 'reject' }

const YES = new Set(['yes', 'y', 'ok', 'okay', 'sì', 'si', 'certo', 'vai', 'go', 'approve', 'approva', 'confirm', 'conferma', 'allow', 'consenti', '1'])
const NO = new Set(['no', 'n', 'nope', 'reject', 'rifiuta', 'deny', 'nega', 'annulla', 'cancel', 'stop', '2'])

const plain = (text: string): string =>
  text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/u, '')
    .replace(/^(?:option|opzione|choice|scelta|n[.°]|#)\s*(?=\d)/u, '')

/** Whether a pending question's options are a yes/no pair, so 👍 / ❌ / "sì" / "no" choose between them. */
export const isYesNo = (options: readonly string[]): boolean =>
  options.length === 2 && YES.has(plain(options[0] ?? '')) && NO.has(plain(options[1] ?? ''))

/** The options shown to the owner: theirs, or Yes / No for a question with none. */
export const optionsFor = (options: readonly string[] | undefined): string[] =>
  (options ?? [])
    .map(option => option.trim())
    .filter(option => option !== '')
    .slice(0, MAX_OPTIONS)

/**
 * Reads the owner's reply (text or reaction) as an answer to a pending question: a number picks an option,
 * an option's text (or a unique start of it) picks it, yes/no words and 👍/❌ answer a yes/no question or
 * approve/reject, and any other text is a free answer. A reaction that means nothing here is no answer.
 */
export const matchAnswer = (pending: Pending, reply: { text?: string; emoji?: string }): Answer | null => {
  const yesNo = pending.options.length === 0 || isYesNo(pending.options)
  if (reply.emoji !== undefined) {
    const meaning = reactionMeaning(reply.emoji)
    if (meaning !== 'approve' && meaning !== 'reject') return null
    if (pending.options.length > 0 && !yesNo) return null
    const choice = meaning === 'approve' ? 0 : 1
    return { text: pending.options[choice] ?? (meaning === 'approve' ? 'yes' : 'no'), choice: pending.options.length > 0 ? choice : undefined, verdict: meaning }
  }
  const text = (reply.text ?? '').trim()
  if (text === '') return null
  const word = plain(text)
  if (pending.options.length > 0) {
    const number = Number(word)
    if (Number.isInteger(number) && number >= 1 && number <= pending.options.length) {
      return { text: pending.options[number - 1] ?? '', choice: number - 1, verdict: yesNo ? (number === 1 ? 'approve' : 'reject') : undefined }
    }
    const exact = pending.options.findIndex(option => plain(option) === word)
    if (exact >= 0) return { text: pending.options[exact] ?? '', choice: exact, verdict: yesNo ? (exact === 0 ? 'approve' : 'reject') : undefined }
    const starts = pending.options.map((option, index) => ({ option, index })).filter(({ option }) => word.length >= 3 && plain(option).startsWith(word))
    if (starts.length === 1 && starts[0] !== undefined) return { text: starts[0].option, choice: starts[0].index }
  }
  if (yesNo && YES.has(word)) return { text: pending.options[0] ?? 'yes', choice: pending.options.length > 0 ? 0 : undefined, verdict: 'approve' }
  if (yesNo && NO.has(word)) return { text: pending.options[1] ?? 'no', choice: pending.options.length > 0 ? 1 : undefined, verdict: 'reject' }
  return { text }
}

/** The question as the phone shows it: numbered options and how to answer. */
export const questionText = (question: string, options: readonly string[], who: string): string => {
  const lines = [`❓ *${who}* asks:`, question.trim()]
  if (options.length > 0) {
    lines.push('', ...options.map((option, index) => `*${index + 1}.* ${option}`))
    lines.push('', isYesNo(options) ? '_Reply 1/2, sì/no, or react 👍 / ❌._' : '_Reply with a number or your own words._')
  } else {
    lines.push('', '_Reply to this message with your answer (👍 / ❌ for yes / no)._')
  }
  return lines.join('\n')
}

/** Which pending question a reply answers: the quoted one, else the newest in that chat. */
export const pendingFor = (pending: readonly Pending[], chatId: string, quotedId: string | undefined, now: number): Pending | undefined => {
  const open = pending.filter(item => item.expiresAt > now)
  if (quotedId !== undefined) {
    const quoted = open.find(item => item.messageId === quotedId)
    if (quoted !== undefined) return quoted
  }
  return open.filter(item => item.chatId === chatId && item.kind !== 'alert' && item.kind !== 'preview').sort((a, b) => b.createdAt - a.createdAt)[0]
}
