import type { Register } from 'claude-code'

import { BACKGROUND_ONLY, findNeverEnding } from './detect'
import type { Verdict } from './detect'

const MAX_COMMAND_LENGTH = 80

const compile = (source: string): RegExp | undefined => {
  try {
    return source === '' ? undefined : new RegExp(source)
  } catch {
    return undefined
  }
}

const refusal = ({ command, instead }: Verdict): string => {
  const shown = command.length > MAX_COMMAND_LENGTH ? `${command.slice(0, MAX_COMMAND_LENGTH - 1)}…` : command
  const keepRunning = instead === BACKGROUND_ONLY ? '' : ' To keep it running on purpose, start it with run_in_background: true.'
  return `watch-mode-guard: \`${shown}\` keeps running until it is stopped, so in the foreground it would hang this turn. ${instead}${keepRunning}`
}

export const register: Register = (on, options) => {
  const allow = compile(String(options.allow ?? ''))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.run_in_background === true || allow?.test(e.command) === true) return next(e)

    const ci = await $.env.get('CI')
    const verdict = findNeverEnding(e.command, ci !== undefined && ci !== '' && ci !== '0' && ci.toLowerCase() !== 'false')
    return verdict === undefined ? next(e) : { deny: refusal(verdict) }
  })
}
