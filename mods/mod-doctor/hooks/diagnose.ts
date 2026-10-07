import type { DoctorFinding, DoctorFix, DoctorSeverity } from '../types'
import { asRecord, asText } from './cli'

/** One installed plugin, as `claude plugin list --json` reports it. */
export type Installed = {
  id: string
  name: string
  marketplace: string
  version: string
  scope: string
  isEnabled: boolean
  /** The folder the session loads it from: its marketplace folder, else the install copy. */
  folder?: string
}

/** What `claude plugin validate --json` says of one plugin's files. */
export type Profile = {
  loadErrors: string[]
  commands: string[]
  usesStatus: boolean
  usesBand: boolean
  composes: boolean
}

/** A plugin whose files could not be checked, and why. */
export type Unchecked = { problem: string }

/** Two mods that interfere, or are worth knowing to work together. */
export type Conflict = { mods: readonly [string, string]; severity: DoctorSeverity; text: string }

export const SELF = 'mod-doctor'
export const DEFAULT_MARKETPLACE = 'claude-mods'
const SHOWN_DETAILS = 3
const CROWDED_STATUS = 4
const CROWDED_BANDS = 3
const CROWDED_PROMPT = 4
const SEVERITY_ORDER: Record<DoctorSeverity, number> = { error: 0, warning: 1, info: 2, ok: 3 }
const HINT = /\b(skipped|refused|threw|failed|did not load|not loaded|does not validate|does not parse)\b/i

/** Known pairs of claude-mods: ones that pull against each other, and ones that only look like they might. */
export const CONFLICTS: readonly Conflict[] = [
  {
    mods: ['concise-mode', 'explain-level'],
    severity: 'warning',
    text: 'Both tell Claude how long and deep answers should be: /concise with /expert or /eli5 pulls it two ways. Keep one of them on at a time.',
  },
  {
    mods: ['concise-mode', 'learning-mode'],
    severity: 'warning',
    text: 'learning-mode asks Claude to explain the why behind every change, concise-mode to keep answers short.',
  },
  { mods: ['soundpack', 'done-chime'], severity: 'warning', text: 'Both can play a sound when a turn ends, so you may hear two.' },
  { mods: ['soundpack', 'error-buzz'], severity: 'warning', text: 'Both can play a sound when a command fails, so you may hear two.' },
  { mods: ['soundpack', 'permission-ping'], severity: 'warning', text: 'Both can play a sound when Claude waits for your approval.' },
  { mods: ['permission-ping', 'desktop-notify'], severity: 'info', text: 'Both alert you when Claude waits for approval: expect a toast and a desktop notification.' },
  { mods: ['pair-mode', 'auto-format'], severity: 'info', text: 'pair-mode hands edits to you as diffs, so auto-format only runs on edits Claude makes itself.' },
  { mods: ['offline-mode', 'mod-store'], severity: 'info', text: 'While /offline is on, mod-store cannot reach GitHub and shows its cached catalog.' },
  { mods: ['offline-mode', 'webhook-notify'], severity: 'info', text: 'While /offline is on, webhook-notify cannot post its messages.' },
  { mods: ['subagent-cap', 'parallel-explore'], severity: 'info', text: '/explore starts three subagents together; under a cap below 3, some wait for a free slot.' },
  { mods: ['net-retry', 'loop-breaker'], severity: 'info', text: 'Commands net-retry repeats after a network error may count toward loop-breaker\'s limit of repeated failures.' },
  { mods: ['scope-lock', 'path-jail'], severity: 'info', text: 'Both restrict where Claude may write: a file has to pass both.' },
  {
    mods: ['test-watch', 'regression-guard'],
    severity: 'info',
    text: "regression-guard reads the test runs Claude makes through Bash; test-watch's own runs after edits are not seen by it.",
  },
  { mods: ['output-trimmer', 'redactor'], severity: 'ok', text: 'Both rewrite tool results. That is fine: each sees the other\'s output, and secrets stay masked.' },
  { mods: ['auto-format', 'lint-on-save'], severity: 'ok', text: 'Both run after each edit; together the file is formatted and linted.' },
  { mods: ['streaks', 'achievements'], severity: 'ok', text: 'Both count daily streaks, each on its own; they do not interfere.' },
]

/** Compares dotted versions numerically (`1.10.0` after `1.9.2`); a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const split = (version: string) => {
    const [core = '', pre] = version.trim().replace(/^v/, '').split('-', 2)
    return { parts: core.split('.').map(part => Number.parseInt(part, 10) || 0), pre }
  }
  const left = split(a)
  const right = split(b)
  for (let index = 0; index < Math.max(left.parts.length, right.parts.length); index += 1) {
    const delta = (left.parts[index] ?? 0) - (right.parts[index] ?? 0)
    if (delta !== 0) return Math.sign(delta)
  }
  if (left.pre === right.pre) return 0
  if (left.pre === undefined) return 1
  if (right.pre === undefined) return -1

  return left.pre < right.pre ? -1 : 1
}

/** Every installed plugin `claude plugin list --json` reports. */
export function parseInstalled(stdout: string): Installed[] {
  const list: unknown = JSON.parse(stdout)
  if (!Array.isArray(list)) throw new Error('claude plugin list printed no list')

  return list.flatMap(entry => {
    const record = asRecord(entry)
    const id = asText(record?.id) ?? ''
    const at = id.lastIndexOf('@')
    if (record === undefined || at <= 0) return []
    const folder = asText(record.readFromFolder) ?? asText(record.installPath)
    const plugin: Installed = {
      id,
      name: id.slice(0, at),
      marketplace: id.slice(at + 1),
      version: asText(record.version) ?? '',
      scope: asText(record.scope) ?? 'user',
      isEnabled: record.enabled !== false,
      ...(folder === undefined ? {} : { folder }),
    }
    return [plugin]
  })
}

/** The name and the plugin versions of a marketplace.json. */
export function parseMarketplace(text: string): { name: string; versions: Record<string, string> } {
  const record = asRecord(JSON.parse(text))
  const plugins = record?.plugins
  if (record === undefined || !Array.isArray(plugins)) throw new Error('not a marketplace.json')
  const versions: Record<string, string> = {}
  for (const entry of plugins) {
    const plugin = asRecord(entry)
    const name = asText(plugin?.name)
    if (name !== undefined) versions[name] = asText(plugin?.version) ?? ''
  }

  return { name: asText(record.name) ?? DEFAULT_MARKETPLACE, versions }
}

/** The installLocation of each marketplace `claude plugin marketplace list --json` reports, by name. */
export function parseMarketplaceFolders(stdout: string): Record<string, string> {
  const list: unknown = JSON.parse(stdout)
  const folders: Record<string, string> = {}
  if (!Array.isArray(list)) return folders
  for (const entry of list) {
    const record = asRecord(entry)
    const name = asText(record?.name)
    const folder = asText(record?.installLocation) ?? asText(record?.path)
    if (name !== undefined && folder !== undefined) folders[name] = folder
  }

  return folders
}

const commandsIn = (note: string): string[] =>
  [...note.matchAll(/command\.run\{command=([^}]+)\}/g)].flatMap(match => (match[1] ?? '').split('|'))

/** What a plugin's `claude plugin validate --json` report says: its load errors and what it hooks. */
export function parseProfile(stdout: string): Profile | undefined {
  let report: Record<string, unknown> | undefined
  try {
    report = asRecord(JSON.parse(stdout))
  } catch {
    return undefined
  }
  if (report === undefined || typeof report.success !== 'boolean') return undefined
  const sections = [report.manifest, ...(Array.isArray(report.contents) ? report.contents : [])].map(asRecord)
  const listOf = (section: Record<string, unknown> | undefined, field: string): unknown[] => {
    const value = section?.[field]
    return Array.isArray(value) ? value : []
  }
  const errors = sections.flatMap(section =>
    listOf(section, 'errors').flatMap(entry => {
      const message = asText(asRecord(entry)?.message)
      return message === undefined ? [] : [message]
    }),
  )
  const notes = sections.flatMap(section => listOf(section, 'notes').flatMap(note => (typeof note === 'string' ? [note] : [])))
  const hookLines = notes.filter(note => / hooks: /.test(note))

  return {
    loadErrors: report.success ? [] : errors,
    commands: [...new Set(notes.filter(note => / answers its own command: /.test(note)).flatMap(commandsIn))],
    usesStatus: notes.some(note => / calls: /.test(note) && /\$\.ui\.status\b/.test(note)),
    usesBand: hookLines.some(note => /component=[^}]*AbovePrompt/.test(note)),
    composes: hookLines.some(note => /\bprompt\.compose\b/.test(note)),
  }
}

/** The lines of a debug log that name an installed plugin and say something went wrong, newest last. */
export function debugHints(log: string, names: readonly string[]): Record<string, string[]> {
  const hints: Record<string, string[]> = {}
  for (const line of log.split('\n')) {
    if (!HINT.test(line)) continue
    for (const name of names) {
      const at = line.indexOf(`${name}: `)
      if (at < 0 || /[\w-]/.test(line.charAt(at - 1))) continue
      const hint = line.slice(at + name.length + 2).trim()
      const known = hints[name] ?? []
      if (!known.includes(hint)) hints[name] = [...known, hint].slice(-SHOWN_DETAILS)
    }
  }

  return hints
}

/** Everything a diagnosis is made from. */
export type Evidence = {
  installed: readonly Installed[]
  profiles: Readonly<Record<string, Profile | Unchecked>>
  /** Latest versions by marketplace name, then plugin name. */
  catalogs: Readonly<Record<string, Readonly<Record<string, string>>>>
  /** The claude-mods marketplace's name. */
  marketplace: string
  /** Names of the built-in commands. */
  builtins: readonly string[]
  hints: Readonly<Record<string, string[]>>
}

const plural = (count: number, word: string, many = `${word}s`): string => `${count} ${count === 1 ? word : many}`
const isChecked = (profile: Profile | Unchecked | undefined): profile is Profile => profile !== undefined && !('problem' in profile)

/** The findings for one check, most serious first. */
export function diagnose(evidence: Evidence): DoctorFinding[] {
  const findings: DoctorFinding[] = []
  const add = (finding: DoctorFinding): void => {
    findings.push(finding)
  }
  const canChange = (plugin: Installed): boolean => plugin.scope !== 'managed'
  const fix = (action: DoctorFix['action'], plugin: Installed, label: string): DoctorFix[] =>
    canChange(plugin) && !(action === 'disable' && plugin.name === SELF) ? [{ action, id: plugin.id, scope: plugin.scope, label }] : []
  const latestOf = (plugin: Installed): string | undefined => {
    const latest = evidence.catalogs[plugin.marketplace]?.[plugin.name]
    return latest !== undefined && latest !== '' && plugin.version !== '' && compareVersions(latest, plugin.version) > 0 ? latest : undefined
  }
  const enabled = evidence.installed.filter(plugin => plugin.isEnabled)
  const byName = new Map(enabled.map(plugin => [plugin.name, plugin]))

  for (const plugin of evidence.installed) {
    const profile = evidence.profiles[plugin.id]
    const latest = latestOf(plugin)
    const update = latest === undefined ? [] : fix('update', plugin, `Update to ${latest}`)
    if (isChecked(profile) && profile.loadErrors.length > 0) {
      add({
        key: `load:${plugin.id}`,
        severity: plugin.isEnabled ? 'error' : 'warning',
        title: `${plugin.name} fails to load`,
        details: profile.loadErrors.slice(0, SHOWN_DETAILS),
        fixes: [...update, ...(plugin.isEnabled ? fix('disable', plugin, 'Disable') : [])],
      })
    } else if (profile !== undefined && !isChecked(profile)) {
      add({ key: `unchecked:${plugin.id}`, severity: 'warning', title: `${plugin.name} could not be checked`, details: [profile.problem], fixes: update })
    }
    if (latest !== undefined) {
      add({
        key: `outdated:${plugin.id}`,
        severity: 'warning',
        title: `${plugin.name} ${plugin.version} → ${latest} available`,
        details: [plugin.scope === 'managed' ? 'Managed by your organization: ask your admin to update it.' : `From ${plugin.marketplace}, installed for the ${plugin.scope} scope.`],
        fixes: update,
      })
    }
    const catalog = evidence.catalogs[plugin.marketplace]
    if (plugin.marketplace === evidence.marketplace && catalog !== undefined && catalog[plugin.name] === undefined) {
      add({
        key: `unlisted:${plugin.id}`,
        severity: 'info',
        title: `${plugin.name} is no longer in the ${plugin.marketplace} catalog`,
        details: ['It may have been renamed or retired: uninstall it from /plugin if you no longer need it.'],
        fixes: [],
      })
    }
    if (!plugin.isEnabled) {
      add({ key: `disabled:${plugin.id}`, severity: 'info', title: `${plugin.name} is disabled`, details: [], fixes: fix('enable', plugin, 'Enable') })
    }
    const hints = evidence.hints[plugin.name] ?? []
    if (plugin.isEnabled && hints.length > 0) {
      add({ key: `runtime:${plugin.id}`, severity: 'warning', title: `${plugin.name} reported problems this session`, details: hints, fixes: update })
    }
  }

  const owners = new Map<string, Installed[]>()
  for (const plugin of enabled) {
    const profile = evidence.profiles[plugin.id]
    if (!isChecked(profile)) continue
    for (const command of profile.commands) {
      owners.set(command, [...(owners.get(command) ?? []), plugin])
      if (evidence.builtins.includes(command)) {
        add({
          key: `builtin:${plugin.id}:${command}`,
          severity: 'warning',
          title: `${plugin.name} registers /${command}, a built-in command`,
          details: ['Claude Code refuses a plugin command with a built-in name, so this one never runs.'],
          fixes: latestOf(plugin) === undefined ? [] : fix('update', plugin, 'Update'),
        })
      }
    }
  }
  for (const [command, plugins] of owners) {
    if (plugins.length < 2) continue
    add({
      key: `clash:${command}`,
      severity: 'error',
      title: `/${command} is registered by ${plugins.map(plugin => plugin.name).join(' and ')}`,
      details: ['Only one of them answers it. Disable the one you need least.'],
      fixes: plugins.flatMap(plugin => fix('disable', plugin, `Disable ${plugin.name}`)),
    })
  }

  for (const conflict of CONFLICTS) {
    const [first, second] = conflict.mods
    if (byName.get(first)?.marketplace !== evidence.marketplace || byName.get(second)?.marketplace !== evidence.marketplace) continue
    const pair = [byName.get(first), byName.get(second)].filter((plugin): plugin is Installed => plugin !== undefined)
    add({
      key: `pair:${first}+${second}`,
      severity: conflict.severity,
      title: `${first} + ${second}`,
      details: [conflict.text],
      fixes: conflict.severity === 'warning' ? pair.flatMap(plugin => fix('disable', plugin, `Disable ${plugin.name}`)) : [],
    })
  }

  const crowd = (key: string, limit: number, test: (profile: Profile) => boolean, what: string, advice: string): void => {
    const names = enabled.filter(plugin => {
      const profile = evidence.profiles[plugin.id]
      return isChecked(profile) && test(profile)
    }).map(plugin => plugin.name)
    if (names.length >= limit) add({ key, severity: 'info', title: `${plural(names.length, 'mod')} ${what}`, details: [names.join(', '), advice], fixes: [] })
  }
  crowd('crowd:status', CROWDED_STATUS, profile => profile.usesStatus, 'write to the status line', 'Each gets its own line: disable the ones you no longer read.')
  crowd('crowd:band', CROWDED_BANDS, profile => profile.usesBand, 'draw above the prompt', 'Their bands stack up and push the prompt down.')
  crowd('crowd:prompt', CROWDED_PROMPT, profile => profile.composes, 'add to the system prompt', 'Each adds tokens to every request; keep the ones you rely on.')

  if (evidence.installed.length === 0) {
    add({ key: 'empty', severity: 'info', title: 'No plugins are installed', details: ['Browse the collection with /mods, or /plugin.'], fixes: [] })
  } else if (!findings.some(finding => finding.severity !== 'ok')) {
    add({ key: 'healthy', severity: 'ok', title: `No problems found across ${plural(evidence.installed.length, 'plugin')}`, details: [], fixes: [] })
  }

  return findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.title.localeCompare(b.title))
}
