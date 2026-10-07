import type { Register } from 'claude-code'

const DEFAULT_MINUTES = 50
const DEFAULT_IDLE_MINUTES = 5
const MINUTE_MS = 60_000
const TICK_MS = 30_000
const TOAST_MS = 12_000
const CURSOR_KEY = 'cursor'

const REMINDERS = [
  '🧍 Stand up and stretch your legs.',
  '💧 Water break: refill your glass.',
  '👀 Look at something 20 feet away for 20 seconds.',
  '🚶 Take a short walk; Claude will keep the context warm.',
  '🫁 Roll your shoulders and take three slow breaths.',
  '🖐 Shake out your wrists and fingers.',
] as const

const positive = (value: unknown, fallback: number): number =>
  typeof value === 'number' && value > 0 ? value : fallback

export const register: Register = (on, options) => {
  const intervalMs = positive(options.minutes, DEFAULT_MINUTES) * MINUTE_MS
  const idleMs = positive(options.idleMinutes, DEFAULT_IDLE_MINUTES) * MINUTE_MS

  let activeMs = 0
  let lastTickAt = 0
  let lastActivityAt = Number.NEGATIVE_INFINITY
  let isTurnRunning = false
  let cursor = 0

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (!e.isInteractive) return started

    lastTickAt = await $.clock.now()
    try {
      const saved = await $.store.get(CURSOR_KEY)
      if (typeof saved === 'number') cursor = saved
    } catch {
      // The rotation simply starts over.
    }

    $.clock.every(TICK_MS, async () => {
      try {
        const now = await $.clock.now()
        // A long gap means the machine slept: do not count it as work.
        const elapsed = Math.min(now - lastTickAt, 2 * TICK_MS)
        lastTickAt = now
        if (!isTurnRunning && now - lastActivityAt > idleMs) return

        activeMs += elapsed
        if (activeMs < intervalMs) return
        const reminder = REMINDERS[cursor % REMINDERS.length]
        $.ui.toast(`${reminder} (${Math.round(activeMs / MINUTE_MS)} min of active work)`, { timeoutMs: TOAST_MS })
        activeMs = 0
        cursor += 1
        await $.store.set(CURSOR_KEY, cursor)
      } catch {
        // A missed tick costs nothing: the next one carries on.
      }
    })
    return started
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') lastActivityAt = await $.clock.now()
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    isTurnRunning = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnRunning = false
      lastActivityAt = await $.clock.now()
    }
    return next(e)
  })
}
