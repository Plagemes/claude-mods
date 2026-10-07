import type { Register } from 'claude-code'

const CHIME = 'assets/chime.wav'
const DEFAULT_SECONDS = 20
const DEFAULT_VOLUME = 1
const MAX_VOLUME = 4

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

export const register: Register = (on, options) => {
  const thresholdMs = Math.max(0, numberOr(options.seconds, DEFAULT_SECONDS)) * 1000
  const gain = Math.min(MAX_VOLUME, Math.max(0, numberOr(options.volume, DEFAULT_VOLUME)))

  on('turn.complete', async ($, e, next) => {
    const isLongAnswer = e.agentId === undefined && e.reason === 'answer' && e.durationMs > thresholdMs

    if (isLongAnswer && gain > 0) {
      // From a timer, so the sound never holds up the end of the turn; a machine with no player just stays silent.
      $.clock.after(0, () => {
        $.audio.play({ asset: CHIME }, { gain }).catch(() => undefined)
      })
    }
    return next(e)
  })
}
