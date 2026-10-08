import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ExplainLevelName } from '../types'

const LEVELS: readonly ExplainLevelName[] = ['eli5', 'normal', 'expert']

const CONFIRMATION: Record<ExplainLevelName, string> = {
  eli5: 'explain-level: eli5. Explanations will use plain words, small steps and everyday analogies.',
  normal: 'explain-level: normal. Explanations are back to their usual depth.',
  expert: 'explain-level: expert. Explanations will be dense and precise, with the basics skipped.',
}

const INSTRUCTION: Record<Exclude<ExplainLevelName, 'normal'>, string> = {
  eli5:
    'Explanation level: ELI5. When you explain something, write for a curious beginner: plain everyday words, ' +
    'small steps, and a short analogy where it helps. Define any technical term the first time you use it. ' +
    'Keep code, commands and file paths exact; only the explanation around them is simplified.',
  expert:
    'Explanation level: expert. When you explain something, write for an experienced engineer: skip basics and ' +
    'definitions, use precise terminology, and spend the words on trade-offs, edge cases, complexity, failure modes ' +
    'and internals. Be dense, and point to the relevant spec or source where that helps.',
}

export const register: Register = (on, options) => {
  const startLevel = LEVELS.find(level => level === options.startLevel) ?? 'normal'
  const level = atom({ plugin: 'explain-level', key: 'level' } as const, startLevel)

  const status = (current: ExplainLevelName): string | undefined =>
    current === 'normal' ? undefined : `explain: ${current}`

  on('session.start', async ($, e, next) => {
    await registerCommand($, { name: 'eli5', description: 'Explain things simply, in plain words with analogies.' })
    await registerCommand($, { name: 'normal', description: 'Explain things at the usual depth.' })
    await registerCommand($, { name: 'expert', description: 'Explain things densely and precisely, skipping the basics.' })
    $.ui.status(status(await read($, level)))
    return next(e)
  })

  on('command.run', { command: ['eli5', 'normal', 'expert'] }, async ($, e) => {
    const chosen = LEVELS.find(name => name === e.command) ?? 'normal'
    await update($, level, () => chosen)
    $.ui.status(status(chosen))
    return { text: CONFIRMATION[chosen] }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const current = await read($, level)
    if (current === 'normal' || e.traits.includes('bare')) return composed

    return { sections: [...composed.sections, { id: 'explain-level:depth', text: INSTRUCTION[current], scope: 'session' }] }
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
