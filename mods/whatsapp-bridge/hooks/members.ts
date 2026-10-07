const WINDOW_MS = 10 * 60_000
const DAY_MS = 24 * 60 * 60_000

/** The digits of a WhatsApp id (`39333…@c.us` → `39333…`); privacy ids (`@lid`) have none worth comparing. */
export const phoneOf = (waId: string | null | undefined): string => {
  if (typeof waId !== 'string' || waId.endsWith('@lid') || waId.endsWith('@g.us')) return ''
  return waId.split('@')[0]?.split(':')[0]?.replace(/\D/g, '') ?? ''
}

/** Whether a phone (digits) is one of the owner's: equal, or one ends with the other (a missing country code). */
export const isOwnerPhone = (phone: string, owners: readonly string[]): boolean =>
  phone.length >= 6 && owners.some(owner => owner === phone || (owner.length >= 8 && phone.length >= 8 && (owner.endsWith(phone) || phone.endsWith(owner))))

export type Trigger = { isTriggered: boolean; isBug: boolean; text: string }

/**
 * Whether a group member's message is meant for Claude: it mentions the bot, replies to the bot, starts with
 * one of the trigger words (`?`, `claude`), or is a bug report (`bug:` or 🐞). Human chatter is left alone.
 */
export const memberTrigger = (
  raw: string,
  input: { triggers: readonly string[]; botPhone: string; isReplyToBot: boolean },
): Trigger => {
  let text = raw.trim()
  const bug = /^(?:bug\s*[:\-–]|🐞)\s*/iu.exec(text) ?? (text.includes('🐞') ? /🐞\s*/u.exec(text) : null)
  if (bug !== null) return { isTriggered: true, isBug: true, text: text.replace(bug[0], '').trim() }
  const mention = input.botPhone !== '' ? new RegExp(`@\\+?${input.botPhone}\\b`) : null
  if (mention !== null && mention.test(text)) return { isTriggered: true, isBug: false, text: text.replace(mention, '').trim() }
  const lower = text.toLowerCase()
  for (const trigger of input.triggers) {
    if (trigger === '') continue
    const isWord = /^[\p{L}\p{N}]+$/u.test(trigger)
    if (lower.startsWith(trigger) && (!isWord || !/[\p{L}\p{N}]/u.test(lower.charAt(trigger.length)))) {
      text = text.slice(trigger.length).replace(/^[\s,:!?-]+/u, '').trim()
      return { isTriggered: text !== '', isBug: false, text }
    }
  }
  return { isTriggered: input.isReplyToBot && text !== '', isBug: false, text }
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
export const memberPrompt = (question: string, member: string, shareCode: boolean): string =>
  [
    `A member of the project's WhatsApp group (${member}, not the owner) asks: """${question.slice(0, 1_000)}"""`,
    'Answer them in at most 5 short lines, plain text, in the language they wrote in, about the state of this work',
    '(what is done, what is in progress, what is next) based only on this conversation.',
    'Do not reveal costs, budgets, token counts, secrets, credentials, environment or config values, or file paths outside the repository.',
    shareCode ? 'Short code snippets are allowed when they help.' : 'Do not include code.',
    'You cannot run tools or change anything for them; if they ask for an action, say the owner has to ask for it.',
    'If you do not know, say so briefly.',
  ].join(' ')

/** The prompt that drafts a GitHub issue from a member's bug report. */
export const bugPrompt = (report: string, project: string): string =>
  [
    `Draft a GitHub issue for the project "${project}" from this bug report sent by a team member on WhatsApp:`,
    `"""${report.slice(0, 2_000)}"""`,
    'Reply with exactly: a first line "TITLE: <concise title>", then a blank line, then a short Markdown body with',
    'sections Description, Steps to reproduce (if known), Expected / Actual. Do not invent details; no secrets.',
  ].join('\n')

/** Splits the model's draft into a title and a body. */
export const parseIssueDraft = (draft: string, fallbackTitle: string): { title: string; body: string } => {
  const match = /^\s*TITLE:\s*(.+)\s*$/im.exec(draft)
  const title = (match?.[1] ?? fallbackTitle).trim().slice(0, 120) || fallbackTitle.slice(0, 120)
  const body = (match === null ? draft : draft.replace(match[0], '')).trim()
  return { title, body }
}
