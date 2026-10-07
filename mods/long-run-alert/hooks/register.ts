import type { Register } from 'claude-code'

const DEFAULT_SECONDS = 60
const MAX_COMMAND_LENGTH = 60

const clip = (command: string): string => {
  const oneLine = command.replace(/\s+/g, ' ').trim()
  return oneLine.length > MAX_COMMAND_LENGTH ? `${oneLine.slice(0, MAX_COMMAND_LENGTH - 1)}…` : oneLine
}

const formatElapsed = (seconds: number): string =>
  seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60 === 0 ? '' : ` ${seconds % 60}s`}`

export const register: Register = (on, options) => {
  const seconds = typeof options.seconds === 'number' && options.seconds > 0 ? options.seconds : DEFAULT_SECONDS
  const isRepeating = options.repeat === true

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // A background command returns at once; the shell is not held up by it.
    if (e.run_in_background === true) return next(e)

    let alerts = 0
    const alert = () => {
      alerts += 1
      $.ui.toast(`⏱ still running (${formatElapsed(alerts * seconds)}): ${clip(e.command)}`)
    }
    const timer = isRepeating ? $.clock.every(seconds * 1000, alert) : $.clock.after(seconds * 1000, alert)
    next.signal.addEventListener('abort', () => timer.cancel(), { once: true })

    try {
      return await next(e)
    } finally {
      timer.cancel()
    }
  })
}
