import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { SchemaSyncGenerate as Generate, SchemaSyncKind as Kind, SchemaSyncView as View } from '../types'
import { generateError, matchesSchema, migrationCommand, parseDrizzleConfig, resolveFrom, schemaChanges } from './schema'

const DEFAULT_DEBOUNCE_SECONDS = 2
const MAX_DEBOUNCE_SECONDS = 60
const GENERATE_TIMEOUT_MS = 120_000
const OK_STATUS_MS = 6_000
const GENERATE_TOAST_MS = 8_000
const MAX_LEVELS = 10
const DRIZZLE_CONFIGS = ['drizzle.config.ts', 'drizzle.config.mts', 'drizzle.config.js', 'drizzle.config.mjs', 'drizzle.config.cjs', 'drizzle.config.json']
const SCRIPT_FILE = /\.(?:ts|mts|cts|js|mjs|cjs)$/
const SKIPPED_PATH = /(?:^|\/)node_modules\//
const RUN_ENV = { NO_COLOR: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' }
const TITLE: Record<Kind, string> = { prisma: 'Prisma', drizzle: 'Drizzle' }

const viewAtom = atom({ plugin: 'schema-sync', key: 'view' } as const, null)

/** A project whose schema is watched: its ORM, its package.json folder, and where its migrations live (null: none). */
type Project = { kind: Kind; root: string; migrations: string | null }

/** A project's schema as it stood after the last migration this session saw, and the migrations there were then. */
type Baseline = { project: Project; texts: Map<string, string>; migrations: Set<string> }

type Settings = { debounceMs: number; isGenerating: boolean }

/** What this load of the mod holds: projects found per file, baselines per project, the queue and its timer. */
type Host = {
  projects: Map<string, Project | null>
  drizzle: Map<string, string | null>
  baselines: Map<string, Baseline>
  queued: Map<string, Project>
  timer: Timer | undefined
  isBusy: boolean
}

const dirname = (path: string): string => path.slice(0, Math.max(1, path.lastIndexOf('/')))
const keyOf = (project: Project): string => `${project.kind}:${project.root}`
const relative = (root: string, path: string): string => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path)

async function exists($: EngineInterface, path: string): Promise<boolean> {
  return $.fs.exists(path).catch(() => false)
}

async function readText($: EngineInterface, path: string): Promise<string> {
  const text = await $.fs.read(path).catch(() => '')
  return typeof text === 'string' ? text : ''
}

/** The nearest folder at or above `dir` that holds `name`, up to the repository root. */
async function nearest($: EngineInterface, dir: string, names: readonly string[]): Promise<{ dir: string; name: string } | undefined> {
  let current = dir
  for (let level = 0; level < MAX_LEVELS; level += 1) {
    for (const name of names) if (await exists($, `${current}/${name}`)) return { dir: current, name }
    if (await exists($, `${current}/.git`)) return undefined
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/** The Prisma or Drizzle project a file is the schema of; null when it is none. */
async function projectFor($: EngineInterface, host: Host, file: string): Promise<Project | null> {
  const cached = host.projects.get(file)
  if (cached !== undefined) return cached
  let project: Project | null = null
  if (file.endsWith('.prisma')) {
    const dir = dirname(file)
    const root = (await nearest($, dir, ['package.json']))?.dir ?? dirname(dir)
    const candidates = [`${dir}/migrations`, `${dirname(dir)}/migrations`]
    let migrations: string | null = null
    for (const candidate of candidates) if (migrations === null && (await exists($, candidate))) migrations = candidate
    project = { kind: 'prisma', root, migrations }
  } else if (SCRIPT_FILE.test(file)) {
    const config = await drizzleConfigFor($, host, dirname(file))
    const parsed = config === null ? undefined : parseDrizzleConfig(await readText($, config))
    if (config !== null && parsed !== undefined) {
      const base = dirname(config)
      if (parsed.schema.some(entry => matchesSchema(resolveFrom(base, entry), file))) {
        const out = resolveFrom(base, parsed.out)
        project = { kind: 'drizzle', root: base, migrations: (await exists($, out)) ? out : null }
      }
    }
  }
  host.projects.set(file, project)
  return project
}

async function drizzleConfigFor($: EngineInterface, host: Host, dir: string): Promise<string | null> {
  const cached = host.drizzle.get(dir)
  if (cached !== undefined) return cached
  const found = await nearest($, dir, DRIZZLE_CONFIGS)
  const config = found === undefined ? null : `${found.dir}/${found.name}`
  host.drizzle.set(dir, config)
  return config
}

/** The migrations there are now: folders and .sql files, the journal folder aside. */
async function migrationsNow($: EngineInterface, project: Project): Promise<Set<string>> {
  if (project.migrations === null) return new Set()
  const entries = await $.fs.list(project.migrations).catch(() => [])
  return new Set(entries.map(entry => entry.name).filter(name => name !== 'meta' && name !== 'migration_lock.toml' && !name.startsWith('.')))
}

/** Remembers the schema file as it is before its first edit this session, and the migrations there are. */
async function captureBaseline($: EngineInterface, host: Host, project: Project, file: string): Promise<void> {
  let baseline = host.baselines.get(keyOf(project))
  if (baseline === undefined) {
    baseline = { project, texts: new Map(), migrations: await migrationsNow($, project) }
    host.baselines.set(keyOf(project), baseline)
  }
  if (!baseline.texts.has(file)) baseline.texts.set(file, await readText($, file))
}

/** The schema is in step with the migrations (one was made, or the schema was pushed): start over from here. */
async function resetBaseline($: EngineInterface, baseline: Baseline): Promise<void> {
  for (const file of baseline.texts.keys()) baseline.texts.set(file, await readText($, file))
  baseline.migrations = await migrationsNow($, baseline.project)
}

function showStatus($: EngineInterface, view: View | null): void {
  if (view === null) $.ui.status(undefined)
  else if (view.generate?.status === 'running') $.ui.status('⧗ prisma generate…')
  else if (view.generate?.status === 'failed') $.ui.status('✗ prisma generate failed')
  else if (view.missing !== null) $.ui.status(`⚠ ${TITLE[view.kind]} schema changed without a migration`)
  else if (view.generate?.status === 'ok') {
    $.ui.status('✓ prisma client regenerated')
    $.clock.after(OK_STATUS_MS, () => void clearOkStatus($))
  } else $.ui.status(undefined)
}

async function clearOkStatus($: EngineInterface): Promise<void> {
  const view = await read($, viewAtom)
  if (view === null || (view.generate?.status === 'ok' && view.missing === null)) $.ui.status(undefined)
}

async function publish($: EngineInterface, project: Project, schema: string, generation: Generate | null, missing: string[] | null): Promise<void> {
  const view = await update($, viewAtom, (previous: View | null): View => {
    const isSame = previous !== null && previous.root === project.root && JSON.stringify(previous.missing) === JSON.stringify(missing) && previous.generate?.error === generation?.error
    return { kind: project.kind, root: project.root, schema, generate: generation, missing, isHidden: isSame && previous.isHidden }
  })
  showStatus($, view)
}

/** The `prisma generate` toast with its own timeout without the hub; a warning notification through mods-hub when it is installed. */
async function warnGenerateFailed($: EngineInterface, error: string): Promise<void> {
  const title = `prisma generate failed: ${error}`
  if ((await hubMode($)) === undefined) $.ui.toast(title, { timeoutMs: GENERATE_TOAST_MS })
  else await hubNotify($, { level: 'warning', title, topic: 'build.result' })
}

/** One `prisma generate` as a `build.result` on the hub's bus (nothing happens without the hub). */
async function publishGenerate($: EngineInterface, outcome: 'passed' | 'failed' | 'error', command: string, durationMs: number): Promise<void> {
  await hubPublish($, { topic: 'build.result', data: { tool: 'prisma', outcome, durationMs, command, errors: outcome === 'passed' ? 0 : 1 } })
}

async function generate($: EngineInterface, project: Project, schema: string): Promise<Generate> {
  await publish($, project, schema, { status: 'running', error: null }, (await read($, viewAtom))?.missing ?? null)
  const local = `${project.root}/node_modules/.bin/prisma`
  const argv = (await exists($, local)) ? [local, 'generate'] : ['npx', '--no-install', 'prisma', 'generate']
  const started = await $.clock.now()
  try {
    const ran = await $.process.run(argv, { cwd: project.root, timeoutMs: GENERATE_TIMEOUT_MS, env: RUN_ENV })
    if (ran.exitCode === 0) {
      await publishGenerate($, 'passed', 'prisma generate', (await $.clock.now()) - started)
      return { status: 'ok', error: null }
    }
    const error = generateError(`${ran.stderr}\n${ran.stdout}`)
    await warnGenerateFailed($, error)
    await publishGenerate($, 'failed', 'prisma generate', (await $.clock.now()) - started)
    return { status: 'failed', error }
  } catch (error) {
    const reason = /ENOENT|failed to start/i.test(String(error)) ? 'the Prisma CLI is not installed' : `it did not finish in ${GENERATE_TIMEOUT_MS / 1000}s`
    await publishGenerate($, 'error', 'prisma generate', (await $.clock.now()) - started)
    return { status: 'failed', error: reason }
  }
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
  await hubHello($, { version: await ownVersion($), publishes: ['build.result'], consumes: [] })
}

/** Regenerates the client (Prisma) and compares the schema with the last migration this session saw. */
async function check($: EngineInterface, host: Host, settings: Settings, project: Project): Promise<void> {
  const baseline = host.baselines.get(keyOf(project))
  if (baseline === undefined) return
  const schema = [...baseline.texts.keys()].map(file => relative(project.root, file)).join(', ')
  const generated = project.kind === 'prisma' && settings.isGenerating ? await generate($, project, schema) : null

  let missing: string[] | null = null
  if (project.migrations !== null) {
    const now = await migrationsNow($, project)
    if ([...now].some(name => !baseline.migrations.has(name))) {
      await resetBaseline($, baseline)
    } else {
      const changes: string[] = []
      for (const [file, before] of baseline.texts) changes.push(...schemaChanges(project.kind, before, await readText($, file)))
      missing = changes.length > 0 ? [...new Set(changes)] : null
    }
  }
  await publish($, project, schema, generated, missing)
}

async function flush($: EngineInterface, host: Host, settings: Settings): Promise<void> {
  if (host.isBusy) return
  host.isBusy = true
  try {
    while (host.queued.size > 0) {
      const projects = [...host.queued.values()]
      host.queued.clear()
      for (const project of projects) await check($, host, settings, project)
    }
  } catch (error) {
    $.ui.log(`schema-sync: the check failed: ${String(error)}`, { to: 'debug' })
  } finally {
    host.isBusy = false
  }
}

function queue($: EngineInterface, host: Host, settings: Settings, project: Project): void {
  host.queued.set(keyOf(project), project)
  host.timer?.cancel()
  host.timer = $.clock.after(settings.debounceMs, () => {
    host.timer = undefined
    void flush($, host, settings)
  })
}

async function hide($: EngineInterface): Promise<void> {
  await update($, viewAtom, (view: View | null) => (view === null ? view : { ...view, isHidden: true }))
}

async function askForMigration($: EngineInterface): Promise<void> {
  const view = await read($, viewAtom)
  if (view === null || view.missing === null) return
  await hide($)
  const what = view.missing.join(', ')
  const run =
    view.kind === 'prisma'
      ? 'Run `npx prisma migrate dev --name <short_descriptive_name>` there (add `--create-only` if the database must not change yet)'
      : 'Run `npx drizzle-kit generate` there'
  const text = [
    `The ${TITLE[view.kind]} schema (${view.schema} in ${view.root}) changed without a migration: ${what}.`,
    `${run}, then review the generated SQL: dropped columns or tables, required columns added without a default to tables that already have rows, and renames that came out as a drop plus an add. Summarize the migration.`,
  ].join('\n\n')
  await $.prompt.submit({ text, asUser: true })
}

async function askToFixGenerate($: EngineInterface): Promise<void> {
  const view = await read($, viewAtom)
  if (view?.generate?.status !== 'failed') return
  await hide($)
  await $.prompt.submit({ text: `\`prisma generate\` fails after the schema edit (${view.schema} in ${view.root}):\n\n${view.generate.error ?? ''}\n\nFix the schema so the client generates.`, asUser: true })
}

export const register: Register = (on, options) => {
  const seconds = Number(options.debounceSeconds)
  const settings: Settings = {
    debounceMs: Math.min(seconds >= 0 && Number.isFinite(seconds) ? seconds : DEFAULT_DEBOUNCE_SECONDS, MAX_DEBOUNCE_SECONDS) * 1000,
    isGenerating: options.generate !== false,
  }
  const host: Host = { projects: new Map(), drizzle: new Map(), baselines: new Map(), queued: new Map(), timer: undefined, isBusy: false }

  on('session.start', async ($, e, next) => {
    afterStart($, 'schema-sync', () => greetHub($))
    return next(e)
  })

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const file = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : ''
    if (file === '' || SKIPPED_PATH.test(file)) return next(e)
    if (/(?:^|\/)drizzle\.config\.\w+$/.test(file)) {
      host.projects.clear()
      return next(e)
    }
    const project = await projectFor($, host, file).catch(() => null)
    if (project === null) return next(e)
    await captureBaseline($, host, project, file).catch(() => undefined)
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) queue($, host, settings, project)
    return ran
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const kind = migrationCommand(e.command)
    if (kind === undefined || ran.deny !== undefined) return ran
    for (const baseline of host.baselines.values()) {
      // A push brings the database in step without a migration: what is there now is the new starting point.
      if (kind === 'push') await resetBaseline($, baseline)
      queue($, host, settings, baseline.project)
    }
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const view = await read($, viewAtom)
    const isFailed = view?.generate?.status === 'failed'
    if (view === null || view.isHidden || e.props.hasSurvey || (view.missing === null && !isFailed)) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const below = await next(e)

    return (
      <Box flexDirection="column">
        {view.missing !== null && (
          <Box key="ss-missing" flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Text bold color="warning">
              ⚠ {TITLE[view.kind]} schema changed without a migration
            </Text>
            <Text dimColor wrap="truncate-end">
              {view.missing.join(', ')}
            </Text>
          </Box>
        )}
        {isFailed && (
          <Box key="ss-generate" flexDirection="row" columnGap={1}>
            <Text bold color="error">
              ✗ prisma generate failed
            </Text>
            <Text wrap="truncate-end">{view.generate?.error ?? ''}</Text>
          </Box>
        )}
        <Box key="ss-actions" flexDirection="row" gap={1}>
          {view.missing !== null && <Button key="ss-migrate" label="Ask Claude to create one" hotkey="m" variant="primary" onPress={() => void askForMigration($)} />}
          {isFailed && <Button key="ss-fix" label="Ask Claude to fix" hotkey="f" onPress={() => void askToFixGenerate($)} />}
          <Button key="ss-dismiss" label="Dismiss" role="dismiss" onPress={() => void hide($)} />
        </Box>
        {below}
      </Box>
    )
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
