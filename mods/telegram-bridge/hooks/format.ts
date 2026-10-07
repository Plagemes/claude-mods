import type { BrSessionInfo } from '../types'
import { oneLine } from './privacy'

export const minutes = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 60_000))
  return total < 60 ? `${total}m` : `${Math.floor(total / 60)}h${String(total % 60).padStart(2, '0')}`
}

export const tagOf = (session: Pick<BrSessionInfo, 'label' | 'project'>): string => `#${session.label} · ${session.project}`

export const GLYPH: Record<string, string> = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '❌', critical: '🚨' }

/** The notice the hub hands a channel, as a message: glyph, where it comes from, the title and the details. */
export const noticeText = (notice: { level: string; source: string; title: string; body?: string; url?: string }, tag: string): string =>
  [`${GLYPH[notice.level] ?? 'ℹ️'} *${tag}* — ${notice.source}`, notice.title, notice.body ?? '', notice.url ?? ''].filter(line => line !== '').join('\n')

/** `status` from the phone: one block per live session. */
export const statusText = (sessions: readonly BrSessionInfo[], now: number, extra: string): string => {
  if (sessions.length === 0) return `🤖 No Claude Code session is running.${extra}`
  const lines = sessions.map(session => {
    const doing = session.state === 'working' ? `⚙️ working ${minutes(now - session.lastActiveAt)}: ${oneLine(session.task, 80)}` : '💤 idle'
    return `*${tagOf(session)}*${session.branch !== '' ? ` (${session.branch})` : ''}\n${doing}`
  })
  return `🤖 *Status*\n\n${lines.join('\n\n')}${extra}`
}

export const sessionsText = (sessions: readonly BrSessionInfo[], now: number): string =>
  sessions.length === 0
    ? '🤖 No live sessions.'
    : `🤖 *Sessions* (start a message with the tag to pick one)\n${sessions
        .map(session => `• *#${session.label}* — ${session.project}${session.branch !== '' ? ` @${session.branch}` : ''} · ${session.state} · seen ${minutes(now - session.lastSeen)} ago`)
        .join('\n')}`

export const costText = (sessions: readonly BrSessionInfo[]): string => {
  const total = sessions.reduce((sum, session) => sum + session.costUsd, 0)
  const lines = sessions.map(session => `• #${session.label} (${session.project}): $${session.costUsd.toFixed(2)}`)
  return `💰 *Cost* — live sessions $${total.toFixed(2)}\n${lines.join('\n')}`
}

/** The system prompt section, one fixed text per interaction state so the prompt cache holds. */
export const composeSection = (platform: string, toolPrefix: string, canAsk: boolean): string =>
  canAsk
    ? [
        `${platform} bridge: the user can be reached on their phone through the tools ${toolPrefix}notify, `,
        `${toolPrefix}ask, ${toolPrefix}send_file and ${toolPrefix}open_panel. `,
        'Use ask only when you are blocked on a decision only the user can make (it waits for their reply); ',
        'use notify when a long job finished or failed or something needs their attention; never for routine progress, ',
        'and never send file contents or diffs unless the user asked. Messages are redacted and rate-limited: keep them short.',
      ].join('')
    : [
        `${platform} bridge: the user is NOT available for questions right now (interaction is off: night, silent or away-only mode). `,
        'Do not plan on asking them: when a decision is needed, proceed with your best judgement and state the assumption. ',
        `${toolPrefix}ask returns at once while this lasts. ${toolPrefix}notify still reaches them for failures and results; keep it rare.`,
      ].join('')
