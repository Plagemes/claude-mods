// How the hub reads on screen: the pure text of the panel's header, pills, rows and the /hub status report, shared
// by every surface and unit-tested in tests/look.test.ts. The drawing itself is in register.tsx.

import type { ModsChannel, ModsControl, ModsInstalled, ModsLevel, ModsMode, ModsNotice, ModsTab } from '../types'
import { GLYPH } from './router'

/** The colours the hub uses, by meaning (theme keys every surface knows). */
export type Tone = 'success' | 'warning' | 'error' | 'claude' | 'suggestion' | 'subtle' | 'inactive'

export const LEVEL_TONE: Record<ModsLevel, Tone> = { info: 'subtle', success: 'success', warning: 'warning', error: 'error', critical: 'error' }

export const CHANNEL_DOT: Record<ModsChannel['status'], { glyph: string; tone: Tone; hex: string; isHollow: boolean }> = {
  connected: { glyph: '●', tone: 'success', hex: '#a3d18f', isHollow: false },
  connecting: { glyph: '◐', tone: 'warning', hex: '#f0c35a', isHollow: false },
  disconnected: { glyph: '○', tone: 'inactive', hex: '#878073', isHollow: true },
  error: { glyph: '●', tone: 'error', hex: '#f47b6e', isHollow: false },
  unconfigured: { glyph: '◌', tone: 'subtle', hex: '#878073', isHollow: true },
}

const minutesLeft = (until: number, now: number): number => Math.max(1, Math.ceil((until - now) / 60_000))

/** The mode as one short pill: presence first, then Silent and Night when they hold. */
export function modePill(mode: ModsMode, now: number): { text: string; tone: Tone } {
  const presence = mode.presence === 'here' ? '● Here' : mode.presence === 'idle' ? '◐ Idle' : '○ Away'
  const parts = [presence]
  if (mode.isSilent) parts.push(mode.silentUntil === null ? 'Silent' : `Silent ${minutesLeft(mode.silentUntil, now)}m`)
  if (mode.isNight) parts.push('Night')
  const tone: Tone = mode.isSilent || mode.isNight ? 'suggestion' : mode.presence === 'here' ? 'success' : mode.presence === 'idle' ? 'warning' : 'claude'
  return { text: parts.join(' · '), tone }
}

/** Whether automatic work is held, and the line that says by whom. */
export function controlLine(control: ModsControl | null): { isHalted: boolean; text: string; tone: Tone } {
  if (control === null || control.action === 'resume') return { isHalted: false, text: 'Automatic work is running', tone: 'success' }
  const verb = control.action === 'stop' ? '⏹ Stopped' : '⏸ Paused'
  return { isHalted: true, text: `${verb} by ${control.by}: ${control.reason}${control.scope === 'all' ? ' · every session' : ''}`, tone: 'warning' }
}

/**
 * The status line entry: only what differs from a quiet afternoon (Silent, Night, away, held work), `undefined`
 * otherwise so the line stays free for the mods that need it.
 */
export function statusText(mode: ModsMode, control: ModsControl | null, now: number): string | undefined {
  const parts: string[] = []
  if (mode.isSilent) parts.push(mode.silentUntil === null ? 'silent' : `silent ${minutesLeft(mode.silentUntil, now)}m`)
  if (mode.isNight) parts.push('night')
  if (mode.presence === 'away') parts.push('away')
  if (control !== null && control.action !== 'resume') parts.push(control.action === 'stop' ? 'stopped' : 'paused')
  return parts.length === 0 ? undefined : `▪ ${parts.join(' · ')}`
}

/** How many Claude Mods are installed (the CLI's listing), or, before it came back, how many said hello. */
export function modCounts(installed: ModsInstalled): { installed: number; enabled: number; onBus: number; isListed: boolean } {
  const ours = installed.plugins.filter(plugin => plugin.marketplace === 'claude-mods')
  const isListed = installed.listedAt !== null && ours.length > 0
  return {
    installed: isListed ? ours.length : installed.hello.length,
    enabled: isListed ? ours.filter(plugin => plugin.isEnabled).length : installed.hello.length,
    onBus: installed.hello.length,
    isListed,
  }
}

export const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

/** The header's counts: `165 mods · 25 tabs · 6 channels`. */
export function headerCounts(installed: ModsInstalled, tabs: readonly ModsTab[], channels: readonly ModsChannel[]): string {
  return [plural(modCounts(installed).installed, 'mod'), plural(tabs.length, 'tab'), plural(channels.length, 'channel')].join(' · ')
}

/** `now`, `4m`, `2h`, `3d`: always three cells wide once padded, so the feed's columns hold. */
export const ago = (ms: number): string =>
  ms < 60_000 ? 'now' : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : ms < 86_400_000 ? `${Math.floor(ms / 3_600_000)}h` : `${Math.floor(ms / 86_400_000)}d`

/** One row of the activity feed, in columns: when, the level, the mod, what, and where it went. */
export function feedRow(notice: ModsNotice, now: number): { when: string; glyph: string; tone: Tone; source: string; text: string; where: string } {
  const outside = notice.targets.filter(target => target !== 'toast')
  return {
    when: ago(Math.max(0, now - notice.at)).padStart(3),
    glyph: GLYPH[notice.level],
    tone: LEVEL_TONE[notice.level],
    source: notice.source,
    text: notice.body === undefined || notice.body === '' ? notice.title : `${notice.title} — ${notice.body.replace(/\s+/g, ' ')}`,
    where: notice.held ? 'held for the morning' : outside.length > 0 ? `→ ${outside.join(', ')}` : notice.targets.length === 0 ? (notice.reason ?? 'kept here') : '',
  }
}

/** A mod's name cut or padded to the badge's width. */
export const badge = (name: string, width: number): string => (name.length > width ? `${name.slice(0, width - 1)}…` : name.padEnd(width))

const ROW = (label: string, value: string): string => `${label.padEnd(10)}${value}`

/** `/hub status`: the header line, then one aligned row each for the mode, the work, channels, tabs and mods. */
export function statusReport(input: {
  mode: ModsMode
  modeLine: string
  control: ModsControl | null
  channels: readonly ModsChannel[]
  tabs: readonly ModsTab[]
  installed: ModsInstalled
}): string {
  const counts = modCounts(input.installed)
  const work = controlLine(input.control)
  const channels =
    input.channels.length === 0
      ? 'none registered (install a bridge such as whatsapp-bridge or desktop-notify)'
      : input.channels.map(channel => `${CHANNEL_DOT[channel.status].glyph} ${channel.id} ${channel.status}`).join(' · ')
  const tabs = ['home', ...input.tabs.map(tab => tab.id)]
  return [
    '▪▪▪ Claude Mods · Hub',
    ROW('Mode', input.modeLine),
    ROW('Work', work.isHalted ? work.text : 'running'),
    ROW('Channels', channels),
    ROW('Tabs', `${tabs.length}: ${tabs.join(', ')}`),
    ROW('Mods', `${plural(counts.installed, 'mod')}${counts.isListed ? ` (${counts.enabled} enabled)` : ''} · ${counts.onBus} on the bus`),
  ].join('\n')
}
