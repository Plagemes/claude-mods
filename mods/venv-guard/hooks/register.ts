import type { EngineInterface, Register } from 'claude-code'

import { findGlobalInstall } from './pip'
import { redactSummary } from './shared/secrets'

const ENVIRONMENT_FOLDERS = ['.venv', 'venv']
const MAX_SHOWN = 70
const PIP_WORDS = /\bpip\d*\b|-m\s+pip\b/
const MOD = 'venv-guard'

/** Whether the process the Bash tool inherits from already runs inside a virtualenv or a named conda env. */
async function isEnvironmentActive($: EngineInterface): Promise<boolean> {
  if (((await $.env.get('VIRTUAL_ENV')) ?? '') !== '') return true
  const prefix = (await $.env.get('CONDA_PREFIX')) ?? ''
  return prefix !== '' && (await $.env.get('CONDA_DEFAULT_ENV')) !== 'base'
}

/** The project's own environment folder (`.venv` or `venv`) in the working directory, if there is one. */
async function projectEnvironment($: EngineInterface): Promise<string | undefined> {
  try {
    const entries = await $.fs.list(await $.session.cwd())
    return ENVIRONMENT_FOLDERS.find(name => entries.some(entry => entry.name === name && entry.kind === 'dir'))
  } catch {
    return undefined
  }
}

const shorten = (command: string): string => (command.length > MAX_SHOWN ? `${command.slice(0, MAX_SHOWN)}...` : command)

function refusal(offender: string, folder: string | undefined): string {
  const shown = shorten(offender)
  const how =
    folder === undefined
      ? 'Create one first: python3 -m venv .venv && source .venv/bin/activate && pip install ... (or: uv venv && uv pip install ...).'
      : `This project has ${folder}/: run source ${folder}/bin/activate && pip install ... (or ${folder}/bin/pip install ...), or use uv pip install.`
  return `${MOD}: no virtualenv is active, so "${shown}" would install into the system Python. ${how} If a global install is really wanted, the user can turn on allowGlobal in the mod's settings.`
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
async function reportBlock($: EngineInterface, isSystemWide: boolean, command: string): Promise<void> {
  await hubPublish($, {
    topic: 'risk.blocked',
    data: {
      guard: MOD,
      tool: 'Bash',
      reason: isSystemWide ? 'system-wide-install: sudo pip or pip --user installs into the system Python' : 'no-virtualenv: pip install with no virtualenv active',
      severity: isSystemWide ? 'medium' : 'low',
      command: redactSummary(command),
    },
  })
}

export const register: Register = (on, options) => {
  const isAllowed = options.allowGlobal === true

  on('session.start', async ($, e, next) => {
    afterStart($, 'venv-guard', () => greetHub($))
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (isAllowed) return next(e)
    const offender = findGlobalInstall(e.command)
    if (offender === undefined) return next(e)
    if (offender.isSystemWide) {
      await reportBlock($, true, e.command)
      return {
        deny:
          `${MOD}: "${shorten(offender.command)}" installs into the system Python even with a virtualenv active ` +
          '(sudo runs the system pip; --user writes to ~/.local). Drop sudo and --user and install into the project environment instead.',
      }
    }
    if (await isEnvironmentActive($)) return next(e)
    await reportBlock($, false, e.command)
    return { deny: refusal(offender.command, await projectEnvironment($)) }
  }).catch(($, e, next) =>
    next.called || isAllowed || !PIP_WORDS.test(e.command) ? next(e) : { deny: `${MOD}: its check failed, so the pip command was blocked.` },
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
