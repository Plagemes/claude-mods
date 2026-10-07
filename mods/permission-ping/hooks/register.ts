import type { EngineInterface, Register } from 'claude-code'

const PING_SOUND = { asset: 'assets/ping.wav' } as const
// The permission dialog raises PermissionRequest and Notification together; one ping per request.
const SAME_REQUEST_MS = 2000
const MAX_DETAIL_LENGTH = 60

type Pinger = { isSoundOn: boolean; isToastOn: boolean; lastPingAt: number }

const describeInput = (input: unknown): string => {
  if (typeof input !== 'object' || input === null) return ''
  const fields = input as Record<string, unknown>
  const detail = [fields.command, fields.file_path, fields.url, fields.pattern].find(
    (value): value is string => typeof value === 'string' && value !== '',
  )
  if (detail === undefined) return ''
  const oneLine = detail.replace(/\s+/g, ' ').trim()
  return oneLine.length > MAX_DETAIL_LENGTH ? `${oneLine.slice(0, MAX_DETAIL_LENGTH - 1)}…` : oneLine
}

const ping = async ($: EngineInterface, pinger: Pinger, message: string): Promise<void> => {
  const now = await $.clock.now()
  if (now - pinger.lastPingAt < SAME_REQUEST_MS) return
  pinger.lastPingAt = now

  if (pinger.isToastOn) $.ui.toast(message)
  // Not awaited: the call resolves when the clip ends, and the dialog must not wait for the chime.
  if (pinger.isSoundOn) $.audio.play(PING_SOUND).catch(() => undefined)
}

export const register: Register = (on, options) => {
  const pinger: Pinger = {
    isSoundOn: options.sound !== false,
    isToastOn: options.toast !== false,
    lastPingAt: Number.NEGATIVE_INFINITY,
  }

  // Raised when the permission dialog is about to open; skipped when another hook already answered it.
  on('classic.PermissionRequest', async ($, e, next) => {
    const answer = await next(e)
    if (answer.decision === undefined) {
      const detail = describeInput(e.tool_input)
      await ping($, pinger, `🔔 Approval needed: ${e.tool_name}${detail === '' ? '' : ` — ${detail}`}`)
    }
    return answer
  })

  // Fallback for hosts that only announce the dialog as a notification.
  on('classic.Notification', async ($, e, next) => {
    if (e.notification_type === 'permission_prompt') {
      await ping($, pinger, '🔔 Claude is waiting for your approval')
    }
    return next(e)
  })
}
