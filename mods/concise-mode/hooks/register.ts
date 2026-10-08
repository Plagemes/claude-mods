import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const STATUS = 'concise'

const BREVITY =
  'Concise mode is on. Keep every answer as short as the task allows: lead with the answer or the result, ' +
  'skip preambles, restating the question, recaps and filler, and prefer one sentence over three. ' +
  'Use code or a short list only when it is clearer than prose. ' +
  'Never cut what the user needs to act safely: still name every file you changed, and any risk or decision they must make.'

export const register: Register = (on, options) => {
  const isOn = atom({ plugin: 'concise-mode', key: 'isOn' } as const, options.startOn === true)

  on('session.start', async ($, e, next) => {
    await registerCommand($, {
      name: 'concise',
      description: 'Toggles short, to-the-point answers.',
      argumentHint: '[on|off]',
    })
    $.ui.status((await read($, isOn)) ? STATUS : undefined)
    return next(e)
  })

  on('command.run', { command: 'concise' }, async ($, e) => {
    const asked = e.args.trim().toLowerCase()
    const now = await update($, isOn, was => (asked === 'on' ? true : asked === 'off' ? false : !was))
    $.ui.status(now ? STATUS : undefined)

    return {
      text: now
        ? 'concise-mode: on. Answers will be short and to the point. Type /concise again to turn it off.'
        : 'concise-mode: off. Answers are back to their usual length.',
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (e.traits.includes('bare') || !(await read($, isOn))) return composed

    return { sections: [...composed.sections, { id: 'concise-mode:brevity', text: BREVITY, scope: 'session' }] }
  })
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
