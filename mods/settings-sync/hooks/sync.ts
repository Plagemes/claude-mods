/** A value a plugin option can hold. */
export type OptionValue = string | number | boolean | string[]
/** Option name → value, per plugin name. */
export type ModOptions = Record<string, Record<string, OptionValue>>

/** What the export file holds, after it has been read and checked. */
export type ExportFile = { exportedAt: string | undefined; plugins: ModOptions }

export type Change = {
  /** The `pluginConfigs` key it lands under on this machine. */
  key: string
  plugin: string
  option: string
  before: OptionValue | undefined
  after: OptionValue
}

export type Plan = { changes: Change[]; unchanged: number; skipped: string[]; notInstalled: Set<string> }

export const EXPORT_FORMAT = 'claude-mods-settings'

const SECRET_NAME = /token|secret|key|password/i
const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const OPTION_NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/
const MAX_VALUE_LENGTH = 40

type Json = Readonly<Record<string, unknown>>

/** `plugins[name]`, created when this map has none of its own (`constructor` and `toString` are inherited, so `??=` would find them). */
const optionsOf = (plugins: ModOptions, name: string): Record<string, OptionValue> => {
  if (!Object.hasOwn(plugins, name)) plugins[name] = {}
  return plugins[name] ?? {}
}

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

export const isOptionValue = (value: unknown): value is OptionValue =>
  typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean' || (Array.isArray(value) && value.every(item => typeof item === 'string'))

/**
 * Whether an option looks like it holds a secret: its name says so (`token`, `secret`, `key`, `password`) and its value is text.
 * A number or a switch cannot be a secret, so `budgetTokens: 500000` and `showTokens: true` travel.
 */
export const looksSecret = (option: string, value: OptionValue): boolean => SECRET_NAME.test(option) && (typeof value === 'string' || Array.isArray(value))

/** `done-chime@claude-mods` is the plugin `done-chime` from the marketplace `claude-mods`. */
const splitKey = (key: string): { name: string; marketplace: string | undefined } => {
  const at = key.lastIndexOf('@')
  return at <= 0 ? { name: key, marketplace: undefined } : { name: key.slice(0, at), marketplace: key.slice(at + 1) }
}

/** The plugin names in `enabledPlugins` that came from `marketplace`, enabled or not. */
const installedNames = (enabledPlugins: unknown, marketplace: string): Set<string> => {
  const names = new Set<string>()
  for (const key of isObject(enabledPlugins) ? Object.keys(enabledPlugins) : []) {
    const parts = splitKey(key)
    if (parts.marketplace === marketplace) names.add(parts.name)
  }
  return names
}

/**
 * The options of the installed claude-mods plugins in a settings file, by plugin name. A `pluginConfigs` key counts when it
 * names the marketplace (`name@claude-mods`) or when it is bare and `enabledPlugins` has the plugin from that marketplace.
 * Options that look like secrets are left out and listed in `skipped` as `plugin.option`.
 */
export const exportableOptions = (settings: Json, marketplace: string): { plugins: ModOptions; skipped: string[] } => {
  const installed = installedNames(settings.enabledPlugins, marketplace)
  const plugins: ModOptions = {}
  const skipped: string[] = []
  const configs = isObject(settings.pluginConfigs) ? settings.pluginConfigs : {}

  for (const [key, config] of Object.entries(configs)) {
    const { name, marketplace: from } = splitKey(key)
    const isMod = from === marketplace || (from === undefined && installed.has(name))
    const options = isObject(config) && isObject(config.options) ? config.options : undefined
    if (!isMod || options === undefined || !PLUGIN_NAME.test(name)) continue

    for (const [option, value] of Object.entries(options)) {
      if (!OPTION_NAME.test(option) || !isOptionValue(value)) continue
      if (looksSecret(option, value)) skipped.push(`${name}.${option}`)
      else optionsOf(plugins, name)[option] = value
    }
  }
  return { plugins, skipped }
}

/** The export file's text. */
export const exportText = (plugins: ModOptions, marketplace: string, exportedAt: string): string => {
  const pluginConfigs = Object.fromEntries(Object.entries(plugins).map(([name, options]) => [name, { options }]))
  return `${JSON.stringify({ format: EXPORT_FORMAT, version: 1, exportedAt, marketplace, pluginConfigs }, null, 2)}\n`
}

/** Reads an export file: its plugins and options, or the reason it cannot be one. Names and values that are not safe to merge are dropped. */
export const parseExport = (text: string): { file: ExportFile; dropped: string[] } | { error: string } => {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { error: 'it is not valid JSON' }
  }
  if (!isObject(data) || !isObject(data.pluginConfigs)) return { error: `it has no "pluginConfigs" object (a file written by /mods-export has)` }

  const plugins: ModOptions = {}
  const dropped: string[] = []
  for (const [key, config] of Object.entries(data.pluginConfigs)) {
    const { name } = splitKey(key)
    const options = isObject(config) && isObject(config.options) ? config.options : {}
    for (const [option, value] of Object.entries(options)) {
      if (!PLUGIN_NAME.test(name) || !OPTION_NAME.test(option) || !isOptionValue(value) || looksSecret(option, value)) dropped.push(`${name}.${option}`)
      else optionsOf(plugins, name)[option] = value
    }
  }
  return { file: { exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : undefined, plugins }, dropped }
}

const sameValue = (a: OptionValue | undefined, b: OptionValue): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Where a plugin's options live in `settings`: its `name@marketplace` key, else the bare name, else the key to create. */
const targetKey = (configs: Json, name: string, marketplace: string): string => {
  const qualified = `${name}@${marketplace}`
  return Object.hasOwn(configs, qualified) || !Object.hasOwn(configs, name) ? qualified : name
}

/** What importing `plugins` would change in `settings`: each option that is new or has another value here. */
export const planImport = (settings: Json, plugins: ModOptions, marketplace: string): Plan => {
  const configs = isObject(settings.pluginConfigs) ? settings.pluginConfigs : {}
  const installed = installedNames(settings.enabledPlugins, marketplace)
  const plan: Plan = { changes: [], unchanged: 0, skipped: [], notInstalled: new Set() }

  for (const [plugin, options] of Object.entries(plugins)) {
    const key = targetKey(configs, plugin, marketplace)
    const current = isObject(configs[key]) && isObject(configs[key].options) ? configs[key].options : {}
    if (!installed.has(plugin)) plan.notInstalled.add(plugin)
    for (const [option, after] of Object.entries(options)) {
      const before = current[option]
      if (isOptionValue(before) && sameValue(before, after)) plan.unchanged += 1
      else plan.changes.push({ key, plugin, option, before: isOptionValue(before) ? before : undefined, after })
    }
  }
  return plan
}

/** `settings` with the changes merged in; everything else in it, and the order of its keys, is kept. */
export const applyChanges = (settings: Json, changes: readonly Change[]): Record<string, unknown> => {
  const configs: Record<string, unknown> = isObject(settings.pluginConfigs) ? { ...settings.pluginConfigs } : {}
  for (const { key, option, after } of changes) {
    const entry: Record<string, unknown> = isObject(configs[key]) ? { ...configs[key] } : {}
    entry.options = { ...(isObject(entry.options) ? entry.options : {}), [option]: after }
    configs[key] = entry
  }
  return { ...settings, pluginConfigs: configs }
}

const show = (value: OptionValue | undefined): string => {
  if (value === undefined) return '(not set)'
  const text = JSON.stringify(value)
  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH - 1)}…` : text
}

export const describeChanges = (plan: Plan): string[] =>
  plan.changes.map(({ plugin, option, before, after }) => `  ${plugin}.${option}: ${show(before)} → ${show(after)}`)

/** `YYYYMMDD-HHMMSS` in UTC, for a backup's name. */
export const stamp = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-')
