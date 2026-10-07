export type Rgb = readonly [number, number, number]

/** A design token: what it is called, what it stands for, and how to write it in code. */
export type ColorToken = { use: string; rgb: Rgb }
export type SizeToken = { use: string; px: number }
export type Tokens = { colors: ColorToken[]; sizes: SizeToken[] }

const REM_PX = 16

// ── Colors ──────────────────────────────────────────────────────────────────

const clampByte = (value: number): number => Math.max(0, Math.min(255, Math.round(value)))

const hslToRgb = (hue: number, saturation: number, lightness: number): Rgb => {
  const h = (((hue % 360) + 360) % 360) / 360
  const s = Math.max(0, Math.min(1, saturation))
  const l = Math.max(0, Math.min(1, lightness))
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (offset: number): number => {
    const t = (((h + offset) % 1) + 1) % 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    return t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p
  }
  return [clampByte(channel(1 / 3) * 255), clampByte(channel(0) * 255), clampByte(channel(-1 / 3) * 255)]
}

const numbersIn = (args: string): number[] =>
  [...args.matchAll(/(-?\d*\.?\d+)(%?)/g)].map(match => (match[2] === '%' ? Number(match[1]) / 100 : Number(match[1])))

/** The color a CSS color literal stands for (alpha ignored); undefined for anything else, `var(--x)` included. */
export const parseColor = (text: string): Rgb | undefined => {
  const value = text.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3,8})$/.exec(value)?.[1]
  if (hex !== undefined && [3, 4, 6, 8].includes(hex.length)) {
    const full = hex.length <= 4 ? [...hex].map(char => char + char).join('') : hex
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)]
  }
  const call = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(value)
  if (call === null || call[2]?.includes('var(')) return undefined
  const parts = numbersIn(call[2] ?? '')
  const [first, second, third] = parts
  if (first === undefined || second === undefined || third === undefined) return undefined
  if (call[1]?.startsWith('hsl')) return hslToRgb(first, second > 1 ? second / 100 : second, third > 1 ? third / 100 : third)
  const isPercent = /%/.test((call[2] ?? '').split(/[,/ ]+/)[0] ?? '')
  const scale = isPercent ? 255 : 1
  return [clampByte(first * scale), clampByte(second * scale), clampByte(third * scale)]
}

const linear = (channel: number): number => {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

const toLab = ([r, g, b]: Rgb): [number, number, number] => {
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)] as const
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
}

/** How far apart two colors look (CIE76 ΔE): under 1 is the same to the eye, under 3 very close, over 10 clearly different. */
export const colorDistance = (a: Rgb, b: Rgb): number => {
  const [l1, a1, b1] = toLab(a)
  const [l2, a2, b2] = toLab(b)
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2)
}

export const sameColor = (a: Rgb, b: Rgb): boolean => a[0] === b[0] && a[1] === b[1] && a[2] === b[2]

export const nearestColor = (tokens: readonly ColorToken[], rgb: Rgb): { token: ColorToken; distance: number } | undefined => {
  let best: { token: ColorToken; distance: number } | undefined
  for (const token of tokens) {
    const distance = colorDistance(token.rgb, rgb)
    if (best === undefined || distance < best.distance) best = { token, distance }
  }
  return best
}

// ── Sizes ───────────────────────────────────────────────────────────────────

export const parsePx = (text: string): number | undefined => {
  const match = /^\s*(-?\d*\.?\d+)(px|rem)\s*$/i.exec(text)
  if (match === null) return undefined
  return match[2]?.toLowerCase() === 'rem' ? Number(match[1]) * REM_PX : Number(match[1])
}

// ── Reading token files ─────────────────────────────────────────────────────

/** Custom properties (`--space-4: 16px`), Sass variables (`$brand: #36f`) and Less variables (`@brand: #36f`). */
export const parseStyleTokens = (text: string): Tokens => {
  const tokens: Tokens = { colors: [], sizes: [] }
  for (const match of text.matchAll(/^\s*(--[\w-]+|\$[\w-]+|@[\w-]+)\s*:\s*([^;}\n]+)/gm)) {
    const [, name = '', raw = ''] = match
    const value = raw.replace(/\s*!(?:default|important)\s*$/i, '').trim()
    const use = name.startsWith('--') ? `var(${name})` : name
    const rgb = parseColor(value)
    const px = parsePx(value)
    if (rgb !== undefined) tokens.colors.push({ use, rgb })
    else if (px !== undefined) tokens.sizes.push({ use, px })
  }
  return tokens
}

const WRAPPER_KEYS = new Set(['theme', 'extend'])

/**
 * String values with the object path that leads to them, read from a JS, TS or JSON file by a plain scan:
 * `colors: { brand: { 500: '#36f' } }` gives `colors.brand.500 = #36f`. Style Dictionary's `{ value }` and
 * the W3C `$value` stand for the key above them.
 */
export const parseObjectValues = (text: string): { path: string[]; value: string }[] => {
  const found: { path: string[]; value: string }[] = []
  const stack: string[] = []
  let key: string | undefined
  let isValue = false
  let index = 0

  const readString = (quote: string): string => {
    let end = index + 1
    while (end < text.length && text[end] !== quote) end += text[end] === '\\' ? 2 : 1
    const value = text.slice(index + 1, end)
    index = end + 1
    return value
  }

  while (index < text.length) {
    const char = text[index] ?? ''
    if (char === '/' && text[index + 1] === '/') {
      index = text.indexOf('\n', index) < 0 ? text.length : text.indexOf('\n', index)
    } else if (char === '/' && text[index + 1] === '*') {
      index = text.indexOf('*/', index + 2) < 0 ? text.length : text.indexOf('*/', index + 2) + 2
    } else if (char === '"' || char === "'" || char === '`') {
      const value = readString(char)
      if (isValue && key !== undefined) found.push({ path: [...stack, key], value })
      else key = value
      if (isValue) {
        isValue = false
        key = undefined
      }
    } else if (/[\w$]/.test(char)) {
      const word = /^[\w$]+/.exec(text.slice(index, index + 64))?.[0] ?? char
      index += word.length
      if (isValue) {
        // A call such as lighten(brand, 10%) is not a plain value: step over it.
        if (text[index] === '(') index = Math.max(index, text.indexOf(')', index))
        isValue = false
        key = undefined
      } else {
        key = word
      }
    } else if (char === ':') {
      isValue = key !== undefined
      index += 1
    } else if (char === '{') {
      stack.push(isValue && key !== undefined ? key : '')
      isValue = false
      key = undefined
      index += 1
    } else if (char === '}') {
      stack.pop()
      key = undefined
      isValue = false
      index += 1
    } else {
      if (char === ',') {
        key = undefined
        isValue = false
      }
      index += 1
    }
  }
  return found
}

/** Tokens from the object scan: colors anywhere, sizes under spacing/sizes/radius-like keys. How each is used depends on the file. */
export const parseObjectTokens = (text: string, file: string): Tokens => {
  const tokens: Tokens = { colors: [], sizes: [] }
  const isTailwind = /tailwind\.config/i.test(file)
  for (const { path: rawPath, value } of parseObjectValues(text)) {
    const path = rawPath.filter(part => part !== '' && !WRAPPER_KEYS.has(part))
    const last = path.at(-1)
    if (last === 'value' || last === '$value') path.pop()
    if (path.at(-1) === 'DEFAULT') path.pop()
    if (path.length === 0) continue

    const rgb = parseColor(value)
    const px = parsePx(value)
    const dotted = path.join('.')
    const hyphenated = path.slice(1).join('-')
    if (rgb !== undefined) {
      tokens.colors.push({ use: isTailwind && path[0] === 'colors' && hyphenated !== '' ? `Tailwind color ${hyphenated}` : isTailwind ? `Tailwind ${dotted}` : dotted, rgb })
    } else if (px !== undefined && /^(?:spacing|space|sizes?|radius|borderRadius|gap)\b/.test(dotted)) {
      tokens.sizes.push({ use: isTailwind ? `Tailwind ${dotted}` : dotted, px })
    }
  }
  return tokens
}

export const mergeTokens = (all: readonly Tokens[]): Tokens => ({ colors: all.flatMap(tokens => tokens.colors), sizes: all.flatMap(tokens => tokens.sizes) })
