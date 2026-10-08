import type { EngineInterface, Register } from 'claude-code'

type Settings = { directories: readonly RegExp[]; allowUncommitted: boolean }

const MOD = 'migration-guard'
const DEFAULT_DIRECTORIES = 'migrations,db/migrate,prisma/migrations,alembic/versions,supabase/migrations'
const GIT_TIMEOUT_MS = 5000
const ADVICE = 'Editing it would rewrite history that may already be applied. Leave it as it is and create a new migration with the change instead.'

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// "db/migrate" matches /repo/db/migrate/001.rb and /repo/api/db/migrate/001.rb, but not /repo/mydb/migrate/001.rb.
const directoryPatterns = (list: unknown): RegExp[] =>
  (typeof list === 'string' && list.trim() !== '' ? list : DEFAULT_DIRECTORIES)
    .split(',')
    .map(directory => directory.trim().replace(/^\/+|\/+$/g, '').replace(/\\/g, '/'))
    .filter(directory => directory !== '')
    .map(directory => new RegExp(`(?:^|/)${escapeRegExp(directory)}/`))

const isMigrationPath = (path: string, directories: readonly RegExp[]): boolean => {
  const normalized = path.replace(/\\/g, '/')
  return directories.some(pattern => pattern.test(normalized))
}

const shortName = async ($: EngineInterface, path: string): Promise<string> => {
  try {
    const root = (await $.session.root()).replace(/[\\/]+$/, '')
    return path.startsWith(`${root}/`) || path.startsWith(`${root}\\`) ? path.slice(root.length + 1) : path
  } catch {
    return path
  }
}

const isTracked = async ($: EngineInterface, path: string): Promise<boolean> => {
  try {
    const folder = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))
    const { exitCode } = await $.process.run(['git', 'ls-files', '--error-unmatch', '--', path], { cwd: folder, timeoutMs: GIT_TIMEOUT_MS })
    return exitCode === 0
  } catch {
    return false
  }
}

// Why the file may not be changed, or undefined when it may (a migration that does not exist yet is always fine).
const protectionReason = async ($: EngineInterface, path: string, settings: Settings): Promise<string | undefined> => {
  if (!(await $.fs.exists(path))) return undefined
  const stat = await $.fs.stat(path, { resolve: true })
  const realPath = stat.realPath ?? path
  // A symbolic link into a migration directory is a migration too.
  if (!isMigrationPath(path, settings.directories) && !isMigrationPath(realPath, settings.directories)) return undefined

  const name = await shortName($, path)
  if (await isTracked($, realPath)) return `${name} is an existing migration (tracked in git). ${ADVICE}`
  const startedAt = (await $.session.usage()).startedAt
  if (!settings.allowUncommitted && stat.mtimeMs < startedAt) {
    return `${name} is an existing migration (it was there before this session started). ${ADVICE}`
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

/** Tells mods-hub (when installed) which migration was protected. The deny never waits on the hub. */
async function reportBlock($: EngineInterface, tool: string, path: string, reason: string): Promise<void> {
  await hubPublish($, { topic: 'risk.blocked', data: { guard: MOD, tool, reason, severity: 'medium', path } })
}

export const register: Register = (on, options) => {
  const settings: Settings = { directories: directoryPatterns(options.directories), allowUncommitted: options.allowUncommitted === true }

  on('session.start', async ($, e, next) => {
    afterStart($, 'migration-guard', () => greetHub($))
    return next(e)
  })

  // MultiEdit is not in every build's tool table, so the tools are matched by name.
  on('tool.call', { tool: /^(?:Edit|MultiEdit|Write)$/ }, async ($, e, next) => {
    if (!('file_path' in e) || typeof e.file_path !== 'string') return next(e)
    const reason = await protectionReason($, e.file_path, settings)
    if (reason === undefined) return next(e)
    await reportBlock($, String(e.tool), e.file_path, reason)
    return { deny: `migration-guard: ${reason}` }
  }).catch(($, e, next) => {
    // The check failed: refuse only what is spelled like a migration, and let every other file through.
    const path = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : ''
    if (next.called || !isMigrationPath(path, settings.directories)) return next(e)
    return { deny: `migration-guard: could not verify ${path}, so it was left untouched to be safe. ${ADVICE}` }
  })
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
