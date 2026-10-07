import type { Register } from 'claude-code'

import { answer } from './cheat'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cheat',
      description: 'Quick reference for git, docker, regex, tmux, vim, bash, sql, curl, kubectl and npm',
      argumentHint: '[topic] [words to filter by]',
    })
    return next(e)
  })

  on('command.run', { command: 'cheat' }, ($, e) => ({ text: answer(e.args) }))
}
