import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import { applyChanges, applyHubChanges, describeChanges, describeHubChanges, exportText, exportableOptions, parseExport, planHubImport, planImport, portableHubPrefs, stamp } from './sync'
import type { HubPrefs } from './sync'

type Json = Record<string, unknown>
type Where = { home: string; settingsPath: string; hubPrefsPath: string }

const DEFAULT_EXPORT = '~/claude-mods-settings.json'
const DEFAULT_MARKETPLACE = 'claude-mods'
/** Where mods-hub keeps the preferences shared by all sessions, under the home folder. */
const HUB_PREFS = '.claude/claude-mods/hub/prefs.json'
const MAX_LISTED = 40

/** Words of a command's arguments; quotes keep a path with spaces together. */
const wordsOf = (args: string): string[] => (args.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(word => word.replace(/^(["'])(.*)\1$/, '$2'))

const isPerson = (origin: PromptOrigin): boolean =>
  ['composer', 'bridge', 'sdk', 'slack-ping'].includes(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`
const matching = (count: number): string => `${plural(count, 'setting')} already ${count === 1 ? 'matches' : 'match'}`

/** Where the person's user settings are: under `CLAUDE_CONFIG_DIR` when set, else `~/.claude`. */
const locate = async ($: EngineInterface): Promise<Where | undefined> => {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  if (home === undefined || home === '') return undefined
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  const configDir = configured !== undefined && configured !== '' ? configured : `${home}/.claude`
  return { home, settingsPath: `${configDir}/settings.json`, hubPrefsPath: `${home}/${HUB_PREFS}` }
}

const expandHome = (path: string, home: string): string => (path === '~' ? home : path.startsWith('~/') ? `${home}${path.slice(1)}` : path)

/** The settings file as an object; `{}` when there is none yet. */
const readJson = async ($: EngineInterface, path: string, isMissingOk: boolean): Promise<{ value: Json } | { error: string }> => {
  if (!(await $.fs.exists(path))) return isMissingOk ? { value: {} } : { error: `${path} does not exist` }
  try {
    const value: unknown = JSON.parse(await $.fs.read(path))
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? { value: value as Json } : { error: `${path} is not a JSON object` }
  } catch {
    return { error: `${path} could not be read as JSON` }
  }
}

/** The portable preferences in mods-hub's `prefs.json`; undefined when the hub is not installed here (no file) or holds none. */
const hubPrefsOf = async ($: EngineInterface, where: Where): Promise<HubPrefs | undefined> => {
  const loaded = (await $.fs.exists(where.hubPrefsPath)) ? await readJson($, where.hubPrefsPath, false) : undefined
  return loaded === undefined || 'error' in loaded ? undefined : portableHubPrefs(loaded.value)
}

const exportSettings = async ($: EngineInterface, marketplace: string, args: string): Promise<string> => {
  const where = await locate($)
  if (where === undefined) return 'Cannot find your home folder (HOME is not set).'
  const loaded = await readJson($, where.settingsPath, false)
  if ('error' in loaded) return `Nothing exported: ${loaded.error}.`

  const { plugins, skipped } = exportableOptions(loaded.value, marketplace)
  const names = Object.keys(plugins)
  const hub = await hubPrefsOf($, where)
  if (names.length === 0 && hub === undefined) {
    return `No settings to export: ${where.settingsPath} has no configuration for mods from the ${marketplace} marketplace. Mods running on their defaults have nothing to move.`
  }

  const target = expandHome(wordsOf(args).find(word => !word.startsWith('-')) ?? DEFAULT_EXPORT, where.home)
  try {
    await $.fs.write(target, exportText(plugins, marketplace, new Date(await $.clock.now()).toISOString(), hub))
  } catch (error) {
    return `Nothing exported: could not write ${target} (${error instanceof Error ? error.message : String(error)}).`
  }
  const count = names.reduce((sum, name) => sum + Object.keys(plugins[name] ?? {}).length, 0)
  return [
    names.length === 0 ? `Exported the hub's preferences to ${target}.` : `Exported ${plural(count, 'setting')} of ${plural(names.length, 'mod')} to ${target}.`,
    ...(hub !== undefined && names.length > 0 ? [`Also exported the preferences of mods-hub (mode, routes and channel switches).`] : []),
    ...(skipped.length > 0 ? [`Left out because they look like secrets: ${skipped.join(', ')}.`] : []),
    `On another machine: /mods-import ${target}`,
  ].join('\n')
}

/** mods-hub's `prefs.json` as an object, or undefined when there is none (the hub is not installed on this machine). */
const hubPrefsFile = async ($: EngineInterface, where: Where): Promise<{ value: Json } | { error: string } | undefined> =>
  (await $.fs.exists(where.hubPrefsPath)) ? readJson($, where.hubPrefsPath, false) : undefined

/** Merges the hub preferences into its `prefs.json` after a backup; the hub picks the file up within half a minute. */
const applyHub = async ($: EngineInterface, where: Where, current: Json, changes: Parameters<typeof applyHubChanges>[1]): Promise<string> => {
  const backup = `${where.hubPrefsPath}.bak-${stamp(await $.clock.now())}`
  try {
    await $.fs.write(backup, await $.fs.read(where.hubPrefsPath))
    await $.fs.write(where.hubPrefsPath, `${JSON.stringify(applyHubChanges(current, changes), null, 2)}\n`)
  } catch (error) {
    return `Could not update ${where.hubPrefsPath} (${error instanceof Error ? error.message : String(error)}); the mods-hub preferences were left as they were.`
  }
  return `Applied ${plural(changes.length, 'mods-hub preference')} to ${where.hubPrefsPath} (backup: ${backup}). The hub picks them up within half a minute.`
}

const importSettings = async ($: EngineInterface, marketplace: string, args: string, origin: PromptOrigin): Promise<string> => {
  const where = await locate($)
  if (where === undefined) return 'Cannot find your home folder (HOME is not set).'
  const words = wordsOf(args)
  const isConfirmed = words.includes('--yes') || words.includes('-y')
  const source = expandHome(words.find(word => !word.startsWith('-')) ?? DEFAULT_EXPORT, where.home)

  const text = await $.fs.read(source).catch(() => undefined)
  if (text === undefined) return `Nothing imported: could not read ${source}.`
  const parsed = parseExport(text)
  if ('error' in parsed) return `Nothing imported: ${source} is not a settings export (${parsed.error}).`
  const loaded = await readJson($, where.settingsPath, true)
  if ('error' in loaded) return `Nothing imported: ${loaded.error}.`

  const plan = planImport(loaded.value, parsed.file.plugins, marketplace)
  const dropped = parsed.dropped.length > 0 ? [`Ignored because they are not safe to merge or look like secrets: ${parsed.dropped.join(', ')}.`] : []
  // The hub's preferences travel in the same file; they are merged into prefs.json only where the hub is installed (the file exists).
  const hubFile = parsed.file.hub === undefined ? undefined : await hubPrefsFile($, where)
  const hubPlan = parsed.file.hub === undefined || hubFile === undefined || 'error' in hubFile ? undefined : planHubImport(hubFile.value, parsed.file.hub)
  const hubNote = parsed.file.hub === undefined ? [] : hubFile === undefined ? [`The file carries mods-hub preferences, but mods-hub is not installed here (no ${where.hubPrefsPath}), so they were left out.`] : 'error' in hubFile ? [`The file carries mods-hub preferences, but ${hubFile.error}, so they were left out.`] : []
  const hubChanges = hubPlan?.changes ?? []
  if (plan.changes.length === 0 && hubChanges.length === 0) {
    const same = plan.unchanged + (hubPlan?.unchanged ?? 0)
    return [`Nothing to change: this machine already has the ${plural(same, 'setting')} in ${source}.`, ...hubNote, ...dropped].join('\n')
  }

  const listed = describeChanges(plan)
  const hubListed = describeHubChanges(hubChanges)
  const summary = [
    `${plural(plan.changes.length + hubChanges.length, 'change')} from ${source}${parsed.file.exportedAt === undefined ? '' : ` (exported ${parsed.file.exportedAt.slice(0, 10)})`}:`,
    ...listed.slice(0, MAX_LISTED),
    ...(listed.length > MAX_LISTED ? [`  ...and ${listed.length - MAX_LISTED} more`] : []),
    ...(hubChanges.length > 0 ? [`mods-hub preferences (${where.hubPrefsPath}):`, ...hubListed.slice(0, MAX_LISTED)] : []),
    ...(plan.unchanged > 0 ? [`${matching(plan.unchanged)}.`] : []),
    ...(plan.notInstalled.size > 0 ? [`Not installed here yet, so they take effect once you install them: ${[...plan.notInstalled].join(', ')}.`] : []),
    ...hubNote,
    ...dropped,
  ]

  if (!isConfirmed) return [...summary, `Nothing has been changed. To apply, run: /mods-import ${source} --yes (your settings.json is backed up first).`].join('\n')
  if (!isPerson(origin)) return [...summary, 'Not applied: --yes has to come from you, typed at the prompt.'].join('\n')

  const backup = (await $.fs.exists(where.settingsPath)) ? `${where.settingsPath}.bak-${stamp(await $.clock.now())}` : undefined
  try {
    if (plan.changes.length > 0) {
      if (backup !== undefined) await $.fs.write(backup, await $.fs.read(where.settingsPath))
      await $.fs.write(where.settingsPath, `${JSON.stringify(applyChanges(loaded.value, plan.changes), null, 2)}\n`)
    }
  } catch (error) {
    return `Nothing imported: could not update ${where.settingsPath} (${error instanceof Error ? error.message : String(error)}).${backup === undefined ? '' : ` Its backup is ${backup}.`}`
  }
  const hubResult = hubChanges.length > 0 && hubFile !== undefined && !('error' in hubFile) ? await applyHub($, where, hubFile.value, hubChanges) : undefined
  return [
    ...(plan.changes.length > 0 ? [`Applied ${plural(plan.changes.length, 'change')} to ${where.settingsPath}.`] : []),
    ...(plan.changes.length > 0 && backup !== undefined ? [`Backup: ${backup}`] : []),
    ...(hubResult === undefined ? hubNote : [hubResult]),
    ...dropped,
    'Run /reload-plugins (or restart Claude Code) so the mods read their new settings.',
  ].join('\n')
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
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: [] })
}

export const register: Register = (on, options) => {
  const marketplace = String(options.marketplace ?? DEFAULT_MARKETPLACE).trim() || DEFAULT_MARKETPLACE

  on('session.start', async ($, e, next) => {
    await registerCommand($, { name: 'mods-export', description: 'Writes your claude-mods settings to a file you can move to another machine.', argumentHint: '[path]' })
    afterStart($, 'settings-sync', () => greetHub($))
    await registerCommand($, { name: 'mods-import', description: 'Merges a file from /mods-export into this machine\'s settings, after a summary.', argumentHint: '<path> [--yes]' })
    return next(e)
  })

  on('command.run', { command: 'mods-export' }, async ($, e) => ({ text: await exportSettings($, marketplace, e.args) }))

  on('command.run', { command: 'mods-import' }, async ($, e) => ({ text: await importSettings($, marketplace, e.args, e.origin) }))
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
