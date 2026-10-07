import type { ModProfile, ModProfilesPlugin } from '../types'

/** This mod's own name: a profile never disables it, so /profile-mods keeps working. */
export const SELF = 'mod-profiles'
export const MAX_PROFILES = 50
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/

/** One enable or disable the CLI runs. */
export type Change = { id: string; scope: string }

/** What using a profile changes, and what it leaves alone. */
export type Plan = {
  enable: Change[]
  disable: Change[]
  /** Enabled in the profile but not installed now. */
  missing: string[]
  /** Installed now but unknown to the profile: left as they are. */
  untouched: string[]
}

/** What `/profile-mods` was asked. */
export type Request =
  | { kind: 'open' }
  | { kind: 'list' }
  | { kind: 'save' | 'use' | 'delete'; name: string }
  | { kind: 'usage'; reason: string }

export const nameOf = (id: string): string => (id.lastIndexOf('@') > 0 ? id.slice(0, id.lastIndexOf('@')) : id)
export const plural = (count: number, word: string, many = `${word}s`): string => `${count} ${count === 1 ? word : many}`

/** Why `name` cannot name a profile, or undefined when it can. */
export function profileNameProblem(name: string): string | undefined {
  if (name === '') return 'Give the profile a name, like work, personal or demo.'
  return PROFILE_NAME.test(name) ? undefined : `"${name}" is not a profile name: use up to 32 lowercase letters, digits, - and _.`
}

/** Reads `[save|use|delete <name> | list]`; a bare known verb without a name asks for one. */
export function parseRequest(args: string): Request {
  const [verb = '', name = '', ...rest] = args.trim().split(/\s+/).filter(word => word !== '')
  const action = verb.toLowerCase()
  if (action === '') return { kind: 'open' }
  if (action === 'list' || action === 'ls') return { kind: 'list' }
  if (action !== 'save' && action !== 'use' && action !== 'delete') {
    return { kind: 'usage', reason: `Unknown action "${verb}".` }
  }
  if (rest.length > 0) return { kind: 'usage', reason: 'A profile name is one word.' }
  const problem = profileNameProblem(name.toLowerCase())

  return problem === undefined ? { kind: action, name: name.toLowerCase() } : { kind: 'usage', reason: problem }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** Every installed plugin `claude plugin list --json` reports. */
export function parseInstalled(stdout: string): ModProfilesPlugin[] {
  const list: unknown = JSON.parse(stdout)
  if (!Array.isArray(list)) throw new Error('claude plugin list printed no list')

  return list.flatMap(entry => {
    const record = asRecord(entry)
    const id = typeof record?.id === 'string' ? record.id : ''
    if (record === undefined || id.lastIndexOf('@') <= 0) return []
    const plugin: ModProfilesPlugin = {
      id,
      scope: typeof record.scope === 'string' ? record.scope : 'user',
      isEnabled: record.enabled !== false,
    }
    return [plugin]
  })
}

/** The profile the installed plugins make now. */
export function profileOf(plugins: readonly ModProfilesPlugin[], savedAt: number): ModProfile {
  const ids = (isEnabled: boolean) => [...new Set(plugins.filter(plugin => plugin.isEnabled === isEnabled).map(plugin => plugin.id))].sort()
  return { enabled: ids(true), disabled: ids(false), savedAt }
}

/**
 * What using `profile` changes: plugins it had on are enabled, plugins it had
 * off are disabled. Plugins installed since it was saved are left alone, as
 * are this mod and plugins your organization manages.
 */
export function planFor(profile: ModProfile, plugins: readonly ModProfilesPlugin[]): Plan {
  const plan: Plan = { enable: [], disable: [], missing: [], untouched: [] }
  for (const plugin of plugins) {
    if (nameOf(plugin.id) === SELF || plugin.scope === 'managed') continue
    const change = { id: plugin.id, scope: plugin.scope }
    if (profile.enabled.includes(plugin.id)) {
      if (!plugin.isEnabled) plan.enable.push(change)
    } else if (profile.disabled.includes(plugin.id)) {
      if (plugin.isEnabled) plan.disable.push(change)
    } else if (!plan.untouched.includes(plugin.id)) {
      plan.untouched.push(plugin.id)
    }
  }
  const installed = new Set(plugins.map(plugin => plugin.id))
  plan.missing = profile.enabled.filter(id => !installed.has(id))

  return plan
}

export const matches = (plan: Plan): boolean => plan.enable.length === 0 && plan.disable.length === 0

/** `+2 −3`: what using a profile would change, or `matches` when nothing. */
export function changeLabel(plan: Plan): string {
  if (matches(plan)) return 'matches now'
  return [plan.enable.length > 0 ? `+${plan.enable.length}` : '', plan.disable.length > 0 ? `−${plan.disable.length}` : '']
    .filter(part => part !== '')
    .join(' ')
}

/** A list of plugin names for a sentence, the first few and a count of the rest. */
export function names(ids: readonly string[], shown = 6): string {
  const list = ids.map(nameOf)
  return list.length > shown ? `${list.slice(0, shown).join(', ')} and ${list.length - shown} more` : list.join(', ')
}

export function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} days ago`
}

/** Keeps only well-formed profiles from what the store held. */
export function readProfiles(value: unknown): Record<string, ModProfile> {
  const record = asRecord(value) ?? {}
  const profiles: Record<string, ModProfile> = {}
  const strings = (list: unknown): string[] => (Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : [])
  for (const [name, entry] of Object.entries(record)) {
    const profile = asRecord(entry)
    if (profile === undefined || profileNameProblem(name) !== undefined || typeof profile.savedAt !== 'number') continue
    profiles[name] = { enabled: strings(profile.enabled), disabled: strings(profile.disabled), savedAt: profile.savedAt }
  }

  return profiles
}
