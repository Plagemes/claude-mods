/**
 * Where a person's own settings differ from the team's rules, and which recommended mods are missing. Pure: the team
 * file and a snapshot of the person's settings in, a list out.
 */
import type { TeamConfig, TeamDrift, TeamGuardLevel, TeamLevel, TeamMod, TeamRoute } from '../types'
import { LEVELS } from './team'

/** What the person's side looks like: `/config` rows by key, the hub's routes and the guardian policy, when known. */
export type Personal = {
  config: ReadonlyMap<string, string | number | boolean>
  /** The hub's notification routes; undefined without a hub. */
  routes: Partial<Record<TeamLevel, TeamRoute>> | undefined
  /** The guard level guardian reports (fact `guardian.policy`, see guardLevelOfPolicy), undefined when it does not say. */
  guardLevel: PersonalGuardLevel | undefined
  isGuardianInstalled: boolean
}

const ROUTE_STRENGTH: Record<TeamRoute, number> = { off: 0, terminal: 1, away: 2, always: 3 }
/** A level guardian can run at that a team file cannot ask for: `permissive`, weaker than standard. */
export type PersonalGuardLevel = TeamGuardLevel | 'permissive'
const GUARD_STRENGTH: Record<PersonalGuardLevel, number> = { off: 0, permissive: 0.5, standard: 1, strict: 2 }

/**
 * The level in guardian's fact `guardian.policy` (`{ level, base, fallback, project, guards }`, shared by guardian):
 * `permissive`, `standard` or `strict`, or `custom` built on `base`, which is the level that counts.
 */
export function guardLevelOfPolicy(fact: unknown): PersonalGuardLevel | undefined {
  if (fact === null || typeof fact !== 'object') return undefined
  const { level, base } = fact as { level?: unknown; base?: unknown }
  const effective = level === 'custom' ? base : level
  return effective === 'permissive' || effective === 'standard' || effective === 'strict' ? effective : undefined
}

/** The `/config` row each team budget limits: a limit of 0 there means "no limit". */
export const BUDGET_ROWS = {
  sessionUsd: { key: 'token-budget.budgetUsd', title: 'Session dollar budget', format: (value: number): string => `$${value}` },
  sessionTokens: { key: 'token-budget.budgetTokens', title: 'Session token budget', format: (value: number): string => value.toLocaleString('en-US') },
  dailyUsd: { key: 'daily-spend.dailyLimit', title: 'Daily dollar limit', format: (value: number): string => `$${value}` },
} as const

export function detectDrift(team: TeamConfig, personal: Personal): TeamDrift[] {
  const drift: TeamDrift[] = []
  for (const [name, row] of Object.entries(BUDGET_ROWS) as [keyof typeof BUDGET_ROWS, (typeof BUDGET_ROWS)[keyof typeof BUDGET_ROWS]][]) {
    const limit = team.budget[name]
    const mine = personal.config.get(row.key)
    // No row: the mod that owns it is not installed, which the missing-mods list already says.
    if (limit === undefined || limit <= 0 || typeof mine !== 'number') continue
    if (mine === 0 || mine > limit) {
      drift.push({ id: `budget.${name}`, title: row.title, team: row.format(limit), personal: mine === 0 ? 'no limit' : row.format(mine), fix: { key: row.key, value: limit } })
    }
  }
  if (personal.routes !== undefined) {
    for (const level of LEVELS) {
      const wanted = team.notifications[level]
      const mine = personal.routes[level]
      if (wanted === undefined || mine === undefined || ROUTE_STRENGTH[mine] >= ROUTE_STRENGTH[wanted]) continue
      drift.push({ id: `route.${level}`, title: `Notifications: ${level}`, team: wanted, personal: mine, hint: `/hub route ${level} ${wanted}` })
    }
  }
  if (team.guardLevel !== 'off') {
    if (personal.guardLevel !== undefined) {
      if (GUARD_STRENGTH[personal.guardLevel] < GUARD_STRENGTH[team.guardLevel]) {
        drift.push({ id: 'guard', title: 'Guard level', team: team.guardLevel, personal: personal.guardLevel, hint: 'Raise the level in guardian.' })
      }
    } else if (!personal.isGuardianInstalled) {
      drift.push({ id: 'guard', title: 'Guard level', team: team.guardLevel, personal: 'guardian is not installed', hint: '/team install guardian' })
    }
  }
  return drift
}

/** Each recommended mod as installed, installed but switched off, or missing. */
export function modStates(team: Pick<TeamConfig, 'recommendedMods'>, installed: ReadonlyMap<string, { version: string; isEnabled: boolean }> | undefined): TeamMod[] {
  return team.recommendedMods.map(name => {
    const found = installed?.get(name)
    return { name, state: found === undefined ? 'missing' : found.isEnabled ? 'installed' : 'disabled', version: found?.version ?? '' }
  })
}

/** The payload of `x.team-hub.drift`. */
export type DriftEvent = { count: number; items: { id: string; title: string; team: string; personal: string }[]; missingMods: string[]; disabledMods: string[] }

export function driftEvent(drift: readonly TeamDrift[], mods: readonly TeamMod[], isInstalledKnown: boolean): DriftEvent {
  return {
    count: drift.length + (isInstalledKnown ? mods.filter(mod => mod.state === 'missing').length : 0),
    items: drift.map(item => ({ id: item.id, title: item.title, team: item.team, personal: item.personal })),
    missingMods: isInstalledKnown ? mods.filter(mod => mod.state === 'missing').map(mod => mod.name) : [],
    disabledMods: isInstalledKnown ? mods.filter(mod => mod.state === 'disabled').map(mod => mod.name) : [],
  }
}

/** A short text that changes exactly when the drift does: the event is published on a change only. */
export const driftSignature = (event: DriftEvent): string => JSON.stringify([event.items.map(item => `${item.id}:${item.personal}`), event.missingMods, event.disabledMods])

/** The one-line summary the drift notification and `/team check` start with. */
export function driftSummary(event: DriftEvent): string {
  if (event.count === 0) return 'In line with the team rules.'
  const parts = [
    event.items.length > 0 ? `${event.items.length} ${event.items.length === 1 ? 'setting differs' : 'settings differ'} from the team's rules` : '',
    event.missingMods.length > 0 ? `${event.missingMods.length} recommended ${event.missingMods.length === 1 ? 'mod is' : 'mods are'} missing` : '',
  ].filter(part => part !== '')
  return `${parts.join('; ')}.`
}
