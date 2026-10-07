import type { PromptOrigin, Register } from 'claude-code'

import { findRisks } from './prune'

const APPROVAL = /(?<![\w-])PRUNE-OK(?![\w-])/
const CONTAINER_WORDS = /\b(?:docker|podman)(?:-compose)?\b/
const DELETE_WORDS = /\b(?:prune|volume|down|rm)\b/

/** Words the person typed (or sent from a phone or the SDK); never a notification, peer or tool output. */
function isFromPerson(origin: PromptOrigin): boolean {
  return ['composer', 'bridge', 'sdk', 'slack-ping'].includes(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)
}

export const register: Register = on => {
  let latestPrompt = ''

  // Set before `next`: the turn the prompt starts may call a tool before `next` resolves.
  on('prompt.submit', async ($, e, next) => {
    const previous = latestPrompt
    if (isFromPerson(e.origin)) latestPrompt = e.text
    const result = await next(e)
    if (result.drop !== undefined) latestPrompt = previous
    return result
  }).catch(($, e, next) => {
    latestPrompt = ''
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    if (APPROVAL.test(latestPrompt)) return next(e)

    const [risk, ...others] = findRisks(e.command)
    if (risk === undefined) return next(e)

    const more = others.length === 0 ? '' : ` (${others.length} more risky command${others.length === 1 ? '' : 's'} in this line)`
    return {
      deny:
        `docker-prune-guard: "${risk.command}" would delete ${risk.lost}${more}. Safer: ${risk.instead}. ` +
        `Blocked until the user's latest message contains PRUNE-OK. Ask them to confirm and add it.`,
    }
  }).catch(($, e, next) =>
    next.called || !CONTAINER_WORDS.test(e.command) || !DELETE_WORDS.test(e.command)
      ? next(e)
      : { deny: 'docker-prune-guard: its check failed, so the command was blocked.' },
  )
}
