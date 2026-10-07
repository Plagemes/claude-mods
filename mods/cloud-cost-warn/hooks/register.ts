import type { PromptOrigin, Register } from 'claude-code'

import { findExpensive, HOURS_PER_MONTH, largeThreshold, money } from './cost'
import type { Estimate } from './cost'

const APPROVAL = /(?<![\w-])COST-OK(?![\w-])/
const CLOUD_WORDS = /\b(?:aws|gcloud|az|eksctl)\b/
const CREATE_WORDS = /\b(?:run-instances|create-db-instance|create-cluster|create|vm|aks)\b/

/** Words the person typed (or sent from a phone or the SDK); never a notification, peer or tool output. */
function isFromPerson(origin: PromptOrigin): boolean {
  return ['composer', 'bridge', 'sdk', 'slack-ping'].includes(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)
}

function refusal({ command, what, low, high, tip }: Estimate): string {
  return (
    `cloud-cost-warn: "${command}" would create ${what}, roughly ${money(low)}-${money(high)} per hour ` +
    `(about ${money(low * HOURS_PER_MONTH)}-${money(high * HOURS_PER_MONTH)} a month) until it is deleted. ` +
    `Cheaper: ${tip}. Blocked until the user's latest message contains COST-OK. Ask them to confirm and add it, and delete the resource when done.`
  )
}

export const register: Register = (on, options) => {
  const large = largeThreshold(String(options.largeSize ?? ''))
  let latestPrompt = ''

  // Set before `next`: the turn the prompt starts may call a tool before `next` resolves.
  on('prompt.submit', async ($, e, next) => {
    const previous = latestPrompt
    if (isFromPerson(e.origin)) latestPrompt = e.text
    // A turn nobody typed (a notification, a schedule, a peer) starts without the approval of an earlier prompt.
    else if (e.turnId === undefined) latestPrompt = ''
    const result = await next(e)
    if (result.drop !== undefined) latestPrompt = previous
    return result
  }).catch(($, e, next) => {
    latestPrompt = ''
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    if (APPROVAL.test(latestPrompt)) return next(e)
    const [first] = findExpensive(e.command, large)
    return first === undefined ? next(e) : { deny: refusal(first) }
  }).catch(($, e, next) =>
    next.called || !CLOUD_WORDS.test(e.command) || !CREATE_WORDS.test(e.command)
      ? next(e)
      : { deny: 'cloud-cost-warn: its check failed, so the cloud command was blocked.' },
  )
}
