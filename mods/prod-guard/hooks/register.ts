import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import { findRisks, type Risk } from './risks'
import { redactSummary } from './shared/secrets'

const APPROVAL = /(?<![\w-])PROD-OK(?![\w-])/
const DEFAULT_PROD = /(^|[-_./:=\s])(prod|production|prd|live)([-_./:=\s]|$)/i
const KUBECTL_TIMEOUT_MS = 3000
const MOD = 'prod-guard'
/** A production deploy another mod announced on mods-hub this recently is mentioned in a refusal. */
const RECENT_DEPLOY_MS = 30 * 60_000

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
    if (context !== undefined && isProd(context)) confirmed.push({ rule: risk.rule, what: `${risk.what} ("${context}")` })
  }
  return confirmed
}

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Says hello to mods-hub when it is installed. */
async function greetHub($: EngineInterface): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: ['risk.blocked'], consumes: ['deploy.started'] })
}

/**
 * A production deploy another mod (deploy-checklist, k8s-dry-run, terraform-plan-pane) announced on mods-hub
 * in the last half hour, as `target → environment`; undefined without the hub or when there is none.
 */
async function deployUnderway($: EngineInterface, isProd: (text: string) => boolean): Promise<string | undefined> {
  try {
    const event = await $.mods.latest({ topic: 'deploy.started' })
    if (event === null) return undefined
    const { target, environment } = event.data as { target?: unknown; environment?: unknown }
    if (typeof target !== 'string' || typeof environment !== 'string' || !(isProd(environment) || isProd(target))) return undefined
    return (await $.clock.now()) - event.at <= RECENT_DEPLOY_MS ? `${target} → ${environment}` : undefined
  } catch {
    return undefined
  }
}

/** Tells mods-hub (when installed) what was blocked, the command masked and cut short. The deny never waits on it. */
async function reportBlock($: EngineInterface, risk: Risk, command: string): Promise<void> {
  await hubPublish($, {
    topic: 'risk.blocked',
    data: { guard: MOD, tool: 'Bash', reason: `${risk.rule}: ${risk.what} can change production`, severity: 'high', command: redactSummary(command) },
  })
}

export const register: Register = (on, options) => {
  const prodPattern = compile(String(options.prodPattern ?? ''))
  const isProd = (text: string) => prodPattern.test(text)
  let latestPrompt = ''

  // Set before `next`: the turn the prompt starts may call a tool before `next` resolves.
  // A turn nobody typed (a notification, a schedule, a peer) starts unapproved: approval lasts one person's turn.
  on('prompt.submit', async ($, e, next) => {
    const previous = latestPrompt
    if (isFromPerson(e.origin)) latestPrompt = e.text
    else if (e.turnId === undefined) latestPrompt = ''
    const result = await next(e)
    if (result.drop !== undefined) latestPrompt = previous
    return result
  }).catch(($, e, next) => {
    latestPrompt = ''
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    afterStart($, 'prod-guard', () => greetHub($))
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (APPROVAL.test(latestPrompt)) return next(e)

    const risks = await confirmedRisks($, findRisks(e.command, isProd), isProd)
    const first = risks[0]
    if (first === undefined) return next(e)

    await reportBlock($, first, e.command)
    const deploy = await deployUnderway($, isProd)
    const context = deploy === undefined ? '' : ` A production deploy (${deploy}) was announced in the last 30 minutes.`
    return {
      deny: `${MOD}: ${first.what} can change production.${context} Blocked until the user's latest message contains PROD-OK. Ask them to confirm and add it.`,
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${MOD}: its check failed, so the command was blocked.` }))
}

// #region @vendored shared/hub-client.ts sha256:6b153e2e759f: edit the source, then run `node scripts/sync-shared.mjs`.
// mods-hub client (docs/MOD_CONTRACT.md): uses the hub when it is installed, keeps working when it is not.

type HubMods = EngineInterface['mods']

/** Publishes an event on the hub's bus; false when there is no hub or it refused the event. */
async function hubPublish($: EngineInterface, input: Parameters<HubMods['publish']>[0]): Promise<boolean> {
  try {
    await $.mods.publish(input)
    return true
  } catch {
    return false
  }
}

/**
 * Routes a notification through the hub (channels, silent, night, presence), or shows it as a toast when there is
 * no hub: `title — body`, for `fallback.timeoutMs` when given (the toast's own option).
 */
async function hubNotify($: EngineInterface, input: Parameters<HubMods['notify']>[0], fallback: { timeoutMs?: number } = {}): Promise<void> {
  try {
    await $.mods.notify(input)
  } catch {
    const text = input.body === undefined || input.body === '' ? input.title : `${input.title} — ${input.body}`
    if (fallback.timeoutMs === undefined) $.ui.toast(text)
    else $.ui.toast(text, { timeoutMs: fallback.timeoutMs })
  }
}

/** The global mode (presence, silent, night, interaction), or undefined when there is no hub. */
async function hubMode($: EngineInterface): Promise<Awaited<ReturnType<HubMods['mode']>> | undefined> {
  try {
    return await $.mods.mode()
  } catch {
    return undefined
  }
}

/** Announces this mod to the hub, with its panel tab when it has one; call once from `session.start`. */
async function hubHello($: EngineInterface, hello: Parameters<HubMods['hello']>[0], tab?: Parameters<HubMods['registerTab']>[0]): Promise<boolean> {
  try {
    await $.mods.hello(hello)
    if (tab !== undefined) await $.mods.registerTab(tab)
    return true
  } catch {
    return false
  }
}

/** Opens the shared panel on this mod's tab; false when there is no hub (open your own pane then). */
async function hubShowTab($: EngineInterface, id: string): Promise<boolean> {
  try {
    return (await $.mods.showTab({ id })).isPlaced
  } catch {
    return false
  }
}

/**
 * Stops, pauses or resumes the automatic work (`control.stop` / `control.pause` / `control.resume`) in this session
 * or, with `scope: 'all'`, in every session; false when there is no hub (stop what you run yourself then).
 */
async function hubStop($: EngineInterface, input: Parameters<HubMods['stop']>[0]): Promise<boolean> {
  try {
    await $.mods.stop(input)
    return true
  } catch {
    return false
  }
}

/** Puts a fact on the hub's blackboard as `<this mod>.<name>`; false when there is no hub or it refused the fact. */
async function hubShareFact($: EngineInterface, input: Parameters<HubMods['share']>[0]): Promise<boolean> {
  try {
    await $.mods.share(input)
    return true
  } catch {
    return false
  }
}

/** A fact from the hub's blackboard by its full key (`stack-detector.stack`); undefined when there is no hub or no such fact. */
async function hubReadFact($: EngineInterface, key: string): Promise<Awaited<ReturnType<HubMods['read']>> | undefined> {
  try {
    return (await $.mods.read({ key })) ?? undefined
  } catch {
    return undefined
  }
}

/** Whether the shared panel shows tab `id` now; read while drawing, it subscribes the drawing. */
async function hubTabIs($: EngineInterface, id: string): Promise<boolean> {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
  return value === id
}
/**
 * Runs a mod's start-up work (the hub hello, a first scan, loading what it keeps) once `session.start` has returned,
 * after a short delay staggered by the mod's name (0.15–1.35 s), so ~200 mods sharing one hooks worker do not all wait
 * on the hub, a process or the disk inside the session.start chain (`ran past its 10s budget`). A failure is logged
 * to the debug log. Call it from `session.start` in place of `await work()`; never await the hub there
 * (scripts/check-startup.mjs).
 */
function afterStart($: EngineInterface, mod: string, work: () => Promise<unknown>): void {
  let hash = 7
  for (let i = 0; i < mod.length; i += 1) hash = (hash * 31 + mod.charCodeAt(i)) % 1_200
  $.clock.after(150 + hash, () => {
    void work().catch(error => $.ui.log(`${mod}: start-up work failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' }))
  })
}
// #endregion @vendored shared/hub-client.ts
