import type { EngineInterface, Register } from 'claude-code'

import { redactSummary } from './shared/secrets'
import { operands, simpleCommands } from './shared/shell'

const MOD = 'lockfile-guard'
const EDIT_TOOLS = /^(?:Edit|Write|MultiEdit)$/
/** A cheap test before reading a Bash command: does it name a lockfile at all? */
const LOCKFILE_HINT = /lock|go\.sum|shrinkwrap/i
/** Options of `sed` and `perl` that take the next word as their value, so it is not read as a file. */
const SCRIPT_OPTIONS = new Set(['-e', '-E', '-f', '-M', '-I', '--expression', '--file'])

/** Lockfile name -> the command that regenerates it. */
const LOCKFILES: Readonly<Record<string, string>> = {
  'package-lock.json': 'npm install (or npm install <package>)',
  'npm-shrinkwrap.json': 'npm shrinkwrap',
  'pnpm-lock.yaml': 'pnpm install',
  'yarn.lock': 'yarn install',
  'bun.lockb': 'bun install',
  'bun.lock': 'bun install',
  'Cargo.lock': 'cargo update (or cargo build)',
  'poetry.lock': 'poetry lock',
  'uv.lock': 'uv lock',
  'Gemfile.lock': 'bundle install',
  'composer.lock': 'composer update',
  'go.sum': 'go mod tidy',
  'Pipfile.lock': 'pipenv lock',
  'pdm.lock': 'pdm lock',
  'mix.lock': 'mix deps.get',
  'pubspec.lock': 'dart pub get',
  'Podfile.lock': 'pod install',
  'flake.lock': 'nix flake lock',
}

function fileOf(input: Readonly<Record<string, unknown>>): string {
  return typeof input.file_path === 'string' ? input.file_path : ''
}

const nameOf = (path: string): string => path.slice(path.search(/[^/\\]*$/))

/** The command that regenerates the lockfile at `path`, or undefined when it is not one. */
const regenerateOf = (path: string): { name: string; regenerate: string } | undefined => {
  const name = nameOf(path)
  return Object.hasOwn(LOCKFILES, name) ? { name, regenerate: LOCKFILES[name] as string } : undefined
}

/**
 * The first lockfile a shell line edits by hand: a redirection onto it (`> yarn.lock`), `tee`, or an in-place
 * `sed -i` / `perl -i`. Package managers that rewrite it (`npm install`) are what should, so they pass, and so do
 * removing or copying one. Read with the shared claude-mods shell reader (`bash -c`, `$(…)`, wrappers).
 */
function lockfileEditedBy(command: string): { name: string; regenerate: string } | undefined {
  for (const { name, argv, redirects } of simpleCommands(command)) {
    const args = argv.slice(1)
    const isInPlace = (name === 'sed' || name === 'perl') && args.some(arg => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith('--in-place'))
    const files = [
      ...redirects.filter(({ op }) => op.includes('>')).map(({ target }) => target),
      ...(name === 'tee' ? operands(args) : []),
      ...(isInPlace ? operands(args.filter((arg, at) => !SCRIPT_OPTIONS.has(args[at - 1] ?? ''))) : []),
    ]
    for (const file of files) {
      const found = regenerateOf(file)
      if (found !== undefined) return found
    }
  }
  return undefined
}

const refusal = ({ name, regenerate }: { name: string; regenerate: string }): string =>
  `${MOD}: ${name} is generated, so it is not edited by hand. Change the manifest, then regenerate it with: ${regenerate}.`

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

/** Tells mods-hub (when installed) what was blocked, path and command masked and cut short. The deny never waits on it. */
async function reportBlock($: EngineInterface, tool: string, name: string, where: { path: string } | { command: string }): Promise<void> {
  await hubPublish($, {
    topic: 'risk.blocked',
    data: {
      guard: MOD,
      tool,
      reason: `hand-edited-lockfile: ${name} is generated`,
      severity: 'low',
      ...('path' in where ? { path: redactSummary(where.path) } : { command: redactSummary(where.command) }),
    },
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    afterStart($, 'lockfile-guard', () => greetHub($))
    return next(e)
  })

  on('tool.call', { tool: EDIT_TOOLS }, async ($, e, next) => {
    const path = fileOf(e)
    const found = regenerateOf(path)
    if (found === undefined) return next(e)
    await reportBlock($, String(e.tool), found.name, { path })
    return { deny: refusal(found) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${MOD}: its check failed, so the edit was blocked.` }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!LOCKFILE_HINT.test(e.command)) return next(e)
    const found = lockfileEditedBy(e.command)
    if (found === undefined) return next(e)
    await reportBlock($, 'Bash', found.name, { command: e.command })
    return { deny: refusal(found) }
  }).catch(($, e, next) => (next.called || !LOCKFILE_HINT.test(e.command) ? next(e) : { deny: `${MOD}: its check failed, so the command was blocked.` }))
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
