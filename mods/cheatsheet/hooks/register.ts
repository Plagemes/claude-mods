import type { EngineInterface, Register } from 'claude-code'

import { answer } from './cheat'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await registerCommand($, {
      name: 'cheat',
      description: 'Quick reference for git, docker, regex, tmux, vim, bash, sql, curl, kubectl and npm',
      argumentHint: '[topic] [words to filter by]',
    })
    return next(e)
  })

  on('command.run', { command: 'cheat' }, ($, e) => ({ text: answer(e.args) }))
}

/** Registers a slash command. A refused name (Claude Code's own, or another mod's) is reported as a notice, never thrown, so the rest of session.start still runs. */
async function registerCommand($: EngineInterface, spec: Parameters<EngineInterface['command']['register']>[0]): Promise<boolean> {
  try {
    await $.command.register(spec)
    return true
  } catch (error) {
    $.ui.log(`${$.plugin.name}: /${spec.name} was not registered (${error instanceof Error ? error.message : String(error)}).`)
    return false
  }
}
