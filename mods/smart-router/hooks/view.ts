// What the Router pane shows, as plain data: glyphs, colors, figures, bars. Pure: no `$` here.

import type { ThemeKey } from 'claude-code'

import type { SmartRouterFamily, SmartRouterMix, SmartRouterTier, SmartRouterTotals } from '../types'

export const TIER_GLYPH: Record<SmartRouterTier, string> = { light: '◔', standard: '◑', deep: '●' }
export const TIER_COLOR: Record<SmartRouterTier, ThemeKey> = { light: 'success', standard: 'suggestion', deep: 'claude' }
export const FAMILIES: readonly SmartRouterFamily[] = ['haiku', 'sonnet', 'opus', 'fable', 'other']
export const FAMILY_TIER: Record<SmartRouterFamily, SmartRouterTier> = { haiku: 'light', sonnet: 'standard', opus: 'deep', fable: 'deep', other: 'standard' }
const FAMILY_COLOR: Record<SmartRouterFamily, ThemeKey> = { haiku: 'success', sonnet: 'suggestion', opus: 'claude', fable: 'merged', other: 'inactive' }
/** Raster colors (0xRRGGBB) for the same families. */
const FAMILY_RGB: Record<SmartRouterFamily, number> = { haiku: 0x4ade80, sonnet: 0x60a5fa, opus: 0xd97757, fable: 0xa78bfa, other: 0x9ca3af }
const DEFAULT_COLOR = 0x01000000
const SAVED_RGB = 0x4ade80
const LOST_RGB = 0xf87171
const BAR = '█'
const SPARKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

export const familyGlyph = (family: SmartRouterFamily): string => (family === 'other' ? '○' : TIER_GLYPH[FAMILY_TIER[family]])
export const familyColor = (family: SmartRouterFamily): ThemeKey => FAMILY_COLOR[family]

export const money = (usd: number): string => {
  const size = Math.abs(usd)
  if (size === 0) return '$0'
  if (size < 0.01) return `${usd < 0 ? '-' : ''}<$0.01`
  return `${usd < 0 ? '-' : ''}$${size.toFixed(2)}`
}

export const tokens = (n: number): string =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : `${Math.round(n)}`

export const elapsed = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export const truncate = (text: string, width: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= width ? line : `${line.slice(0, Math.max(1, width - 1)).trimEnd()}…`
}

/** The header's big line: what routing saved against running every subagent on the main model. */
export function savingsLine(totals: SmartRouterTotals): { text: string; color: ThemeKey } {
  const saved = totals.baselineUsd - totals.subagentUsd
  if (totals.baselineUsd <= 0) return { text: 'Saved $0 so far', color: 'inactive' }
  const share = Math.round((Math.abs(saved) / totals.baselineUsd) * 100)
  return saved >= 0
    ? { text: `Saved ${money(saved)} (-${share}%)`, color: 'success' }
    : { text: `Extra ${money(-saved)} (+${share}%)`, color: 'warning' }
}

export type Segment = { family: SmartRouterFamily; cells: number }

/** A stacked bar `width` cells wide: each family's share, rounded by largest remainder, none lost. */
export function segmentsOf(values: readonly (readonly [SmartRouterFamily, number])[], width: number): Segment[] {
  const total = values.reduce((sum, [, value]) => sum + Math.max(0, value), 0)
  if (total <= 0 || width <= 0) return []
  const exact = values.map(([family, value]) => ({ family, share: (Math.max(0, value) / total) * width }))
  const segments = exact.map(({ family, share }) => ({ family, cells: Math.floor(share) }))
  let left = width - segments.reduce((sum, segment) => sum + segment.cells, 0)
  const order = exact.map((one, index) => ({ index, rest: one.share - Math.floor(one.share) })).sort((a, b) => b.rest - a.rest)
  for (const { index } of order) {
    if (left <= 0) break
    const segment = segments[index]
    if (segment !== undefined) segment.cells += 1
    left -= 1
  }
  return segments.filter(segment => segment.cells > 0)
}

export const callsOf = (mix: SmartRouterMix): [SmartRouterFamily, number][] => FAMILIES.map(family => [family, mix.models[family]?.calls ?? 0])
export const tokensByFamily = (mix: SmartRouterMix): [SmartRouterFamily, number][] => FAMILIES.map(family => [family, mix.models[family]?.tokens ?? 0])

/** Packs Raster cells: little-endian u32 triplets `[codePoint, foreground, background]`, base64. */
export function packCells(cells: readonly (readonly [string, number])[]): string {
  const words = new Uint32Array(cells.length * 3)
  cells.forEach(([glyph, rgb], index) => {
    words[index * 3] = glyph.codePointAt(0) ?? 0x20
    words[index * 3 + 1] = rgb
    words[index * 3 + 2] = DEFAULT_COLOR
  })
  let binary = ''
  for (const byte of new Uint8Array(words.buffer)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export const barCells = (segments: readonly Segment[]): [string, number][] =>
  segments.flatMap(segment => Array.from({ length: segment.cells }, () => [BAR, FAMILY_RGB[segment.family]] as [string, number]))

/** One spark per value: its height by the largest size, saved green and extra red. */
export function sparkCells(values: readonly number[]): [string, number][] {
  const top = Math.max(0, ...values.map(Math.abs))
  return values.map(value => {
    const level = top <= 0 ? 0 : Math.max(0, Math.min(SPARKS.length - 1, Math.ceil((Math.abs(value) / top) * SPARKS.length) - 1))
    return [SPARKS[level] ?? '▁', value < 0 ? LOST_RGB : SAVED_RGB]
  })
}

export const sparkText = (values: readonly number[]): string => sparkCells(values).map(([glyph]) => glyph).join('')

/** The status line: subagents per model family this session. */
export function statusText(mix: SmartRouterMix, isSuggesting: boolean): string | undefined {
  const parts = callsOf(mix).filter(([, calls]) => calls > 0).map(([family, calls]) => `${calls} ${family}`)
  return parts.length === 0 ? undefined : `⇄ router${isSuggesting ? ' (suggest)' : ''}: ${parts.join(' · ')}`
}
