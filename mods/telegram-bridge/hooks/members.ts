const WINDOW_MS = 10 * 60_000
const DAY_MS = 24 * 60 * 60_000

export type Trigger = { isTriggered: boolean; text: string }

/**
 * Whether a group member's message is meant for Claude: it mentions the bot, replies to the bot, or starts
 * with one of the trigger words (`?`, `claude`). Human chatter is left alone.
 */
export const memberTrigger = (
  raw: string,
  input: { triggers: readonly string[]; botName: string; isReplyToBot: boolean },
): Trigger => {
  let text = raw.trim()
  const mention = input.botName !== '' ? new RegExp(`@${input.botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') : null
  if (mention !== null && mention.test(text)) return { isTriggered: true, text: text.replace(mention, '').trim() }
  const lower = text.toLowerCase()
  for (const trigger of input.triggers) {
    if (trigger === '') continue
    const isWord = /^[\p{L}\p{N}]+$/u.test(trigger)
    if (lower.startsWith(trigger) && (!isWord || !/[\p{L}\p{N}]/u.test(lower.charAt(trigger.length)))) {
      text = text.slice(trigger.length).replace(/^[\s,:!?-]+/u, '').trim()
      return { isTriggered: text !== '', text }
    }
  }
  return { isTriggered: input.isReplyToBot && text !== '', text }
}

export type RateBook = { times: Record<string, number[]>; day: string; dayCount: number }

export const emptyBook = (): RateBook => ({ times: {}, day: '', dayCount: 0 })

/**
 * Counts one member question against the limits (`perTenMinutes` per member, `dailyCap` for all members):
 * the updated book, and whether the question may be answered.
 */
export const takeQuota = (
  book: RateBook,
  member: string,
  now: number,
  day: string,
  limits: { perTenMinutes: number; dailyCap: number },
): { isAllowed: boolean; book: RateBook; why?: string } => {
  const dayCount = book.day === day ? book.dayCount : 0
  const times = Object.fromEntries(
    Object.entries(book.times)
      .map(([who, list]) => [who, list.filter(at => now - at < DAY_MS)] as const)
      .filter(([, list]) => list.length > 0),
  )
  const recent = (times[member] ?? []).filter(at => now - at < WINDOW_MS)
  if (dayCount >= limits.dailyCap) return { isAllowed: false, book: { times, day, dayCount }, why: 'the daily limit for member questions is reached' }
  if (recent.length >= limits.perTenMinutes) return { isAllowed: false, book: { times, day, dayCount }, why: 'too many questions in ten minutes' }
  return { isAllowed: true, book: { times: { ...times, [member]: [...(times[member] ?? []), now] }, day, dayCount: dayCount + 1 } }
}

/** The instructions a member's question is answered under: status only, no commands, nothing private. */
export const memberPrompt = (question: string, member: string, platform: string, shareCode: boolean): string =>
  [
    `A member of the project's ${platform} chat (${member}, not the owner) asks: """${question.slice(0, 1_000)}"""`,
    'Answer them in at most 5 short lines, plain text, in the language they wrote in, about the state of this work',
    '(what is done, what is in progress, what is next) based only on this conversation.',
    'Do not reveal costs, budgets, token counts, secrets, credentials, environment or config values, or file paths outside the repository.',
    shareCode ? 'Short code snippets are allowed when they help.' : 'Do not include code.',
    'You cannot run tools or change anything for them; if they ask for an action, say the owner has to ask for it.',
    'If you do not know, say so briefly.',
  ].join(' ')
