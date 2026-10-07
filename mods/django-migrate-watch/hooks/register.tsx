import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { DjangoMigrateApp as App, DjangoMigratePending as Pending } from '../types'
import { appsSummary, isMigrationFile, isModelsFile, parsePending, signatureOf, touchesMigrations } from './parse'

const DEFAULT_DEBOUNCE_SECONDS = 3
const DEFAULT_TIMEOUT_SECONDS = 60
const MAX_TIMEOUT_SECONDS = 300
const MAX_LEVELS = 12
const VENVS = ['.venv', 'venv', 'env']
const BAND_OPERATIONS = 4
const CHECK_ENV = { PYTHONUNBUFFERED: '1', NO_COLOR: '1' }

const pendingAtom = atom({ plugin: 'django-migrate-watch', key: 'pending' } as const, null)

type Settings = { debounceMs: number; timeoutMs: number }

/** What this load of the mod holds: Django roots found per folder, roots waiting for a check, its timer. */
type Host = { roots: Map<string, string | null>; queued: Set<string>; timer: Timer | undefined; isBusy: boolean }

const dirname = (path: string): string => path.slice(0, Math.max(1, path.lastIndexOf('/')))
const relative = (root: string, path: string): string => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path)

/** The folder holding the project's manage.py, from an edited file up to the repository root. */
async function djangoRoot($: EngineInterface, host: Host, file: string): Promise<string | null> {
  const start = dirname(file)
  const cached = host.roots.get(start)
  if (cached !== undefined) return cached
  let found: string | null = null
  let dir = start
  for (let level = 0; level < MAX_LEVELS; level += 1) {
    if (await $.fs.exists(`${dir}/manage.py`).catch(() => false)) {
      found = dir
      break
    }
    if (await $.fs.exists(`${dir}/.git`).catch(() => false)) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  host.roots.set(start, found)
  return found
}

/** The project's python: a virtualenv beside manage.py (or one level up), the active VIRTUAL_ENV, else python3. */
async function pythonFor($: EngineInterface, root: string): Promise<string> {
  const active = await $.env.get('VIRTUAL_ENV').catch(() => undefined)
  const candidates = [
    ...VENVS.map(venv => `${root}/${venv}/bin/python`),
    ...(active === undefined || active === '' ? [] : [`${active}/bin/python`]),
    ...VENVS.map(venv => `${dirname(root)}/${venv}/bin/python`),
  ]
  for (const candidate of candidates) if (await $.fs.exists(candidate).catch(() => false)) return candidate
  return 'python3'
}

function showStatus($: EngineInterface, apps: readonly App[] | null): void {
  $.ui.status(apps === null || apps.length === 0 ? undefined : `⚠ migrations missing: ${appsSummary(apps)}`)
}

/** Runs `makemigrations --check --dry-run` in one project and records what it found; quiet when the check itself fails. */
async function check($: EngineInterface, settings: Settings, root: string): Promise<void> {
  const python = await pythonFor($, root)
  let output: string
  let exitCode: number
  try {
    const ran = await $.process.run([python, 'manage.py', 'makemigrations', '--check', '--dry-run'], { cwd: root, timeoutMs: settings.timeoutMs, env: CHECK_ENV })
    output = ran.stdout
    exitCode = ran.exitCode
    if (exitCode !== 0 && !/Migrations for '/.test(output)) {
      $.ui.log(`django-migrate-watch: the check failed in ${root}: ${(ran.stderr.trim().split('\n').at(-1) ?? '').slice(0, 300)}`, { to: 'debug' })
      return
    }
  } catch (error) {
    $.ui.log(`django-migrate-watch: the check could not run in ${root}: ${String(error)}`, { to: 'debug' })
    return
  }

  const apps = parsePending(output)
  const previous = await read($, pendingAtom)
  if (apps.length === 0) {
    if (previous === null || previous.root === root) {
      await update($, pendingAtom, () => null)
      showStatus($, null)
    }
    return
  }
  const isSame = previous !== null && previous.root === root && signatureOf(previous.apps) === signatureOf(apps)
  await update($, pendingAtom, (): Pending => ({ root, python, apps, isHidden: isSame && previous.isHidden }))
  showStatus($, apps)
  if (!isSame) await reportMissing($, root, apps)
}

/**
 * Tells mods-hub when the set of missing migrations is new or changed: an event for mods that follow it, and a
 * warning for the person who may be away from the terminal. Without mods-hub the band and the status line are all
 * there is (no toast is added).
 */
async function reportMissing($: EngineInterface, root: string, apps: readonly App[]): Promise<void> {
  await hubPublish($, {
    topic: 'x.django-migrate-watch.missing',
    data: { root, apps: apps.map(app => ({ app: app.app, operations: app.operations.length })) },
  })
  if ((await hubMode($)) === undefined) return
  await hubNotify($, { level: 'warning', title: `Django models changed without migrations: ${appsSummary(apps)}` })
}

/** Checks every project queued since the last run, one at a time; edits made meanwhile queue another run. */
async function flush($: EngineInterface, host: Host, settings: Settings): Promise<void> {
  if (host.isBusy) return
  host.isBusy = true
  try {
    while (host.queued.size > 0) {
      const roots = [...host.queued]
      host.queued.clear()
      for (const root of roots) await check($, settings, root)
    }
  } finally {
    host.isBusy = false
  }
}

function queue($: EngineInterface, host: Host, settings: Settings, root: string): void {
  host.queued.add(root)
  host.timer?.cancel()
  host.timer = $.clock.after(settings.debounceMs, () => {
    host.timer = undefined
    void flush($, host, settings)
  })
}

async function askToCreate($: EngineInterface): Promise<void> {
  const pending = await read($, pendingAtom)
  if (pending === null) return
  await update($, pendingAtom, (latest: Pending | null) => (latest === null ? latest : { ...latest, isHidden: true }))
  const python = relative(pending.root, pending.python)
  const changes = pending.apps.map(app => `- ${app.app}: ${app.operations.length > 0 ? app.operations.join('; ') : 'changes'}`)
  const text = [
    'Django reports model changes that have no migration yet:',
    ...changes,
    '',
    `Run \`${python} manage.py makemigrations\` in ${pending.root}, then review each new migration file: data loss (dropped columns, NOT NULL fields without a default), renames that came out as a remove plus an add, and whether a data migration is needed. Summarize what each migration does.`,
  ].join('\n')
  await $.prompt.submit({ text, asUser: true })
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
  await hubHello($, { version: await ownVersion($), publishes: ['x.django-migrate-watch.missing'], consumes: [] })
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await greetHub($)
    return next(e)
  })

  const seconds = (value: unknown, fallback: number) => Math.min(Number(value) > 0 ? Number(value) : fallback, MAX_TIMEOUT_SECONDS)
  const settings: Settings = {
    debounceMs: seconds(options.debounceSeconds, DEFAULT_DEBOUNCE_SECONDS) * 1000,
    timeoutMs: seconds(options.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS) * 1000,
  }
  const host: Host = { roots: new Map(), queued: new Set(), timer: undefined, isBusy: false }

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const ran = await next(e)
    const file = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : ''
    if (ran.deny !== undefined || ran.isError === true || !file.endsWith('.py')) return ran
    if (!isModelsFile(file) && !isMigrationFile(file)) return ran
    const root = await djangoRoot($, host, file).catch(() => null)
    if (root !== null) queue($, host, settings, root)
    return ran
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (!touchesMigrations(e.command)) return ran
    const pending = await read($, pendingAtom)
    const root = pending?.root ?? (await djangoRoot($, host, `${await $.session.cwd()}/manage.py`).catch(() => null))
    if (root !== null) queue($, host, settings, root)
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const pending = await read($, pendingAtom)
    if (pending === null || pending.isHidden || e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const below = await next(e)
    const operations = pending.apps.flatMap(app => app.operations.map(operation => `${app.app}: ${operation}`))
    const shown = operations.slice(0, BAND_OPERATIONS)

    return (
      <Box flexDirection="column">
        <Box key="dmw-head" flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Text bold color="warning">
            ⚠ Django models changed without migrations
          </Text>
          <Text dimColor>{appsSummary(pending.apps)}</Text>
        </Box>
        {shown.map(operation => (
          <Text dimColor wrap="truncate-end">{`  ${operation}`}</Text>
        ))}
        {operations.length > shown.length && <Text dimColor>{`  … and ${operations.length - shown.length} more`}</Text>}
        <Box key="dmw-actions" flexDirection="row" gap={1}>
          <Button key="dmw-create" label="Create migrations" hotkey="m" variant="primary" onPress={() => void askToCreate($)} />
          <Button
            key="dmw-dismiss"
            label="Dismiss"
            role="dismiss"
            onPress={() => void update($, pendingAtom, (latest: Pending | null) => (latest === null ? latest : { ...latest, isHidden: true }))}
          />
        </Box>
        {below}
      </Box>
    )
  })
}

// #region @vendored shared/hub-client.ts sha256:0acb840d81b7: edit the source, then run `node scripts/sync-shared.mjs`.
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
// #endregion @vendored shared/hub-client.ts
