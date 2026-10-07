/**
 * The project safety score, 0–100, with what it is made of and the three changes that would raise it most.
 * Pure: no `$`, no I/O.
 */
import type { Level } from './policy'

export type GuardStatus = {
  name: string
  weight: 1 | 2 | 3
  isRecommended: boolean
  isRelevant: boolean
  isInstalled: boolean
  /** Installed and its stored options match the policy. */
  isConfigured: boolean
  /** Not installed, but guardian's fallback covers its critical cases. */
  isCoveredByFallback: boolean
}

export type ScoreInput = {
  level: Level
  guards: readonly GuardStatus[]
  /** risk.blocked events in this project over the window. */
  blocks: number
  /** Secrets that went into files or output without being blocked. */
  secrets: number
  /** Critical commands that ran (no guard stopped them). */
  riskyAllowed: number
  /** Whether the installed guards are known (claude plugin list answered). */
  isInstalledKnown: boolean
}

export type ScorePart = { label: string; points: number; max: number; detail: string }
export type Fix = { text: string; gain: number; action?: { kind: 'install'; name: string } | { kind: 'apply' } | { kind: 'level'; level: Level } }
export type Score = { score: number; grade: 'A' | 'B' | 'C' | 'D' | 'F'; parts: ScorePart[]; fixes: Fix[] }

export const MAX = { coverage: 55, configuration: 15, secrets: 15, risky: 10, blocks: 5 } as const
const SECRET_COST = 5
const RISKY_COST = 5
const BLOCK_COST = 1
const FALLBACK_SHARE = 0.5
const FIXES_SHOWN = 3

const round1 = (n: number): number => Math.round(n * 10) / 10
const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

const gradeOf = (score: number): Score['grade'] => (score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F')

export function computeScore(input: ScoreInput): Score {
  const wanted = input.guards.filter(guard => guard.isRecommended && guard.isRelevant)
  const totalWeight = wanted.reduce((sum, guard) => sum + guard.weight, 0)
  const coverOf = (guard: GuardStatus): number => (guard.isInstalled ? 1 : guard.isCoveredByFallback ? FALLBACK_SHARE : 0)
  const covered = wanted.reduce((sum, guard) => sum + guard.weight * coverOf(guard), 0)
  const coverage = totalWeight === 0 ? MAX.coverage : (MAX.coverage * covered) / totalWeight
  const installed = wanted.filter(guard => guard.isInstalled)
  const configuredCount = installed.filter(guard => guard.isConfigured).length
  const configuration = installed.length === 0 ? 0 : (MAX.configuration * configuredCount) / installed.length
  const secrets = Math.max(0, MAX.secrets - SECRET_COST * input.secrets)
  const risky = Math.max(0, MAX.risky - RISKY_COST * input.riskyAllowed)
  const blocks = Math.max(0, MAX.blocks - BLOCK_COST * input.blocks)

  const missing = wanted.filter(guard => !guard.isInstalled)
  const parts: ScorePart[] = [
    {
      label: 'Guards installed',
      points: round1(coverage),
      max: MAX.coverage,
      detail: !input.isInstalledKnown
        ? 'installed guards not known yet'
        : missing.length === 0
          ? `all ${wanted.length} the ${input.level} level recommends here`
          : `${wanted.length - missing.length} of ${wanted.length} recommended at ${input.level}; missing ${missing.slice(0, 4).map(guard => guard.name).join(', ')}${missing.length > 4 ? ', …' : ''}`,
    },
    {
      label: 'Guards configured',
      points: round1(configuration),
      max: MAX.configuration,
      detail: installed.length === 0 ? 'no recommended guard installed' : `${configuredCount} of ${installed.length} installed match the ${input.level} policy`,
    },
    { label: 'Secrets', points: secrets, max: MAX.secrets, detail: input.secrets === 0 ? 'none found unprotected' : `${plural(input.secrets, 'secret')} reached a file or output unblocked` },
    { label: 'Risky commands', points: risky, max: MAX.risky, detail: input.riskyAllowed === 0 ? 'none ran unguarded' : `${plural(input.riskyAllowed, 'critical command')} ran with no guard stopping it` },
    { label: 'Blocked attempts', points: blocks, max: MAX.blocks, detail: input.blocks === 0 ? 'nothing needed blocking lately' : `${plural(input.blocks, 'risky action')} blocked in the last 7 days` },
  ]
  const score = Math.max(0, Math.min(100, Math.round(coverage + configuration + secrets + risky + blocks)))

  const fixes: Fix[] = []
  for (const guard of missing) {
    const gain = totalWeight === 0 ? 0 : (MAX.coverage * guard.weight * (1 - coverOf(guard))) / totalWeight
    fixes.push({ text: `Install ${guard.name}`, gain, action: { kind: 'install', name: guard.name } })
  }
  if (configuredCount < installed.length) {
    fixes.push({ text: `Apply the ${input.level} policy to ${plural(installed.length - configuredCount, 'guard')}`, gain: MAX.configuration - configuration, action: { kind: 'apply' } })
  }
  if (input.secrets > 0) fixes.push({ text: `Rotate the ${plural(input.secrets, 'secret')} found and move them to the environment`, gain: MAX.secrets - secrets })
  if (input.riskyAllowed > 0) fixes.push({ text: 'Review the critical commands that ran (see Recent below)', gain: MAX.risky - risky })
  if (input.level !== 'strict' && missing.length === 0 && input.riskyAllowed + input.secrets > 0) {
    fixes.push({ text: 'Switch to strict for the fallback guard and tighter settings', gain: 1, action: { kind: 'level', level: 'strict' } })
  }
  fixes.sort((a, b) => b.gain - a.gain)
  return { score, grade: gradeOf(score), parts, fixes: fixes.slice(0, FIXES_SHOWN).map(fix => ({ ...fix, gain: Math.max(1, Math.round(fix.gain)) })) }
}

/** The score as one line: `72/100 (C)`. */
export const scoreLine = (score: Score): string => `${score.score}/100 (${score.grade})`
