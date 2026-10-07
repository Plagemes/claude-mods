/**
 * `.claude/team.json`: the schema, a tolerant reader that says what it ignored, a writer that keeps the file easy to
 * review in a pull request (stable key order, conventions as one line each), and the edits a maintainer can make.
 * Pure: text in, text out.
 */
import type { TeamConfig, TeamGuardLevel, TeamLevel, TeamRoute } from '../types'

export const TEAM_FILE = '.claude/team.json'
export const DEFAULT_REPOSITORY = 'plagemes/claude-mods'
export const DEFAULT_MARKETPLACE = 'claude-mods'
/** The file holds at most this much convention text. */
export const MAX_CONVENTIONS = 4_000
/** The system prompt gets at most this much of it. */
export const MAX_SECTION = 1_500
const MAX_NAME = 80
const MAX_MODS = 60
const MAX_OWNERS = 20

export const LEVELS: readonly TeamLevel[] = ['info', 'success', 'warning', 'error', 'critical']
export const ROUTES: readonly TeamRoute[] = ['off', 'terminal', 'away', 'always']
export const GUARD_LEVELS: readonly TeamGuardLevel[] = ['off', 'standard', 'strict']
export const BUDGET_KEYS = ['sessionUsd', 'sessionTokens', 'dailyUsd'] as const
export type BudgetKey = (typeof BUDGET_KEYS)[number]

const MOD_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const MARKETPLACE = /^[A-Za-z0-9_.-]+$/
const KNOWN_KEYS = new Set(['version', 'name', 'conventions', 'recommendedMods', 'marketplace', 'marketplaceName', 'guard', 'budget', 'notifications', 'owners'])

export const EMPTY_TEAM: TeamConfig = {
  version: 1,
  name: '',
  conventions: '',
  recommendedMods: [],
  marketplace: DEFAULT_REPOSITORY,
  marketplaceName: DEFAULT_MARKETPLACE,
  guardLevel: 'off',
  budget: {},
  notifications: {},
  owners: [],
  extra: {},
}

export type Parsed = { team: TeamConfig; warnings: string[] } | { error: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value)

/** Reads a team file. Anything wrong inside it is dropped and listed in `warnings`; only unreadable JSON is an error. */
export function parseTeam(text: string): Parsed {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { error: `team.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!isRecord(raw)) return { error: 'team.json must hold one JSON object.' }
  const warnings: string[] = []
  const team: TeamConfig = { ...EMPTY_TEAM, recommendedMods: [], budget: {}, notifications: {}, owners: [], extra: {} }

  if (raw.version !== undefined) {
    if (typeof raw.version === 'number' && Number.isInteger(raw.version) && raw.version >= 1) {
      team.version = raw.version
      if (raw.version > 1) warnings.push(`version ${raw.version} is newer than this mod understands (1): unknown parts are kept but not used.`)
    } else warnings.push('version: expected a whole number.')
  }
  if (raw.name !== undefined) {
    if (typeof raw.name === 'string') team.name = raw.name.trim().slice(0, MAX_NAME)
    else warnings.push('name: expected text.')
  }
  if (raw.conventions !== undefined) {
    const lines = typeof raw.conventions === 'string' ? raw.conventions : Array.isArray(raw.conventions) && raw.conventions.every(line => typeof line === 'string') ? (raw.conventions as string[]).join('\n') : undefined
    if (lines === undefined) warnings.push('conventions: expected text, or a list of lines.')
    else {
      team.conventions = lines.replace(/\r\n?/g, '\n').trim()
      if (team.conventions.length > MAX_CONVENTIONS) {
        team.conventions = team.conventions.slice(0, MAX_CONVENTIONS)
        warnings.push(`conventions: cut to ${MAX_CONVENTIONS} characters.`)
      }
    }
  }
  if (raw.recommendedMods !== undefined) {
    if (!Array.isArray(raw.recommendedMods)) warnings.push('recommendedMods: expected a list of mod names.')
    else {
      for (const name of raw.recommendedMods) {
        if (typeof name !== 'string' || !MOD_NAME.test(name)) warnings.push(`recommendedMods: ${JSON.stringify(name)} is not a mod name (lower-case letters, digits and dashes).`)
        else if (!team.recommendedMods.includes(name)) team.recommendedMods.push(name)
      }
      if (team.recommendedMods.length > MAX_MODS) {
        team.recommendedMods = team.recommendedMods.slice(0, MAX_MODS)
        warnings.push(`recommendedMods: only the first ${MAX_MODS} are used.`)
      }
    }
  }
  if (raw.marketplace !== undefined) {
    if (typeof raw.marketplace === 'string' && REPOSITORY.test(raw.marketplace)) team.marketplace = raw.marketplace
    else warnings.push('marketplace: expected a GitHub "owner/repo".')
  }
  if (raw.marketplaceName !== undefined) {
    if (typeof raw.marketplaceName === 'string' && MARKETPLACE.test(raw.marketplaceName)) team.marketplaceName = raw.marketplaceName
    else warnings.push('marketplaceName: expected the marketplace\'s name, e.g. "claude-mods".')
  }
  if (raw.guard !== undefined) {
    const level = isRecord(raw.guard) ? raw.guard.level : raw.guard
    if (isOneOf(GUARD_LEVELS, level)) team.guardLevel = level
    else warnings.push(`guard: level must be one of ${GUARD_LEVELS.join(', ')}.`)
  }
  if (raw.budget !== undefined) {
    if (!isRecord(raw.budget)) warnings.push('budget: expected an object.')
    else {
      for (const [key, value] of Object.entries(raw.budget)) {
        if (!(BUDGET_KEYS as readonly string[]).includes(key)) warnings.push(`budget.${key}: unknown (use ${BUDGET_KEYS.join(', ')}).`)
        else if (typeof value === 'number' && Number.isFinite(value) && value >= 0) team.budget[key as BudgetKey] = value
        else warnings.push(`budget.${key}: expected a number, 0 or more.`)
      }
    }
  }
  if (raw.notifications !== undefined) {
    if (!isRecord(raw.notifications)) warnings.push('notifications: expected an object like { "critical": "always" }.')
    else {
      for (const [level, route] of Object.entries(raw.notifications)) {
        if (!isOneOf(LEVELS, level)) warnings.push(`notifications.${level}: unknown level (use ${LEVELS.join(', ')}).`)
        else if (!isOneOf(ROUTES, route)) warnings.push(`notifications.${level}: route must be one of ${ROUTES.join(', ')}.`)
        else team.notifications[level] = route
      }
    }
  }
  if (raw.owners !== undefined) {
    if (!Array.isArray(raw.owners) || !raw.owners.every(owner => typeof owner === 'string')) warnings.push('owners: expected a list of emails or names.')
    else team.owners = [...new Set((raw.owners as string[]).map(owner => owner.trim()).filter(owner => owner !== ''))].slice(0, MAX_OWNERS)
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      team.extra[key] = value
      warnings.push(`${key}: not used by team-hub (kept as it is).`)
    }
  }
  return { team, warnings }
}

/** The file as text: stable key order, conventions one line per entry, defaults left out. Ends with a newline. */
export function serializeTeam(team: TeamConfig): string {
  const out: Record<string, unknown> = { version: team.version, name: team.name }
  if (team.conventions !== '') out.conventions = team.conventions.includes('\n') ? team.conventions.split('\n') : team.conventions
  out.recommendedMods = team.recommendedMods
  if (team.marketplace !== DEFAULT_REPOSITORY) out.marketplace = team.marketplace
  if (team.marketplaceName !== DEFAULT_MARKETPLACE) out.marketplaceName = team.marketplaceName
  if (team.guardLevel !== 'off') out.guard = { level: team.guardLevel }
  if (Object.keys(team.budget).length > 0) out.budget = Object.fromEntries(BUDGET_KEYS.filter(key => team.budget[key] !== undefined).map(key => [key, team.budget[key]]))
  if (Object.keys(team.notifications).length > 0) out.notifications = Object.fromEntries(LEVELS.filter(level => team.notifications[level] !== undefined).map(level => [level, team.notifications[level]]))
  if (team.owners.length > 0) out.owners = team.owners
  for (const [key, value] of Object.entries(team.extra)) out[key] = value
  return `${JSON.stringify(out, null, 2)}\n`
}

/**
 * The text added to the system prompt: the conventions, capped at a line boundary. The same file always gives the
 * same text, so the prompt cache is not disturbed. Empty when the team wrote no conventions.
 */
export function conventionsSection(team: TeamConfig): string {
  if (team.conventions === '') return ''
  let body = team.conventions
  let isCut = false
  if (body.length > MAX_SECTION) {
    const cut = body.slice(0, MAX_SECTION)
    body = cut.slice(0, Math.max(cut.lastIndexOf('\n'), MAX_SECTION >> 1))
    isCut = true
  }
  return [`# Team conventions${team.name === '' ? '' : `: ${team.name}`}`, 'The team agreed these in .claude/team.json. Follow them unless the person asks otherwise.', '', body.trimEnd(), ...(isCut ? ['', '(Shortened here; the full text is in .claude/team.json.)'] : [])].join('\n')
}

/** A starting file for a repository without one. */
export function starterTeam(name: string, owner: string): TeamConfig {
  return { ...EMPTY_TEAM, name, conventions: 'Write small commits with a clear message.\nRun the tests before opening a pull request.', recommendedMods: ['secret-shield', 'commit-composer'], owners: owner === '' ? [] : [owner] }
}

// ── Edits ────────────────────────────────────────────────────────────────────────────────────────────

export type Op =
  | { type: 'name'; value: string }
  | { type: 'addConvention'; value: string }
  | { type: 'removeConvention'; index: number }
  | { type: 'addMod'; value: string }
  | { type: 'removeMod'; value: string }
  | { type: 'guard'; value: TeamGuardLevel }
  | { type: 'budget'; key: BudgetKey; value: number | null }
  | { type: 'route'; level: TeamLevel; value: TeamRoute | null }
  | { type: 'addOwner'; value: string }
  | { type: 'removeOwner'; value: string }

export type Edited = { team: TeamConfig } | { error: string }

/** One edit applied to a copy of the team, checked the way the reader checks. */
export function applyOp(team: TeamConfig, op: Op): Edited {
  const next: TeamConfig = { ...team, recommendedMods: [...team.recommendedMods], budget: { ...team.budget }, notifications: { ...team.notifications }, owners: [...team.owners] }
  switch (op.type) {
    case 'name':
      next.name = op.value.trim().slice(0, MAX_NAME)
      return { team: next }
    case 'addConvention': {
      const line = op.value.replace(/\s+/g, ' ').trim()
      if (line === '') return { error: 'A convention cannot be empty.' }
      const joined = next.conventions === '' ? line : `${next.conventions}\n${line}`
      if (joined.length > MAX_CONVENTIONS) return { error: `Conventions are limited to ${MAX_CONVENTIONS} characters.` }
      next.conventions = joined
      return { team: next }
    }
    case 'removeConvention': {
      const lines = next.conventions.split('\n')
      if (op.index < 0 || op.index >= lines.length) return { error: 'There is no such convention.' }
      lines.splice(op.index, 1)
      next.conventions = lines.join('\n')
      return { team: next }
    }
    case 'addMod':
      if (!MOD_NAME.test(op.value)) return { error: `"${op.value}" is not a mod name (lower-case letters, digits and dashes).` }
      if (next.recommendedMods.includes(op.value)) return { error: `${op.value} is already recommended.` }
      if (next.recommendedMods.length >= MAX_MODS) return { error: `At most ${MAX_MODS} mods can be recommended.` }
      next.recommendedMods.push(op.value)
      return { team: next }
    case 'removeMod':
      if (!next.recommendedMods.includes(op.value)) return { error: `${op.value} is not in the list.` }
      next.recommendedMods = next.recommendedMods.filter(name => name !== op.value)
      return { team: next }
    case 'guard':
      next.guardLevel = op.value
      return { team: next }
    case 'budget':
      if (op.value === null) delete next.budget[op.key]
      else if (Number.isFinite(op.value) && op.value >= 0) next.budget[op.key] = op.value
      else return { error: 'A budget is a number, 0 or more.' }
      return { team: next }
    case 'route':
      if (op.value === null) delete next.notifications[op.level]
      else next.notifications[op.level] = op.value
      return { team: next }
    case 'addOwner': {
      const owner = op.value.trim()
      if (owner === '') return { error: 'An owner is an email or a name.' }
      if (next.owners.some(known => known.toLowerCase() === owner.toLowerCase())) return { error: `${owner} is already an owner.` }
      if (next.owners.length >= MAX_OWNERS) return { error: `At most ${MAX_OWNERS} owners.` }
      next.owners.push(owner)
      return { team: next }
    }
    case 'removeOwner':
      next.owners = next.owners.filter(owner => owner.toLowerCase() !== op.value.trim().toLowerCase())
      return { team: next }
  }
}

/** Whether `who` (git's email and name) may edit: owners match on either; a file with no owners yet is open to anyone. */
export function isMaintainer(team: TeamConfig, who: { email: string; name: string }): boolean {
  if (team.owners.length === 0) return true
  const candidates = [who.email, who.name].map(value => value.trim().toLowerCase()).filter(value => value !== '')
  return team.owners.some(owner => candidates.includes(owner.toLowerCase()))
}

export const conventionLines = (team: Pick<TeamConfig, 'conventions'>): string[] => (team.conventions === '' ? [] : team.conventions.split('\n'))
