import type { EngineInterface, Register } from 'claude-code'

import { findDestructive, moveTo, remoteEnvironment } from './commands'
import type { Hit } from './commands'
import { hostPatterns, parseDotenv, targetOf } from './database'
import { redactSummary } from './shared/secrets'

const MOD = 'seed-guard'

const DOTENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local', 'prisma/.env']
const RISKY_WORDS = /\b(?:seed|reset|drop|fresh|refresh|flush|wipe|dropdb|loaddata)\b|migrate:(?:fresh|refresh|reset)|--force-reset|schema:(?:drop|load)|ecto\.(?:reset|drop)/i

type Settings = { allowed: readonly RegExp[]; isStrict: boolean }

/** A URL found for one variable, and where it came from. */
type Source = { name: string; url: string; origin: string }

/** The folders whose `.env` files can matter: where the command runs, and the project root. */
async function foldersOf($: EngineInterface, hit: Hit): Promise<string[]> {
  const cwd = await $.session.cwd()
  const root = await $.session.root().catch(() => cwd)
  return [...new Set([moveTo(cwd, hit.directory), moveTo(root, hit.directory), cwd, root])]
}

async function dotenvValues($: EngineInterface, folders: readonly string[], name: string): Promise<Source[]> {
  const found: Source[] = []
  for (const folder of folders) {
    for (const file of DOTENV_FILES) {
      const text = await $.fs.read(moveTo(folder, file)).catch(() => undefined)
      const url = text === undefined ? undefined : parseDotenv(text).get(name)
      if (url !== undefined && url !== '') found.push({ name, url, origin: moveTo(folder, file) })
    }
  }
  return found
}

/** What the command would connect to: the command's own words, then the process environment, then dotenv files (the order tools read them in). */
async function sourcesOf($: EngineInterface, hit: Hit): Promise<Source[]> {
  const processValues: Record<string, string | undefined> = {
    DATABASE_URL: await $.env.get('DATABASE_URL'),
    DIRECT_URL: await $.env.get('DIRECT_URL'),
  }
  const sources: Source[] = []
  for (const name of Object.keys(processValues)) {
    const own = hit.assignments[name]
    const inherited = processValues[name]
    if (own !== undefined) sources.push({ name, url: own, origin: 'the command' })
    else if (inherited !== undefined && inherited !== '') sources.push({ name, url: inherited, origin: 'the environment' })
    else sources.push(...(await dotenvValues($, await foldersOf($, hit), name)))
  }
  return sources
}

/** Why a command may not run; `rule` and `severity` are for mods-hub's risk.blocked. */
type Objection = { rule: string; severity: 'medium' | 'high'; reason: string }

/** Why the command may not run, or undefined when it targets the own machine (or nothing can be told and that is allowed). */
async function objection($: EngineInterface, hit: Hit, settings: Settings): Promise<Objection | undefined> {
  const named = remoteEnvironment(hit.assignments)
  if (named !== undefined) return { rule: 'remote-environment', severity: 'high', reason: `"${hit.label}" runs with ${named}, which is not your own machine.` }

  const sources = await sourcesOf($, hit)
  for (const { name, url, origin } of sources) {
    const target = targetOf(url, settings.allowed)
    if (target.kind === 'remote') return { rule: 'remote-database', severity: 'high', reason: `"${hit.label}" would run against ${name} host "${target.host}" (from ${origin}).` }
  }
  if (settings.isStrict && !sources.some(source => targetOf(source.url, settings.allowed).kind === 'local')) {
    return {
      rule: 'unknown-database',
      severity: 'medium',
      reason: `"${hit.label}" can run against a database that cannot be identified (no usable DATABASE_URL in the command, the environment or .env).`,
    }
  }
  return undefined
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
  await hubHello($, { version: await ownVersion($), publishes: ['risk.blocked'], consumes: [] })
}

/** Tells mods-hub (when installed) what was blocked, the command masked and cut short. The deny never waits on it. */
async function reportBlock($: EngineInterface, found: Objection, command: string): Promise<void> {
  await hubPublish($, {
    topic: 'risk.blocked',
    data: { guard: MOD, tool: 'Bash', reason: `${found.rule}: ${found.reason}`, severity: found.severity, command: redactSummary(command) },
  })
}

export const register: Register = (on, options) => {
  const settings: Settings = { allowed: hostPatterns(String(options.allowHosts ?? '')), isStrict: options.denyUnknown === true }

  on('session.start', async ($, e, next) => {
    afterStart($, 'seed-guard', () => greetHub($))
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    for (const hit of findDestructive(e.command)) {
      const found = await objection($, hit, settings)
      if (found !== undefined) {
        await reportBlock($, found, e.command)
        return {
          deny:
            `${MOD}: ${found.reason} Seeding, resetting and dropping is only allowed on your own machine (localhost, 127.0.0.1, ::1, a sqlite file, or a host in allowHosts). ` +
            `Point DATABASE_URL at a local database for this command, or ask the user to run it themselves.`,
        }
      }
    }
    return next(e)
  }).catch(($, e, next) =>
    next.called || !RISKY_WORDS.test(e.command) ? next(e) : { deny: `${MOD}: its check failed, so the command was blocked.` },
  )
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
