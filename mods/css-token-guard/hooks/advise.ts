import type { ColorLiteral, SizeLiteral } from './literals'
import { nearestColor, sameColor } from './tokens'
import type { Rgb, Tokens } from './tokens'

export type Finding = { line: number; text: string; advice: string; count: number }

const SAME = 1
const VERY_CLOSE = 6
const SIMILAR = 20

const merge = (findings: readonly Omit<Finding, 'count'>[]): Finding[] => {
  const byText = new Map<string, Finding>()
  for (const finding of findings) {
    const known = byText.get(finding.text.toLowerCase())
    if (known === undefined) byText.set(finding.text.toLowerCase(), { ...finding, count: 1 })
    else known.count += 1
  }
  return [...byText.values()]
}

/** For each hard-coded color that is not allowed: the nearest token and how near it is. */
export const adviseColors = (tokens: Tokens, literals: readonly ColorLiteral[], allowed: readonly Rgb[]): Finding[] =>
  merge(
    literals.flatMap(literal => {
      if (allowed.some(color => sameColor(color, literal.rgb))) return []
      const nearest = nearestColor(tokens.colors, literal.rgb)
      if (nearest === undefined) return []
      const { use } = nearest.token
      const { distance } = nearest
      const advice =
        sameColor(nearest.token.rgb, literal.rgb) ? `${use} (the same color)` :
        distance < SAME ? `${use} (visually identical)` :
        distance < VERY_CLOSE ? `${use} (very close)` :
        distance < SIMILAR ? `${use} (the nearest token, check that it fits)` :
        `no token is close (nearest is ${use}); add a token if this color is new`
      return [{ line: literal.line, text: literal.text, advice }]
    }),
  )

/** Pixel values that have a token of exactly that size. */
export const adviseSizes = (tokens: Tokens, literals: readonly SizeLiteral[]): Finding[] =>
  merge(
    literals.flatMap(literal => {
      const token = tokens.sizes.find(size => size.px === literal.px)
      return token === undefined ? [] : [{ line: literal.line, text: literal.text, advice: token.use }]
    }),
  )
