import { parseColor } from './tokens'
import type { Rgb } from './tokens'

export type ColorLiteral = { text: string; rgb: Rgb; line: number }
export type SizeLiteral = { text: string; px: number; line: number }

export const ALLOW_MARKER = 'token-ok'
const MIN_PX = 3

const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g
const FUNCTION_COLOR = /\b(?:rgba?|hsla?)\([^()]*\)/gi
/** What comes before a hex-looking text that is a link, a fragment id or a var() fallback, not a color. */
const NOT_A_COLOR_BEFORE = /(?:href|src)\s*=\s*["']?$|url\(\s*["']?$|var\(\s*--[\w-]+\s*,\s*$|&$/i
const SIZE_PROPERTY =
  /(?:^|[\s{;"'])((?:padding|margin|gap|row-gap|column-gap|top|right|bottom|left|inset|width|height|min-width|max-width|min-height|max-height|font-size|line-height|border-radius|letter-spacing)(?:-[a-z]+)*|[a-z]+(?:Top|Left|Right|Bottom|Radius|Size|Gap|Width|Height|Padding|Margin))\s*:\s*([^;}\n]*)/gi

/** Lines a literal on which is fine: comments, declarations of variables themselves, and lines marked token-ok. */
const checkedLines = (text: string): { line: number; text: string }[] =>
  text
    .split('\n')
    .map((content, index) => ({ line: index + 1, text: content }))
    .filter(({ text: content }) => {
      const trimmed = content.trim()
      return !/^(?:\/\/|\/\*|\*|<!--|#\s)/.test(trimmed) && !/^(?:--|\$|@)[\w-]+\s*:/.test(trimmed) && !content.includes(ALLOW_MARKER)
    })

/** `--brand: #36f` on a line with other things: declaring a custom property is how a token gets its value. */
const withoutDeclarations = (content: string): string => content.replace(/--[\w-]+\s*:\s*[^;}]*/g, '')

export const findColorLiterals = (text: string): ColorLiteral[] => {
  const found: ColorLiteral[] = []
  for (const { line, text: original } of checkedLines(text)) {
    const content = withoutDeclarations(original)
    for (const pattern of [HEX, FUNCTION_COLOR]) {
      for (const match of content.matchAll(pattern)) {
        const index = match.index ?? 0
        const literal = match[0]
        const rgb = parseColor(literal)
        const isSelector = /^\s*\{/.test(content.slice(index + literal.length))
        if (rgb !== undefined && !isSelector && !NOT_A_COLOR_BEFORE.test(content.slice(Math.max(0, index - 24), index))) found.push({ text: literal, rgb, line })
      }
    }
  }
  return found
}

export const findSizeLiterals = (text: string): SizeLiteral[] => {
  const found: SizeLiteral[] = []
  for (const { line, text: content } of checkedLines(text)) {
    for (const property of content.matchAll(SIZE_PROPERTY)) {
      const value = property[2] ?? ''
      if (value.includes('calc(')) continue
      for (const px of value.matchAll(/(-?\d*\.?\d+)px\b/g)) {
        if (Math.abs(Number(px[1])) >= MIN_PX) found.push({ text: px[0], px: Number(px[1]), line })
      }
    }
  }
  return found
}

/** What `after` has more of than `before`, by the literal's text (case aside): the literals an edit adds. */
export const addedLiterals = <T extends { text: string }>(before: readonly T[], after: readonly T[]): T[] => {
  const available = new Map<string, number>()
  for (const literal of before) available.set(literal.text.toLowerCase(), (available.get(literal.text.toLowerCase()) ?? 0) + 1)
  return after.filter(literal => {
    const left = available.get(literal.text.toLowerCase()) ?? 0
    available.set(literal.text.toLowerCase(), left - 1)
    return left <= 0
  })
}
