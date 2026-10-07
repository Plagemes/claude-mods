import { adjustToPass, contrast, over, parseColor, ratioText, toHex } from './color'
import { backgroundColor, collectVariables, factsOf, fontSizePx, fullSelector, isBold, isDarkBlock, isLargeText, lineFinder, lookupFor, parseBlocks, resolveValue } from './css'
import type { Block, Decl, Variables } from './css'
import { classAttributes, classColors } from './tailwind'

export type Level = 'AA' | 'AAA'

/** A color pair below the bar: where, how far off, and a color that would pass. */
export type Issue = {
  line: number
  where: string
  theme: 'dark' | null
  fg: string
  bg: string
  ratio: number
  needed: number
  isLarge: boolean
  fix: string | null
  note: string | null
}

/** A stretch of the file an edit wrote, as offsets. */
export type Range = { start: number; end: number }

const WHITE = { r: 255, g: 255, b: 255, a: 1 }
const MAX_ISSUES = 8
const STYLESHEET = /\.(?:css|scss|less|pcss|postcss)$/i
const MARKUP = /\.(?:html?|vue|svelte|astro)$/i
const SCRIPT = /\.(?:[cm]?[jt]sx?|mdx)$/i

export const isChecked = (path: string): boolean => STYLESHEET.test(path) || MARKUP.test(path) || SCRIPT.test(path)

export const needed = (level: Level, isLarge: boolean): number => (level === 'AAA' ? (isLarge ? 4.5 : 7) : isLarge ? 3 : 4.5)

type Verdict = Omit<Issue, 'line' | 'where' | 'theme'>

/** Judges text `fgValue` on `bgValue`; undefined when it passes or a color cannot be known. */
export const judge = (fgValue: string, bgValue: string, isLarge: boolean, level: Level): Verdict | undefined => {
  let bg = parseColor(bgValue)
  let fg = parseColor(fgValue)
  if (bg === undefined || fg === undefined || bg.a === 0 || fg.a === 0) return undefined
  const note = bg.a < 1 ? 'background composited over white' : null
  if (bg.a < 1) bg = over(bg, WHITE)
  if (fg.a < 1) fg = over(fg, bg)
  const ratio = contrast(fg, bg)
  const target = needed(level, isLarge)
  if (ratio >= target) return undefined
  const textFix = adjustToPass(fg, bg, target)
  const backgroundFix = textFix === undefined ? adjustToPass(bg, fg, target) : undefined
  const fix =
    textFix !== undefined
      ? `color ${toHex(textFix)} (${ratioText(contrast(textFix, bg))})`
      : backgroundFix !== undefined
        ? `background ${toHex(backgroundFix)} (${ratioText(contrast(fg, backgroundFix))})`
        : null
  return { fg: fgValue.trim(), bg: bgValue.trim(), ratio, needed: target, isLarge, fix, note }
}

const touches = (ranges: readonly Range[] | 'all', start: number, end: number): boolean =>
  ranges === 'all' || ranges.some(range => start < range.end && range.start < end)

const shorten = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** A segment of the file holding CSS: the whole sheet, a `<style>` element, a styled-components template. */
type Segment = { text: string; base: number; label: string; isScss: boolean }

/** The closing backtick of a template literal opened before `from`, `${}` skipped. */
const templateEnd = (text: string, from: number): number => {
  let depth = 0
  for (let index = from; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\\') index += 1
    else if (char === '$' && text[index + 1] === '{') {
      depth += 1
      index += 1
    } else if (char === '}' && depth > 0) depth -= 1
    else if (char === '`' && depth === 0) return index
  }
  return -1
}

const segmentsOf = (path: string, text: string): Segment[] => {
  if (STYLESHEET.test(path)) return [{ text, base: 0, label: '(top level)', isScss: /\.(?:scss|less)$/i.test(path) }]
  const segments: Segment[] = []
  for (const match of text.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi)) {
    const base = (match.index ?? 0) + match[0].indexOf('>') + 1
    segments.push({ text: match[2] ?? '', base, label: '<style>', isScss: /lang=["'](?:scss|less)["']/i.test(match[1] ?? '') })
  }
  if (SCRIPT.test(path)) {
    for (const match of text.matchAll(/\b(styled(?:\.[\w]+|\([^)`]*\))(?:\.attrs\([^`]*?\))?|css|createGlobalStyle|injectGlobal)\s*`/g)) {
      const start = (match.index ?? 0) + match[0].length
      const end = templateEnd(text, start)
      if (end !== -1) segments.push({ text: text.slice(start, end), base: start, label: match[1] ?? 'css', isScss: true })
    }
  }
  return segments
}

/** Inline styles: JSX `style={{ … }}` objects and HTML `style="…"` attributes, as one-block segments. */
const inlineStyles = (text: string): { start: number; end: number; decls: Map<string, string> }[] => {
  const found: { start: number; end: number; decls: Map<string, string> }[] = []
  const jsxProp: Record<string, string> = { color: 'color', backgroundColor: 'background-color', background: 'background', fontSize: 'font-size', fontWeight: 'font-weight' }
  for (const match of text.matchAll(/\bstyle=\{\{([\s\S]*?)\}\}/g)) {
    const decls = new Map<string, string>()
    for (const pair of (match[1] ?? '').matchAll(/\b(color|backgroundColor|background|fontSize|fontWeight)\s*:\s*(?:(['"])(.*?)\2|(\d+(?:\.\d+)?))/g)) {
      const prop = jsxProp[pair[1] ?? ''] ?? ''
      const value = pair[3] ?? (prop === 'font-size' ? `${pair[4]}px` : pair[4] ?? '')
      decls.set(prop, value)
    }
    found.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, decls })
  }
  for (const match of text.matchAll(/\bstyle\s*=\s*"([^"]*)"/g)) {
    const decls = new Map<string, string>()
    for (const part of (match[1] ?? '').split(';')) {
      const [prop = '', ...value] = part.split(':')
      if (value.length > 0) decls.set(prop.trim().toLowerCase(), value.join(':').trim())
    }
    found.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, decls })
  }
  return found
}

const mergeVariables = (all: readonly Variables[]): Variables => ({
  light: new Map(all.flatMap(variables => [...variables.light])),
  dark: new Map(all.flatMap(variables => [...variables.dark])),
})

/**
 * Every text/background pair in the file that `ranges` touch (a pair, its font
 * or a variable it reads was written there) and that misses the WCAG `level`.
 */
export const analyze = (path: string, text: string, ranges: readonly Range[] | 'all', level: Level): Issue[] => {
  const issues: Issue[] = []
  const lineOf = lineFinder(text)
  const parsed = segmentsOf(path, text).map(segment => parseBlocks(segment.text, segment.base, segment.label, segment.isScss))
  const variables = mergeVariables(parsed.map(collectVariables))
  const changedVariables = new Set(
    parsed.flatMap(blocks => blocks.flatMap(block => block.decls.filter(decl => /^(?:--|\$)/.test(decl.prop) && touches(ranges, decl.start, decl.end)).map(decl => decl.prop))),
  )

  for (const blocks of parsed) {
    for (const { index, facts } of factsOf(blocks)) {
      const block = blocks[index] as Block
      const isDark = isDarkBlock(blocks, index)
      const isWritten = [facts.fg, facts.bg, facts.size, facts.weight].some((decl: Decl | undefined) => decl !== undefined && touches(ranges, decl.start, decl.end))
      for (const theme of isDark ? (['dark'] as const) : (['light', 'dark'] as const)) {
        const used = new Set<string>()
        const lookup = lookupFor(blocks, index, variables, theme)
        const fgValue = resolveValue((facts.fg as Decl).value, lookup, used)
        const bgRaw = backgroundColor((facts.bg as Decl).value)
        const bgValue = bgRaw === undefined ? undefined : resolveValue(bgRaw, lookup, used)
        // The dark pass only matters where a variable the pair reads has a dark value.
        if (theme === 'dark' && !isDark && ![...used].some(name => variables.dark.has(name))) continue
        if (!isWritten && ![...used].some(name => changedVariables.has(name))) continue
        if (fgValue === undefined || bgValue === undefined) continue
        const size = facts.size === undefined ? undefined : fontSizePx(resolveValue(facts.size.value, lookup, used) ?? '')
        const verdict = judge(fgValue, bgValue, isLargeText(size, facts.weight !== undefined && isBold(facts.weight.value)), level)
        if (verdict === undefined) continue
        // Name the variables too, so the fix lands where the color is defined.
        const shown = (raw: string, value: string) => (raw.trim() === value ? value : `${raw.trim()} (${value})`)
        const colors = { fg: shown((facts.fg as Decl).value, fgValue), bg: shown(bgRaw ?? '', bgValue) }
        issues.push({ ...verdict, ...colors, line: lineOf(block.start), where: shorten(fullSelector(blocks, index) || block.selector, 60), theme: theme === 'dark' ? 'dark' : null })
      }
    }
  }

  if (!STYLESHEET.test(path)) {
    for (const attribute of classAttributes(text)) {
      if (!touches(ranges, attribute.start, attribute.end)) continue
      const colors = classColors(attribute.value)
      for (const theme of ['light', 'dark'] as const) {
        const fg = theme === 'dark' ? colors.dark.fg ?? colors.light.fg : colors.light.fg
        const bg = theme === 'dark' ? colors.dark.bg ?? colors.light.bg : colors.light.bg
        if (fg === undefined || bg === undefined || (theme === 'dark' && colors.dark.fg === undefined && colors.dark.bg === undefined)) continue
        const verdict = judge(fg, bg, colors.isLarge, level)
        if (verdict !== undefined) issues.push({ ...verdict, line: lineOf(attribute.start), where: `class "${shorten(attribute.value, 50)}"`, theme: theme === 'dark' ? 'dark' : null })
      }
    }
    for (const style of inlineStyles(text)) {
      const fg = style.decls.get('color')
      const bgRaw = style.decls.get('background-color') ?? style.decls.get('background')
      const bg = bgRaw === undefined ? undefined : backgroundColor(bgRaw)
      if (fg === undefined || bg === undefined || !touches(ranges, style.start, style.end)) continue
      const size = fontSizePx(style.decls.get('font-size') ?? '')
      const verdict = judge(fg, bg, isLargeText(size, isBold(style.decls.get('font-weight') ?? '')), level)
      if (verdict !== undefined) issues.push({ ...verdict, line: lineOf(style.start), where: 'inline style', theme: null })
    }
  }

  const seen = new Set<string>()
  return issues
    .filter(issue => {
      const key = `${issue.line}|${issue.where}|${issue.theme}|${issue.fg}|${issue.bg}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => a.line - b.line)
    .slice(0, MAX_ISSUES)
}

/** The note Claude reads after the edit. */
export const report = (file: string, issues: readonly Issue[], level: Level): string =>
  [
    `contrast-checker: ${file} has ${issues.length} text/background pair${issues.length === 1 ? '' : 's'} below WCAG ${level}:`,
    ...issues.map(issue => {
      const theme = issue.theme === 'dark' ? ', dark theme' : ''
      const kind = issue.isLarge ? 'large text' : 'normal text'
      const fix = issue.fix === null ? 'no single color change reaches it: change both' : `try ${issue.fix}`
      const note = issue.note === null ? '' : ` (${issue.note})`
      return `- ${issue.where} (line ${issue.line}${theme}): ${issue.fg} on ${issue.bg} is ${ratioText(issue.ratio)}${note}, needs ${issue.needed}:1 for ${kind}. ${fix[0]?.toUpperCase()}${fix.slice(1)}.`
    }),
    'Fix them unless the text is decorative, disabled or a logo.',
  ].join('\n')
