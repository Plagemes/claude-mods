/** A value a plugin option can hold. */
export type OptionValue = string | number | boolean | string[]
/** Option name → value, per plugin name. */
export type ModOptions = Record<string, Record<string, OptionValue>>

/** What the export file holds, after it has been read and checked. `hub` is the hub's portable preferences, when the file carries them. */
export type ExportFile = { exportedAt: string | undefined; plugins: ModOptions; hub: HubPrefs | undefined }

const LEVELS = ['info', 'success', 'warning', 'error', 'critical'] as const
const ROUTES = ['terminal', 'away', 'always', 'off'] as const
const INTERACTIONS = ['auto', 'on', 'off'] as const
const QUIET_HOURS = /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/
const CHANNEL_ID = /^[a-z0-9][a-z0-9-]{0,31}$/

/**
 * The part of mods-hub's `prefs.json` that is a preference rather than the moment's state: how the hub treats
 * interaction, night and each level, and which channels are on. (Silent, presence and its end time are left out.)
 */
export type HubPrefs = {
  interaction?: (typeof INTERACTIONS)[number]
  isNightOn?: boolean
  quietHours?: string
  routes?: Partial<Record<(typeof LEVELS)[number], (typeof ROUTES)[number]>>
  channels?: Record<string, { isEnabled: boolean; minLevel: (typeof LEVELS)[number] }>
}

/** One hub preference that would change: its name (`routes.warning`, `channels.telegram.isEnabled`) and both values. */
export type HubChange = { path: string; before: unknown; after: unknown }

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

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value)

/** The portable preferences in a hub `prefs.json` (or an export's `hub.prefs`): known fields with valid values, nothing else. */
export const portableHubPrefs = (raw: unknown): HubPrefs | undefined => {
  if (!isObject(raw)) return undefined
  const prefs: HubPrefs = {}
  if (oneOf(INTERACTIONS, raw.interaction)) prefs.interaction = raw.interaction
  if (typeof raw.isNightOn === 'boolean') prefs.isNightOn = raw.isNightOn
  if (typeof raw.quietHours === 'string' && QUIET_HOURS.test(raw.quietHours)) prefs.quietHours = raw.quietHours
  if (isObject(raw.routes)) {
    const routes: NonNullable<HubPrefs['routes']> = {}
    for (const level of LEVELS) {
      const route = raw.routes[level]
      if (oneOf(ROUTES, route)) routes[level] = route
    }
    if (Object.keys(routes).length > 0) prefs.routes = routes
  }
  if (isObject(raw.channels)) {
    const channels: NonNullable<HubPrefs['channels']> = {}
    for (const [id, value] of Object.entries(raw.channels)) {
      if (CHANNEL_ID.test(id) && isObject(value)) channels[id] = { isEnabled: value.isEnabled !== false, minLevel: oneOf(LEVELS, value.minLevel) ? value.minLevel : 'info' }
    }
    if (Object.keys(channels).length > 0) prefs.channels = channels
  }
  return Object.keys(prefs).length === 0 ? undefined : prefs
}

/** The export file's text; `hub` adds mods-hub's portable preferences under a `hub` key. */
export const exportText = (plugins: ModOptions, marketplace: string, exportedAt: string, hub?: HubPrefs): string => {
  const pluginConfigs = Object.fromEntries(Object.entries(plugins).map(([name, options]) => [name, { options }]))
  return `${JSON.stringify({ format: EXPORT_FORMAT, version: 1, exportedAt, marketplace, pluginConfigs, ...(hub === undefined ? {} : { hub: { prefs: hub } }) }, null, 2)}\n`
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
  const hub = isObject(data.hub) ? portableHubPrefs(data.hub.prefs) : undefined
  return { file: { exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : undefined, plugins, hub }, dropped }
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

/** Each hub preference in `prefs` flattened to a `path` and a value (`routes.warning`, `channels.slack.minLevel`). */
const hubLeaves = (prefs: HubPrefs): [string, unknown][] => [
  ...(prefs.interaction === undefined ? [] : ([['interaction', prefs.interaction]] as [string, unknown][])),
  ...(prefs.isNightOn === undefined ? [] : ([['isNightOn', prefs.isNightOn]] as [string, unknown][])),
  ...(prefs.quietHours === undefined ? [] : ([['quietHours', prefs.quietHours]] as [string, unknown][])),
  ...Object.entries(prefs.routes ?? {}).map(([level, route]): [string, unknown] => [`routes.${level}`, route]),
  ...Object.entries(prefs.channels ?? {}).flatMap(([id, channel]): [string, unknown][] => [
    [`channels.${id}.isEnabled`, channel.isEnabled],
    [`channels.${id}.minLevel`, channel.minLevel],
  ]),
]

/** What importing `incoming` would change in this machine's hub preferences (`current` is its `prefs.json`, `{}` when there is none). */
export const planHubImport = (current: Json, incoming: HubPrefs): { changes: HubChange[]; unchanged: number } => {
  const have = new Map(hubLeaves(portableHubPrefs(current) ?? {}))
  const plan = { changes: [] as HubChange[], unchanged: 0 }
  for (const [path, after] of hubLeaves(incoming)) {
    if (have.has(path) && have.get(path) === after) plan.unchanged += 1
    else plan.changes.push({ path, before: have.get(path), after })
  }
  return plan
}

/** `current` (the hub's `prefs.json`) with the changes merged in; every other field, the hub's moment-to-moment state included, is kept. */
export const applyHubChanges = (current: Json, changes: readonly HubChange[]): Record<string, unknown> => {
  const next: Record<string, unknown> = { ...current }
  const routes: Record<string, unknown> = isObject(current.routes) ? { ...current.routes } : {}
  const channels: Record<string, Record<string, unknown>> = {}
  for (const [id, value] of Object.entries(isObject(current.channels) ? current.channels : {})) channels[id] = isObject(value) ? { ...value } : {}
  for (const { path, after } of changes) {
    const [head, id, field] = path.split('.')
    if (head === 'routes' && id !== undefined) routes[id] = after
    else if (head === 'channels' && id !== undefined && field !== undefined) channels[id] = { ...(channels[id] ?? {}), [field]: after }
    else if (head !== undefined) next[head] = after
  }
  if (changes.some(change => change.path.startsWith('routes.'))) next.routes = routes
  if (changes.some(change => change.path.startsWith('channels.'))) next.channels = channels
  return next
}

export const describeHubChanges = (changes: readonly HubChange[]): string[] =>
  changes.map(({ path, before, after }) => `  ${path}: ${before === undefined ? '(not set)' : JSON.stringify(before)} → ${JSON.stringify(after)}`)

const show = (value: OptionValue | undefined): string => {
  if (value === undefined) return '(not set)'
  const text = JSON.stringify(value)
  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH - 1)}…` : text
}

export const describeChanges = (plan: Plan): string[] =>
  plan.changes.map(({ plugin, option, before, after }) => `  ${plugin}.${option}: ${show(before)} → ${show(after)}`)

/** `YYYYMMDD-HHMMSS` in UTC, for a backup's name. */
export const stamp = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-')
