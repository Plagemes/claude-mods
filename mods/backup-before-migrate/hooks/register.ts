import type { EngineInterface, Register } from 'claude-code'

import {
  RESTORE_NOTE,
  SKIP_MARK,
  compileExtra,
  dumpPlan,
  inlineDatabaseUrl,
  leadingDirectory,
  migrationKind,
  parseIndex,
  rotate,
  sizeText,
  stampOf,
  whenText,
} from './backup'
import type { Entry } from './backup'
import { ENV_FILES, ENV_VAR, SQLITE_FALLBACKS, describeTarget, environmentRisk, parseEnv, resolveUrl } from './db'
import type { DbTarget } from './db'

const BACKUP_DIR = '.claude/db-backups'
const INDEX_FILE = 'index.json'
const GITIGNORE = '# Database dumps made by backup-before-migrate: they hold your data, never commit them.\n*\n'
const DEFAULT_KEEP = 10
const DUMP_TIMEOUT_MS = 10 * 60_000
const RM_TIMEOUT_MS = 10_000

type Settings = { keep: number; compress: boolean; requireBackup: boolean; extra: RegExp | undefined }
type Found = { ok: true; target: DbTarget; source: string } | { ok: false; error: string }
type Outcome = { kind: 'saved'; entry: Entry } | { kind: 'skipped'; reason: string } | { kind: 'failed'; reason: string }

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

async function exists($: EngineInterface, path: string): Promise<boolean> {
  return $.fs.exists(path).catch(() => false)
}

/**
 * The project's database, only when it is on this machine: the variable the command sets for itself, else the one
 * from the environment or an env file, else a framework's SQLite file.
 */
async function findDatabase($: EngineInterface, root: string, inline: string | undefined): Promise<Found> {
  if (inline !== undefined && inline.includes('$')) return { ok: false, error: `the command sets ${ENV_VAR} from a shell variable that cannot be read here` }
  let url = inline?.trim() ?? (await $.env.get('DATABASE_URL').catch(() => undefined))?.trim()
  let source = inline === undefined ? 'the environment' : 'the command'
  if (url === undefined || url === '') {
    url = undefined
    for (const file of ENV_FILES) {
      const text = await readText($, `${root}/${file}`)
      const value = text === undefined ? undefined : parseEnv(text).get(ENV_VAR)?.trim()
      if (value !== undefined && value !== '') {
        url = value
        source = file
        break
      }
    }
  }
  if (url === undefined) {
    for (const file of SQLITE_FALLBACKS) {
      if (await exists($, `${root}/${file}`)) return { ok: true, target: { kind: 'sqlite', path: `${root}/${file}` }, source: file }
    }
    return { ok: false, error: `no ${ENV_VAR} in the environment or .env, and no SQLite database in the usual places` }
  }

  const resolved = resolveUrl(url, root)
  if (!resolved.ok) return { ok: false, error: `${ENV_VAR} was not used: ${resolved.reason}; only databases on this machine are dumped` }
  if ('target' in resolved) {
    const risk = environmentRisk(resolved.target, {
      PGHOSTADDR: await $.env.get('PGHOSTADDR').catch(() => undefined),
      PGSERVICE: await $.env.get('PGSERVICE').catch(() => undefined),
      PGHOST: await $.env.get('PGHOST').catch(() => undefined),
    })
    if (risk !== undefined) return { ok: false, error: `${risk}, which could send pg_dump elsewhere` }
    return { ok: true, target: resolved.target, source }
  }
  // Prisma resolves `file:` paths from the schema's folder.
  const prisma = /^file:/i.test(url) ? resolveUrl(url, `${root}/prisma`) : undefined
  const candidates = [...(prisma !== undefined && prisma.ok && 'sqlitePaths' in prisma ? prisma.sqlitePaths : []), ...resolved.sqlitePaths]
  for (const path of candidates) {
    if (await exists($, path)) return { ok: true, target: { kind: 'sqlite', path }, source }
  }
  return { ok: false, error: `the SQLite file ${candidates[0] ?? url} does not exist yet` }
}

async function removeFiles($: EngineInterface, paths: readonly string[]): Promise<boolean> {
  if (paths.length === 0) return true
  try {
    return (await $.process.run(['rm', '-f', '--', ...paths], { timeoutMs: RM_TIMEOUT_MS })).exitCode === 0
  } catch {
    return false
  }
}

async function readEntries($: EngineInterface, dir: string): Promise<Entry[]> {
  return parseIndex(await readText($, `${dir}/${INDEX_FILE}`))
}

/** Adds the backup to the index and deletes the ones past `keep`. */
async function record($: EngineInterface, dir: string, entry: Entry, keep: number): Promise<void> {
  const { kept, dropped } = rotate([...(await readEntries($, dir)), entry], keep)
  const isRemoved = await removeFiles($, dropped.map(old => `${dir}/${old.file}`))
  const backups = isRemoved ? kept : [...dropped, ...kept]
  await $.fs.write(`${dir}/${INDEX_FILE}`, `${JSON.stringify({ backups }, null, 2)}\n`)
}

/** Dumps the project's local database before `command` migrates it. */
async function backUp($: EngineInterface, command: string, migration: string, settings: Settings): Promise<Outcome> {
  const cwd = (await $.session.cwd()).replace(/[\\/]+$/, '')
  const sub = leadingDirectory(command)
  const found = await findDatabase($, sub === undefined ? cwd : sub.startsWith('/') ? sub : `${cwd}/${sub}`, inlineDatabaseUrl(command))
  if (!found.ok) return { kind: 'skipped', reason: found.error }

  const dir = `${cwd}/${BACKUP_DIR}`
  const createdAt = await $.clock.now()
  const plan = dumpPlan(found.target, dir, stampOf(createdAt), settings.compress)
  if (plan === undefined) return { kind: 'skipped', reason: 'the database path holds a quote that cannot be passed to sqlite3 safely' }
  const [tool = ''] = plan.argv
  if (!(await exists($, `${dir}/.gitignore`))) await $.fs.write(`${dir}/.gitignore`, GITIGNORE)

  let reason: string | undefined
  try {
    const run = await $.process.run(plan.argv, { env: plan.env, timeoutMs: DUMP_TIMEOUT_MS })
    if (run.exitCode !== 0) reason = run.stderr.trim().split('\n').slice(0, 2).join(' ') || `${tool} exited with code ${run.exitCode}`
  } catch (error) {
    const text = String(error)
    if (/ENOENT/.test(text)) return { kind: 'skipped', reason: `${tool} is not installed or not on PATH` }
    reason = /still running/.test(text) ? `${tool} did not finish within ${DUMP_TIMEOUT_MS / 60_000} minutes` : text
  }
  if (reason !== undefined) {
    await removeFiles($, [plan.file])
    return { kind: 'failed', reason: `${tool} failed: ${reason}` }
  }

  const bytes = (await $.fs.stat(plan.file).catch(() => undefined))?.size ?? 0
  const file = plan.file.slice(dir.length + 1)
  const entry: Entry = { file, createdAt, kind: found.target.kind, label: describeTarget(found.target), bytes, migration, command: command.slice(0, 200), restore: plan.restore }
  await record($, dir, entry, settings.keep)
  return { kind: 'saved', entry }
}

async function newestFirst($: EngineInterface): Promise<{ dir: string; entries: Entry[] }> {
  const dir = `${(await $.session.cwd()).replace(/[\\/]+$/, '')}/${BACKUP_DIR}`
  return { dir, entries: (await readEntries($, dir)).sort((a, b) => b.createdAt - a.createdAt) }
}

async function listBackups($: EngineInterface): Promise<string> {
  const { dir, entries } = await newestFirst($)
  if (entries.length === 0) return `No database backups yet. One is written to ${BACKUP_DIR}/ before each migration Claude runs.`
  const lines = await Promise.all(
    entries.map(async (entry, index) => {
      const isThere = await exists($, `${dir}/${entry.file}`)
      return `${String(index + 1).padStart(2)}. ${whenText(entry.createdAt)}  ${entry.label}  ${sizeText(entry.bytes)}  before: ${entry.command}${isThere ? '' : '  (file missing)'}`
    }),
  )
  return [`Database backups in ${BACKUP_DIR}/, newest first:`, ...lines, '', 'See how to restore one with /db-restore <n>.'].join('\n')
}

async function restoreHelp($: EngineInterface, args: string): Promise<string> {
  const { dir, entries } = await newestFirst($)
  const wanted = args.trim() === '' ? 1 : Number(args.trim())
  if (!Number.isInteger(wanted) || wanted < 1) return 'Usage: /db-restore <n>, where n is a number from /db-backups (1 is the newest).'
  const entry = entries[wanted - 1]
  if (entry === undefined) return entries.length === 0 ? 'No database backups yet.' : `There is no backup ${wanted}: /db-backups lists ${entries.length}.`
  if (!(await exists($, `${dir}/${entry.file}`))) return `Backup ${wanted} is listed, but its file ${BACKUP_DIR}/${entry.file} is gone.`
  return [
    `Backup ${wanted}: ${entry.label}, ${whenText(entry.createdAt)}, taken before: ${entry.command}`,
    'To restore it, run this yourself in a terminal (nothing is run for you):',
    '',
    `  ${entry.restore}`,
    '',
    RESTORE_NOTE[entry.kind] ?? '',
  ].join('\n')
}

// ── mods-hub: backups on the bus, notices instead of toasts ─────────────────────────────────────────

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
  await hubHello($, { version: await ownVersion($), publishes: ['x.backup-before-migrate.saved'], consumes: [] })
}

/** A backup taken before a migration, on the hub's bus for every session (audit-trail, autopilot). */
async function publishSaved($: EngineInterface, entry: Entry): Promise<void> {
  await hubPublish($, {
    topic: 'x.backup-before-migrate.saved',
    data: { file: `${BACKUP_DIR}/${entry.file}`, label: entry.label, kind: entry.kind, bytes: entry.bytes, migration: entry.migration, command: entry.command },
    scope: 'global',
  })
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    keep: Number.isInteger(options.keep) && Number(options.keep) >= 1 ? Number(options.keep) : DEFAULT_KEEP,
    compress: options.compress !== false,
    requireBackup: options.requireBackup === true,
    extra: compileExtra(options.extraPattern),
  }
  const bypass = settings.requireBackup ? '' : ' If the user agrees to migrate without a backup, run the same command prefixed with SKIP_DB_BACKUP=1.'

  on('session.start', async ($, e, next) => {
    await registerCommand($, { name: 'db-backups', description: 'List the database backups taken before migrations' })
    await registerCommand($, { name: 'db-restore', description: 'Show the exact command that restores a database backup', argumentHint: '[n]' })
    afterStart($, 'backup-before-migrate', () => greetHub($))
    return next(e)
  })

  on('command.run', { command: 'db-backups' }, async $ => ({ text: await listBackups($) }))

  on('command.run', { command: 'db-restore' }, async ($, e) => ({ text: await restoreHelp($, e.args) }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const migration = migrationKind(e.command, settings.extra)
    if (migration === undefined) return next(e)

    const isOptedOut = !settings.requireBackup && SKIP_MARK.test(e.command)
    const outcome: Outcome = isOptedOut ? { kind: 'skipped', reason: 'SKIP_DB_BACKUP=1 was set' } : await backUp($, e.command, migration, settings)
    if (outcome.kind === 'failed') {
      return { deny: `backup-before-migrate: the backup before this ${migration} failed (${outcome.reason}), so the migration did not run. Fix the cause first (is the database running?).${bypass}` }
    }
    if (outcome.kind === 'skipped' && settings.requireBackup) {
      return { deny: `backup-before-migrate: no backup could be taken (${outcome.reason}), and this project requires one before every migration.` }
    }

    const note =
      outcome.kind === 'saved'
        ? `backup-before-migrate: before this migration, ${outcome.entry.label} was backed up to ${BACKUP_DIR}/${outcome.entry.file}. If it went wrong, the user can restore it: /db-restore 1 shows the command.`
        : `backup-before-migrate: no backup was taken before this migration (${outcome.reason}).`
    // A migration without a backup may matter away from the terminal: a warning, which reaches channels while you are away.
    await hubNotify(
      $,
      outcome.kind === 'saved'
        ? { level: 'info', title: `💾 Backed up ${outcome.entry.label} (${sizeText(outcome.entry.bytes)}) before ${migration}` }
        : { level: 'warning', title: `No backup before ${migration}: ${outcome.reason}` },
    )
    if (outcome.kind === 'saved') await publishSaved($, outcome.entry)
    const ran = await next(e)
    return ran.deny === undefined ? { ...ran, context: [...(ran.context ?? []), note] } : ran
  }).catch(($, e, next) => {
    if (next.called || migrationKind(e.command, settings.extra) === undefined) return next(e)
    return { deny: `backup-before-migrate: the backup step failed unexpectedly, so the migration did not run.${bypass}` }
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
