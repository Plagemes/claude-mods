import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import { findRisks, type Risk } from './risks'
import { parseShell } from './shell'

const APPROVAL = /(?<![\w-])PROD-OK(?![\w-])/
const DEFAULT_PROD = /(^|[-_./:=\s])(prod|production|prd|live)([-_./:=\s]|$)/i
const KUBECTL_TIMEOUT_MS = 3000

/** Words the person typed (or sent from a phone or the SDK); never a notification, peer or tool output. */
function isFromPerson(origin: PromptOrigin): boolean {
  return ['composer', 'bridge', 'sdk', 'slack-ping'].includes(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)
}

function compile(source: string): RegExp {
  try {
    return source.trim() === '' ? DEFAULT_PROD : new RegExp(source, 'i')
  } catch {
    return DEFAULT_PROD
  }
}

async function currentKubeContext($: EngineInterface): Promise<string | undefined> {
  try {
    const { exitCode, stdout } = await $.process.run(['kubectl', 'config', 'current-context'], { timeoutMs: KUBECTL_TIMEOUT_MS })
    return exitCode === 0 ? stdout.trim() : undefined
  } catch {
    return undefined
  }
}

/** Keeps the risks that really are production: resolves "the current context" where it matters. */
async function confirmedRisks($: EngineInterface, risks: readonly Risk[], isProd: (text: string) => boolean): Promise<Risk[]> {
  const confirmed: Risk[] = []
  for (const risk of risks) {
    if (!risk.needsKubeContext) {
      confirmed.push(risk)
      continue
    }
    const context = await currentKubeContext($)
    if (context !== undefined && isProd(context)) confirmed.push({ what: `${risk.what} ("${context}")` })
  }
  return confirmed
}

export const register: Register = (on, options) => {
  const prodPattern = compile(String(options.prodPattern ?? ''))
  const isProd = (text: string) => prodPattern.test(text)
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

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (APPROVAL.test(latestPrompt)) return next(e)

    const risks = await confirmedRisks($, findRisks(e.command, parseShell(e.command), isProd), isProd)
    const first = risks[0]
    if (first === undefined) return next(e)

    return {
      deny: `prod-guard: ${first.what} can change production. Blocked until the user's latest message contains PROD-OK. Ask them to confirm and add it.`,
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'prod-guard: its check failed, so the command was blocked.' }))
}
