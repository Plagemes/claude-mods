import type { Register } from 'claude-code'

import { dangerIn } from './rules'
import { parseShell } from './shell'

export const register: Register = (on, options) => {
  const allowGitReset = options.allowGitReset === true

  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    // Whitespace is normalised so "rm   -rf  /" and "rm -rf /" read the same.
    const command = e.command.replace(/\\\n/g, ' ').replace(/[ \t]+/g, ' ').trim()
    const danger = dangerIn(command, parseShell(command), allowGitReset)

    return danger ? { deny: `rm-rf-guard: blocked, ${danger.what}. Instead: ${danger.instead}` } : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'rm-rf-guard: its check failed, so the command was blocked.' }))
}
