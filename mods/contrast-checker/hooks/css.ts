/** A declaration and where its text starts in the file. */
export type Decl = { prop: string; value: string; start: number; end: number }

/** A rule block: its header, its own declarations (not its nested blocks') and its place in the nesting. */
export type Block = { selector: string; start: number; end: number; decls: Decl[]; parent: number; atRules: string[] }

/** Blanks with spaces, keeping offsets: comments, SCSS `#{}` and JS `${}` interpolations. */
export const blankNoise = (text: string, isScss: boolean): string => {
  let out = text.replace(/\/\*[\s*\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
  if (isScss) out = out.replace(/(^|[\s;{}])\/\/[^\n]*/g, (match, lead: string) => lead + ' '.repeat(match.length - lead.length))
  let result = ''
  let index = 0
  while (index < out.length) {
    const isInterpolation = (out[index] === '#' || out[index] === '$') && out[index + 1] === '{'
    if (!isInterpolation) {
      result += out[index]
      index += 1
      continue
    }
    let depth = 0
    let end = index + 1
    for (; end < out.length; end += 1) {
      if (out[end] === '{') depth += 1
      else if (out[end] === '}' && --depth === 0) break
    }
    result += out.slice(index, end + 1).replace(/[^\n]/g, ' ')
    index = end + 1
  }
  return result
}

const DECLARATION = /^(\s*)(--[\w-]+|\$[\w-]+|-?[a-z][\w-]*)\s*:\s*([\s\S]*?)\s*$/i

const addDecl = (block: Block, segment: string, start: number): void => {
  const match = DECLARATION.exec(segment)
  if (match === null) return
  const [, lead = '', prop = '', value = ''] = match
  if (value === '') return
  block.decls.push({ prop: prop.toLowerCase().startsWith('--') ? prop : prop.toLowerCase(), value, start: start + lead.length, end: start + segment.length })
}

/**
 * Splits CSS (or SCSS/Less) into rule blocks. Block 0 is the top level: SCSS
 * variables, or the declarations of a styled-components template, named `rootLabel`.
 * `base` is where `text` starts in the file, so offsets are the file's.
 */
export const parseBlocks = (text: string, base = 0, rootLabel = '(top level)', isScss = true): Block[] => {
  const code = blankNoise(text, isScss)
  const blocks: Block[] = [{ selector: rootLabel, start: base, end: base + text.length, decls: [], parent: -1, atRules: [] }]
  const stack = [0]
  let segment = 0
  const top = (): Block => blocks[stack[stack.length - 1] ?? 0] as Block
  for (let index = 0; index < code.length; index += 1) {
    const char = code[index]
    if (char === '"' || char === "'") {
      const close = code.indexOf(char, index + 1)
      index = close === -1 ? code.length : close
    } else if (char === '{') {
      const parentIndex = stack[stack.length - 1] ?? 0
      const parent = blocks[parentIndex] as Block
      const header = code.slice(segment, index).trim()
      const lead = code.slice(segment, index).search(/\S/)
      blocks.push({
        selector: header,
        start: base + segment + Math.max(0, lead),
        end: base + code.length,
        decls: [],
        parent: parentIndex,
        atRules: header.startsWith('@') ? [...parent.atRules, header] : parent.atRules,
      })
      stack.push(blocks.length - 1)
      segment = index + 1
    } else if (char === ';' || char === '}') {
      addDecl(top(), code.slice(segment, index), base + segment)
      if (char === '}') {
        top().end = base + index + 1
        if (stack.length > 1) stack.pop()
      }
      segment = index + 1
    }
  }
  addDecl(top(), code.slice(segment), base + segment)
  return blocks
}

const DARK_SELECTOR = /\.dark\b|\.theme-dark\b|\[data-(?:theme|mode|color-scheme|bs-theme)=["']?dark["']?\]|:root\.dark/i
const THEME_ROOT = /^(?::root|html|body|:host|\*)(?![\w-])/i
const DISABLED = /:disabled|\[disabled\]|\.disabled\b|\[aria-disabled(?:=["']?true["']?)?\]|\.is-disabled\b/i

/** Whether the block, an ancestor or an enclosing @media applies only in dark mode. */
export const isDarkBlock = (blocks: readonly Block[], index: number): boolean => {
  let at = index
  while (at >= 0) {
    const block = blocks[at] as Block
    if (DARK_SELECTOR.test(block.selector) || block.atRules.some(rule => /prefers-color-scheme\s*:\s*dark/i.test(rule))) return true
    at = block.parent
  }
  return false
}

const isThemeRoot = (block: Block): boolean =>
  block.parent === -1 || THEME_ROOT.test(block.selector) || (DARK_SELECTOR.test(block.selector) && !/\s/.test(block.selector.replace(/,\s*/g, ',')))

/** Theme-wide variables: `--x` on :root/html/body (light) and their dark overrides, plus SCSS `$x` at top level. */
export type Variables = { light: Map<string, string>; dark: Map<string, string> }

export const collectVariables = (blocks: readonly Block[]): Variables => {
  const light = new Map<string, string>()
  const dark = new Map<string, string>()
  blocks.forEach((block, index) => {
    if (!isThemeRoot(block)) return
    const target = isDarkBlock(blocks, index) ? dark : light
    for (const decl of block.decls) if (decl.prop.startsWith('--') || decl.prop.startsWith('$')) target.set(decl.prop, decl.value)
  })
  return { light, dark }
}

/** `var(--a, var(--b, #fff))` → its name and fallback, parentheses balanced. */
const splitVar = (body: string): { name: string; fallback: string | undefined } => {
  let depth = 0
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === '(') depth += 1
    else if (body[index] === ')') depth -= 1
    else if (body[index] === ',' && depth === 0) return { name: body.slice(0, index).trim(), fallback: body.slice(index + 1).trim() }
  }
  return { name: body.trim(), fallback: undefined }
}

/**
 * Replaces `var(--x)` and SCSS `$x` with their values, through `lookup`,
 * recording each variable it read. Undefined when one cannot be resolved.
 */
export const resolveValue = (value: string, lookup: (name: string) => string | undefined, used: Set<string>, depth = 0): string | undefined => {
  if (depth > 10) return undefined
  let text = value
  for (;;) {
    const at = text.indexOf('var(')
    if (at === -1) break
    let close = at + 4
    for (let level = 1; close < text.length && level > 0; close += 1) {
      if (text[close] === '(') level += 1
      else if (text[close] === ')') level -= 1
    }
    const { name, fallback } = splitVar(text.slice(at + 4, close - 1))
    used.add(name)
    const raw = lookup(name) ?? fallback
    if (raw === undefined) return undefined
    const resolved = resolveValue(raw, lookup, used, depth + 1)
    if (resolved === undefined) return undefined
    text = text.slice(0, at) + resolved + text.slice(close)
  }
  const scss = /\$[\w-]+/.exec(text)
  if (scss !== null) {
    used.add(scss[0])
    const raw = lookup(scss[0])
    if (raw === undefined) return undefined
    const resolved = resolveValue(raw, lookup, used, depth + 1)
    return resolved === undefined ? undefined : resolveValue(text.replace(scss[0], resolved), lookup, used, depth + 1)
  }
  return text.trim()
}

/** The color in a `background` shorthand, or undefined when it paints an image or a gradient. */
export const backgroundColor = (value: string): string | undefined => {
  if (/url\(|gradient\(|image-set\(/i.test(value)) return undefined
  const tokens: string[] = []
  let depth = 0
  let current = ''
  for (const char of value) {
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (/\s/.test(char) && depth === 0) {
      if (current !== '') tokens.push(current)
      current = ''
    } else current += char
  }
  if (current !== '') tokens.push(current)
  return tokens.find(token => /^(?:#|rgba?\(|hsla?\(|var\(|\$[\w-]+$)/i.test(token) || /^[a-z]+$/i.test(token))
}

/** Font size in px from a CSS length or keyword; undefined for calc(), clamp() and other unknowns. */
export const fontSizePx = (value: string): number | undefined => {
  const keywords: Record<string, number> = { small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48 }
  const text = value.trim().toLowerCase()
  if (text in keywords) return keywords[text]
  const match = /^([\d.]+)(px|rem|em|pt|%)$/.exec(text)
  if (match === null) return undefined
  const amount = Number(match[1])
  return match[2] === 'px' ? amount : match[2] === 'pt' ? (amount * 4) / 3 : match[2] === '%' ? (amount * 16) / 100 : amount * 16
}

export const isBold = (value: string): boolean => /^(?:bold|bolder)$/i.test(value.trim()) || Number(value) >= 700

/** WCAG large text: 24px and up, or bold from 18.66px (14pt). */
export const isLargeText = (sizePx: number | undefined, bold: boolean): boolean => sizePx !== undefined && (sizePx >= 24 || (bold && sizePx >= 18.66))

/** What one rule says about its text: the nearest declaration of each property, own block first, then ancestors. */
export type Facts = { fg: Decl | undefined; bg: Decl | undefined; size: Decl | undefined; weight: Decl | undefined }

const nearest = (blocks: readonly Block[], index: number, props: readonly string[]): Decl | undefined => {
  let at = index
  while (at >= 0) {
    const block = blocks[at] as Block
    const own = block.decls.filter(decl => props.includes(decl.prop)).at(-1)
    if (own !== undefined) return own
    at = block.parent
  }
  return undefined
}

/** The rules worth checking: a text color and a background, at least one declared in the block itself. */
export const factsOf = (blocks: readonly Block[]): { index: number; facts: Facts }[] => {
  const found: { index: number; facts: Facts }[] = []
  blocks.forEach((block, index) => {
    if (block.selector.startsWith('@') || DISABLED.test(block.selector)) return
    if (!block.decls.some(decl => ['color', 'background', 'background-color'].includes(decl.prop))) return
    const fg = nearest(blocks, index, ['color'])
    const bg = nearest(blocks, index, ['background', 'background-color'])
    if (fg === undefined || bg === undefined) return
    found.push({ index, facts: { fg, bg, size: nearest(blocks, index, ['font-size']), weight: nearest(blocks, index, ['font-weight']) } })
  })
  return found
}

/** A variable lookup for one block: its own and its ancestors' custom properties, then the theme's. */
export const lookupFor = (blocks: readonly Block[], index: number, variables: Variables, theme: 'light' | 'dark') => (name: string): string | undefined => {
  let at = index
  while (at >= 0) {
    const local = (blocks[at] as Block).decls.filter(decl => decl.prop === name).at(-1)
    if (local !== undefined) return local.value
    at = (blocks[at] as Block).parent
  }
  return (theme === 'dark' ? variables.dark.get(name) : undefined) ?? variables.light.get(name)
}

/** Line numbers by offset for one text: the newlines are found once, then each lookup is a binary search. */
export const lineFinder = (text: string): ((offset: number) => number) => {
  const newlines: number[] = []
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) newlines.push(at)
  return offset => {
    let low = 0
    let high = newlines.length
    while (low < high) {
      const middle = (low + high) >> 1
      if ((newlines[middle] ?? Infinity) < offset) low = middle + 1
      else high = middle
    }
    return low + 1
  }
}

/** The selector a nested rule really has: `.nav` › `a` › `&:hover` → `.nav a:hover`. */
export const fullSelector = (blocks: readonly Block[], index: number): string => {
  const chain: string[] = []
  let at = index
  while (at >= 0) {
    const block = blocks[at] as Block
    if (!block.selector.startsWith('@') && !/^\(|^<style>$/.test(block.selector)) chain.unshift(block.selector)
    at = block.parent
  }
  return chain.reduce((path, part) => (path === '' ? part : part.startsWith('&') ? `${path}${part.slice(1)}` : `${path} ${part}`), '')
}
