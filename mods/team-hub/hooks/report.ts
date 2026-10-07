/** The team view as plain text: `/team show`, `/team check`, and the fallback where a pane cannot open. Pure. */
import type { TeamView } from '../types'
import { conventionLines } from './team'

const GLYPH = { installed: '✓', disabled: '○', missing: '✗' } as const

const MAX_LINES = 12

/** Conventions, mods, drift and defaults of the team, one block each. */
export function summaryText(view: TeamView): string {
  if (view.phase === 'loading') return 'Reading the team file…'
  if (view.phase === 'absent') return `No ${view.path} in this repository. /team init creates one.`
  if (view.phase === 'invalid' || view.team === null) return `${view.path} cannot be used: ${view.problems.join(' ')}`
  const { team } = view
  const lines: string[] = [`${team.name === '' ? 'Team' : team.name} · ${view.path}${view.isMaintainer ? '' : ' · read-only for you (not an owner)'}`]
  const conventions = conventionLines(team)
  lines.push('', `Conventions (${conventions.length}):`, ...(conventions.length === 0 ? ['  none yet'] : conventions.slice(0, MAX_LINES).map(line => `  - ${line}`)))
  if (conventions.length > MAX_LINES) lines.push(`  …and ${conventions.length - MAX_LINES} more`)
  lines.push('', `Recommended mods (${view.mods.length}):`)
  if (view.mods.length === 0) lines.push('  none yet')
  for (const mod of view.mods) lines.push(`  ${view.isInstalledKnown ? GLYPH[mod.state] : '?'} ${mod.name}${mod.state === 'installed' && mod.version !== '' ? ` ${mod.version}` : ''}${mod.state === 'disabled' ? ' (installed but off)' : ''}`)
  const missing = view.mods.filter(mod => mod.state === 'missing')
  if (view.isInstalledKnown && missing.length > 0) lines.push(`  Install them with /team install (${missing.map(mod => mod.name).join(', ')}).`)
  lines.push('', view.drift.length === 0 ? 'Your settings follow the team rules.' : 'Differences from the team rules:')
  for (const item of view.drift) lines.push(`  ⚠ ${item.title}: yours ${item.personal}, team ${item.team}${item.fix === undefined ? '' : ' (/team align fixes it)'}${item.hint === undefined ? '' : ` (${item.hint})`}`)
  const defaults = [
    team.guardLevel === 'off' ? '' : `guard ${team.guardLevel}`,
    ...Object.entries(team.budget).map(([key, value]) => `${key} ${value}`),
    ...Object.entries(team.notifications).map(([level, route]) => `${level} → ${route}`),
  ].filter(part => part !== '')
  lines.push('', `Team defaults: ${defaults.length === 0 ? 'none' : defaults.join(' · ')}`)
  lines.push(`Owners: ${team.owners.length === 0 ? 'nobody yet (anyone may edit)' : team.owners.join(', ')}`)
  if (view.problems.length > 0) lines.push('', `Ignored in the file: ${view.problems.join(' ')}`)
  return lines.join('\n')
}
