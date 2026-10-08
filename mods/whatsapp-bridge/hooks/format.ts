import type { WaSessionInfo } from '../types'
import { oneLine } from './privacy'

export const minutes = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 60_000))
  return total < 60 ? `${total}m` : `${Math.floor(total / 60)}h${String(total % 60).padStart(2, '0')}`
}

export const clockTime = (ms: number): string => new Date(ms).toTimeString().slice(0, 5)

export const tagOf = (session: Pick<WaSessionInfo, 'label' | 'project'>): string => `#${session.label} · ${session.project}`

/** `status` from the phone: one block per live session. */
export const statusText = (sessions: readonly WaSessionInfo[], now: number, extra: string): string => {
  if (sessions.length === 0) return `🤖 No Claude Code session is running.${extra}`
  const lines = sessions.map(session => {
    const doing = session.state === 'working' ? `⚙️ working ${minutes(now - session.lastActiveAt)}: ${oneLine(session.task, 80)}` : '💤 idle'
    return `*${tagOf(session)}*${session.branch !== '' ? ` (${session.branch})` : ''}\n${doing}`
  })
  return `🤖 *Status*\n\n${lines.join('\n\n')}${extra}`
}

export const sessionsText = (sessions: readonly WaSessionInfo[], now: number): string =>
  sessions.length === 0
    ? '🤖 No live sessions.'
    : `🤖 *Sessions* (start a message with the tag to pick one)\n${sessions
        .map(session => `• *#${session.label}* — ${session.project}${session.branch !== '' ? ` @${session.branch}` : ''} · ${session.state} · seen ${minutes(now - session.lastSeen)} ago`)
        .join('\n')}`

export const costText = (sessions: readonly WaSessionInfo[], today: number): string => {
  const total = sessions.reduce((sum, session) => sum + session.costUsd, 0)
  const lines = sessions.map(session => `• #${session.label} (${session.project}): $${session.costUsd.toFixed(2)}`)
  return `💰 *Cost* — live sessions $${total.toFixed(2)}, today $${today.toFixed(2)}\n${lines.join('\n')}`
}

export type DigestItem = { at: number; text: string; session: string }

export const digestText = (items: readonly DigestItem[], parked: readonly DigestItem[], title = '🗞 *Digest*'): string => {
  const lines = [title]
  if (items.length > 0) lines.push('', ...items.slice(-25).map(item => `• ${clockTime(item.at)} ${item.session} — ${oneLine(item.text, 160)}`))
  if (parked.length > 0) {
    lines.push('', '🅿️ *Questions Claude parked while you were unavailable:*', ...parked.map(item => `• ${item.session} — ${oneLine(item.text, 200)}`))
    lines.push('_Reply with #label and your answer to send it to that session._')
  }
  if (items.length === 0 && parked.length === 0) lines.push('', 'Nothing new.')
  return lines.join('\n')
}

/** The morning briefing / evening digest headline per session. */
export const briefingText = (kind: 'morning' | 'evening', sessions: readonly WaSessionInfo[], now: number): string => {
  const title = kind === 'morning' ? '☀️ *Good morning* — where things stand' : '🌙 *Evening digest*'
  const body = sessions.map(session => `• *${tagOf(session)}* — ${session.turns} prompts, ${session.state}${session.task !== '' ? `, last: ${oneLine(session.task, 70)}` : ''}`)
  return [title, ...body, body.length === 0 ? 'No session was active.' : '', `_${clockTime(now)}_`].filter(line => line !== '').join('\n')
}

const DOCKER_IMAGE = 'ghcr.io/rmyndharis/openwa:0.24'

/** What /wa setup prints when no OpenWA answers: a local-only container and the scoped-key steps. */
export const dockerSteps = (baseUrl: string): string =>
  [
    `No OpenWA server answered at ${baseUrl}. Start one bound to this machine only (never 0.0.0.0):`,
    '',
    '```',
    `docker run -d --name openwa --restart unless-stopped -p 127.0.0.1:2785:2785 \\`,
    `  -v openwa-data:/app/data -e ENGINE_TYPE=baileys -e AUTO_START_SESSIONS=true ${DOCKER_IMAGE}`,
    '```',
    'ENGINE_TYPE=baileys lets the mod create one WhatsApp group per project (group creation is Baileys-only in OpenWA).',
    'Prefer whatsapp-web.js (lower ban risk)? Drop that variable, create the groups yourself and use /wa link-project.',
    '',
    'Then run /wa setup again.',
  ].join('\n')

export const keySteps = (sessionId: string): string =>
  [
    'OpenWA is up. Give this mod a SCOPED operator key — never the admin key:',
    '',
    '```',
    'ADMIN=$(docker exec openwa cat /app/data/.api-key)',
    ...(sessionId === ''
      ? [
          '# create the WhatsApp session once and note its "id":',
          `curl -s -X POST http://127.0.0.1:2785/api/sessions -H "X-API-Key: $ADMIN" -H 'Content-Type: application/json' -d '{"name":"claude"}'`,
        ]
      : []),
    `curl -s -X POST http://127.0.0.1:2785/api/auth/api-keys -H "X-API-Key: $ADMIN" -H 'Content-Type: application/json' \\`,
    `  -d '{"name":"claude-code","role":"operator","allowedSessions":["${sessionId === '' ? '<session id>' : sessionId}"]}'`,
    '```',
    'Linking your own number instead of a bot number? Add "allowedChats":["<your number>@c.us","<group id>@g.us"] so',
    'the key itself can only touch those chats (then groups must be created by you and linked with /wa link-project).',
    '',
    'Paste the returned owa_k1_… key in the /wa pane (Privacy tab), or set it in the plugin options (apiKey),',
    'or export OPENWA_API_KEY. `/wa key <key>` works too, but the key then shows in the transcript.',
  ].join('\n')

/** The system prompt section, one fixed text per interaction mode so the prompt cache holds. */
export const composeSection = (isInteractive: boolean): string =>
  isInteractive
    ? [
        'WhatsApp bridge: the user can be reached on their phone. ',
        'Use ask only when you are blocked on a decision only the user can make (it waits for their reply); ',
        'use mcp__whatsapp-bridge__notify for a long job that finished or failed, never for routine progress. ',
        'Never send file contents or diffs unless the user asked. Messages are redacted and rate-limited: keep them short.',
      ].join('')
    : [
        'WhatsApp bridge: the user is NOT available for questions right now (interaction is off: night or silent mode). ',
        'Do not plan on asking them: when a decision is needed, proceed with your best judgement and state the assumption, ',
        'or park the question with mcp__whatsapp-bridge__ask (it returns at once and is delivered later). ',
        'mcp__whatsapp-bridge__notify still reaches them for failures and results they enabled; keep it rare.',
      ].join('')

/** A Bash command that runs a test suite. */
export const TEST_COMMAND = /(?:^|[;&|]\s*|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:pytest|vitest|jest|mocha|phpunit|rspec)\b|\b(?:go|cargo|deno|dotnet|mix|swift)\s+test\b|\bmake\s+(?:test|check)\b|\bgradlew?\s+test\b|\bmvn\s+(?:-\S+\s+)*test\b/

export const PUSH_COMMAND = /\bgit\s+push\b/
