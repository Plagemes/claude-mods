import type { EngineInterface, Register } from 'claude-code'

import { addTrailers, mentionsCommit, missingFrom, parseCoAuthors, supportsCommitTrailer, trailerOf } from './trailers'

const GIT_TIMEOUT_MS = 5000

async function gitSupportsTrailers($: EngineInterface): Promise<boolean> {
  try {
    const { exitCode, stdout } = await $.process.run(['git', '--version'], { timeoutMs: GIT_TIMEOUT_MS })
    return exitCode === 0 && supportsCommitTrailer(stdout)
  } catch {
    return false
  }
}

export const register: Register = (on, options) => {
  const coAuthors = parseCoAuthors(String(options.coAuthors ?? ''))
  if (coAuthors.length === 0) return

  // What the model is told to put at the end of a commit message: ask for our trailers too.
  on('attribution.text', { kind: 'commit' }, async ($, e, next) => {
    const result = await next(e)
    const lines = missingFrom(result.text, coAuthors).map(trailerOf)
    return lines.length === 0 ? result : { ...result, text: [result.text, ...lines].filter(line => line !== '').join('\n') }
  })

  // The safety net: a commit command that still lacks them gets `--trailer` flags.
  let canUseTrailers: boolean | undefined
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!mentionsCommit(e.command)) return next(e)
    const missing = missingFrom(e.command, coAuthors)
    if (missing.length === 0) return next(e)

    const command = addTrailers(e.command, missing)
    if (command === e.command) return next(e)

    canUseTrailers ??= await gitSupportsTrailers($)
    return canUseTrailers ? next({ ...e, command }) : next(e)
  })
}
