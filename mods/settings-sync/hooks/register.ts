import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import { applyChanges, describeChanges, exportText, exportableOptions, parseExport, planImport, stamp } from './sync'

type Json = Record<string, unknown>
type Where = { home: string; settingsPath: string }

const DEFAULT_EXPORT = '~/claude-mods-settings.json'
const DEFAULT_MARKETPLACE = 'claude-mods'
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
  return { home, settingsPath: `${configDir}/settings.json` }
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

const exportSettings = async ($: EngineInterface, marketplace: string, args: string): Promise<string> => {
  const where = await locate($)
  if (where === undefined) return 'Cannot find your home folder (HOME is not set).'
  const loaded = await readJson($, where.settingsPath, false)
  if ('error' in loaded) return `Nothing exported: ${loaded.error}.`

  const { plugins, skipped } = exportableOptions(loaded.value, marketplace)
  const names = Object.keys(plugins)
  if (names.length === 0) {
    return `No settings to export: ${where.settingsPath} has no configuration for mods from the ${marketplace} marketplace. Mods running on their defaults have nothing to move.`
  }

  const target = expandHome(wordsOf(args).find(word => !word.startsWith('-')) ?? DEFAULT_EXPORT, where.home)
  try {
    await $.fs.write(target, exportText(plugins, marketplace, new Date(await $.clock.now()).toISOString()))
  } catch (error) {
    return `Nothing exported: could not write ${target} (${error instanceof Error ? error.message : String(error)}).`
  }
  const count = names.reduce((sum, name) => sum + Object.keys(plugins[name] ?? {}).length, 0)
  return [
    `Exported ${plural(count, 'setting')} of ${plural(names.length, 'mod')} to ${target}.`,
    ...(skipped.length > 0 ? [`Left out because they look like secrets: ${skipped.join(', ')}.`] : []),
    `On another machine: /mods-import ${target}`,
  ].join('\n')
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
  if (plan.changes.length === 0) return [`Nothing to change: this machine already has the ${plural(plan.unchanged, 'setting')} in ${source}.`, ...dropped].join('\n')

  const listed = describeChanges(plan)
  const summary = [
    `${plural(plan.changes.length, 'change')} from ${source}${parsed.file.exportedAt === undefined ? '' : ` (exported ${parsed.file.exportedAt.slice(0, 10)})`}:`,
    ...listed.slice(0, MAX_LISTED),
    ...(listed.length > MAX_LISTED ? [`  ...and ${listed.length - MAX_LISTED} more`] : []),
    ...(plan.unchanged > 0 ? [`${matching(plan.unchanged)}.`] : []),
    ...(plan.notInstalled.size > 0 ? [`Not installed here yet, so they take effect once you install them: ${[...plan.notInstalled].join(', ')}.`] : []),
    ...dropped,
  ]

  if (!isConfirmed) return [...summary, `Nothing has been changed. To apply, run: /mods-import ${source} --yes (your settings.json is backed up first).`].join('\n')
  if (!isPerson(origin)) return [...summary, 'Not applied: --yes has to come from you, typed at the prompt.'].join('\n')

  const backup = (await $.fs.exists(where.settingsPath)) ? `${where.settingsPath}.bak-${stamp(await $.clock.now())}` : undefined
  try {
    if (backup !== undefined) await $.fs.write(backup, await $.fs.read(where.settingsPath))
    await $.fs.write(where.settingsPath, `${JSON.stringify(applyChanges(loaded.value, plan.changes), null, 2)}\n`)
  } catch (error) {
    return `Nothing imported: could not update ${where.settingsPath} (${error instanceof Error ? error.message : String(error)}).${backup === undefined ? '' : ` Its backup is ${backup}.`}`
  }
  return [
    `Applied ${plural(plan.changes.length, 'change')} to ${where.settingsPath}.`,
    ...(backup === undefined ? [] : [`Backup: ${backup}`]),
    ...dropped,
    'Run /reload-plugins (or restart Claude Code) so the mods read their new settings.',
  ].join('\n')
}

export const register: Register = (on, options) => {
  const marketplace = String(options.marketplace ?? DEFAULT_MARKETPLACE).trim() || DEFAULT_MARKETPLACE

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'mods-export', description: 'Writes your claude-mods settings to a file you can move to another machine.', argumentHint: '[path]' })
    await $.command.register({ name: 'mods-import', description: 'Merges a file from /mods-export into this machine\'s settings, after a summary.', argumentHint: '<path> [--yes]' })
    return next(e)
  })

  on('command.run', { command: 'mods-export' }, async ($, e) => ({ text: await exportSettings($, marketplace, e.args) }))

  on('command.run', { command: 'mods-import' }, async ($, e) => ({ text: await importSettings($, marketplace, e.args, e.origin) }))
}
