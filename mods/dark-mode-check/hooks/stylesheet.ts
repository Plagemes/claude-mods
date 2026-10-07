import { lightnessOf, parseColor } from './color'
import type { Finding } from './tailwind'

export type Decl = { prop: string; value: string; line: number }
export type Rule = { selector: string; decls: Decl[]; isDark: boolean; isLight: boolean }

const DARK_SELECTOR = /\.dark(?![\w-])|\.theme-dark|\.dark-mode|\.is-dark|\[data-(?:bs-)?(?:theme|mode)\s*=\s*["']?dark["']?\]/i
const DARK_SELECTOR_EVERYWHERE = new RegExp(DARK_SELECTOR, 'gi')
const LIGHT_SELECTOR = /\.light(?![\w-])|\.theme-light|\[data-(?:bs-)?(?:theme|mode)\s*=\s*["']?light["']?\]/i
const AT_RULES_WITH_RULES = /^@(?:media|supports|layer|container|scope|document|starting-style)\b/
const COLOR_LITERAL = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\([^()]*\)|\b(?:white|black)\b/gi

/** Colors this close to grey are the "plain" ones a dark theme has to replace; brand colors and accents work in both themes. */
const NEUTRAL_CHROMA = 0.15

const blank = (text: string): string => text.replace(/[^\n]/g, ' ')

/** Comments become spaces, so offsets and line numbers stay the same. */
const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[ \t])\/\/[^\n]*/gm, blank)

/** For Vue, Svelte and HTML: everything outside <style> blocks becomes spaces. */
export const styleBlocksOnly = (source: string): string => {
  let result = ''
  let from = 0
  for (const match of source.matchAll(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi)) {
    const index = match.index ?? 0
    const contentStart = index + (match[1]?.length ?? 0)
    result += blank(source.slice(from, contentStart)) + (match[2] ?? '')
    from = contentStart + (match[2]?.length ?? 0)
  }
  return result + blank(source.slice(from))
}

const endOfBlock = (text: string, open: number): number => {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    } else if (char === '"' || char === "'") {
      const close = text.indexOf(char, index + 1)
      if (close < 0) return -1
      index = close
    }
  }
  return -1
}

/** Flat rules from CSS or SCSS: nesting is resolved (`&`), at-rules that hold rules are entered, dark contexts are marked. */
export const parseRules = (source: string): Rule[] => {
  const text = withoutComments(source)
  const rules: Rule[] = []
  const lineAt = (offset: number): number => text.slice(0, offset).split('\n').length

  const parseBlock = (from: number, to: number, parent: string | undefined, isDark: boolean, isLight: boolean): void => {
    const decls: Decl[] = []
    const addDeclaration = (start: number, end: number): void => {
      const statement = text.slice(start, end)
      const match = /^(\s*)([a-zA-Z-]+)\s*:\s*([\s\S]*?)\s*$/.exec(statement)
      if (parent !== undefined && match?.[2] !== undefined && match[3] !== undefined && match[3] !== '') {
        decls.push({ prop: match[2].toLowerCase(), value: match[3], line: lineAt(start + (match[1]?.length ?? 0)) })
      }
    }

    let index = from
    let statementStart = from
    while (index < to) {
      const char = text[index]
      if (char === '{') {
        const close = endOfBlock(text, index)
        if (close < 0 || close > to) return
        const header = text.slice(statementStart, index).trim()
        if (header.startsWith('@')) {
          if (AT_RULES_WITH_RULES.test(header)) {
            parseBlock(index + 1, close, parent, isDark || /prefers-color-scheme\s*:\s*dark/i.test(header), isLight || /prefers-color-scheme\s*:\s*light/i.test(header))
          }
        } else if (header !== '') {
          parseBlock(index + 1, close, parent === undefined ? header : header.includes('&') ? header.replace(/&/g, parent) : `${parent} ${header}`, isDark, isLight)
        }
        index = close + 1
        statementStart = index
      } else {
        if (char === ';') {
          addDeclaration(statementStart, index)
          statementStart = index + 1
        }
        index += 1
      }
    }
    addDeclaration(statementStart, to)
    if (parent !== undefined && decls.length > 0) {
      rules.push({ selector: parent, decls, isDark: isDark || DARK_SELECTOR.test(parent), isLight: isLight || LIGHT_SELECTOR.test(parent) })
    }
  }

  parseBlock(0, text.length, undefined, false, false)
  return rules
}

/** A selector without its theme marker: `.dark .card` and `html[data-theme=dark] .card` are both `.card`. */
export const baseSelector = (selector: string): string =>
  selector.replace(DARK_SELECTOR_EVERYWHERE, ' ').replace(/^\s*(?:html|body|:root)\s*/i, '').replace(/\s*([>+~])\s*/g, ' $1 ').replace(/\s+/g, ' ').trim()

/** Which kind of color a property sets: text, background or border. */
const familyOf = (prop: string): 'text' | 'bg' | 'border' | undefined => {
  if (prop === 'color' || prop === 'caret-color' || prop === 'text-decoration-color') return 'text'
  if (prop.startsWith('background')) return 'bg'
  return prop.startsWith('border') || prop.startsWith('outline') ? 'border' : undefined
}

/** A pale surface or border, or dark text, in a plain (near grey) color: what a dark theme has to replace. */
const isLightAssuming = (family: 'text' | 'bg' | 'border', literal: string): boolean => {
  const rgb = parseColor(literal)
  if (rgb === undefined) return false
  const { lightness, chroma } = lightnessOf(rgb)
  if (chroma >= NEUTRAL_CHROMA) return false
  return family === 'text' ? lightness < 0.35 : family === 'bg' ? lightness > 0.7 : lightness > 0.6
}

/** Colors in light rules that no dark block overrides, for the same selector and kind of property. */
export const findStyleFindings = (source: string): Finding[] => {
  const rules = parseRules(source)
  const overridden = new Set(rules.filter(rule => rule.isDark).flatMap(rule => rule.decls.flatMap(decl => (familyOf(decl.prop) === undefined ? [] : [`${baseSelector(rule.selector)}|${familyOf(decl.prop)}`]))))
  const findings: Finding[] = []
  for (const rule of rules.filter(rule => !rule.isDark && !rule.isLight)) {
    const base = baseSelector(rule.selector)
    for (const decl of rule.decls) {
      const family = familyOf(decl.prop)
      const literal = family === undefined ? undefined : [...decl.value.replace(/url\([^)]*\)/gi, '').matchAll(COLOR_LITERAL)].map(match => match[0]).find(text => isLightAssuming(family, text))
      if (family === undefined || literal === undefined || overridden.has(`${base}|${family}`)) continue
      findings.push({
        line: decl.line,
        text: `${base} { ${decl.prop}: ${decl.value} }`,
        advice: 'no override in a dark block (@media (prefers-color-scheme: dark), .dark or [data-theme=dark]), or use a color variable that the dark theme redefines',
        count: 1,
        key: `${base}|${decl.prop}|${decl.value.replace(/\s+/g, ' ')}`,
      })
    }
  }
  return findings
}
