/** A color as sRGB channels 0–255 and alpha 0–1. */
export type Rgba = { r: number; g: number; b: number; a: number }

const NAMED_TABLE = [
  'aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc bisque:ffe4c4',
  'black:000000 blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a burlywood:deb887',
  'cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc',
  'crimson:dc143c cyan:00ffff darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9',
  'darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00',
  'darkorchid:9932cc darkred:8b0000 darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b',
  'darkslategray:2f4f4f darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493',
  'deepskyblue:00bfff dimgray:696969 dimgrey:696969 dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0',
  'forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520 gray:808080',
  'green:008000 greenyellow:adff2f grey:808080 honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082',
  'ivory:fffff0 khaki:f0e68c lavender:e6e6fa lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd',
  'lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff lightgoldenrodyellow:fafad2 lightgray:d3d3d3',
  'lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 lightsalmon:ffa07a lightseagreen:20b2aa',
  'lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 lightsteelblue:b0c4de lightyellow:ffffe0',
  'lime:00ff00 limegreen:32cd32 linen:faf0e6 magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa',
  'mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db mediumseagreen:3cb371 mediumslateblue:7b68ee',
  'mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585 midnightblue:191970 mintcream:f5fffa',
  'mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead navy:000080 oldlace:fdf5e6 olive:808000 olivedrab:6b8e23',
  'orange:ffa500 orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee',
  'palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd powderblue:b0e0e6',
  'purple:800080 rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513',
  'salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee sienna:a0522d silver:c0c0c0 skyblue:87ceeb',
  'slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa springgreen:00ff7f steelblue:4682b4 tan:d2b48c',
  'teal:008080 thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff',
  'whitesmoke:f5f5f5 yellow:ffff00 yellowgreen:9acd32',
]

/** The 148 CSS named colors, name → six hex digits. */
export const NAMED: ReadonlyMap<string, string> = new Map(
  NAMED_TABLE.flatMap(line => line.split(' ').map(pair => pair.split(':') as [string, string])),
)

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))

const fromHex = (hex: string): Rgba | undefined => {
  const digits = hex.length <= 4 ? [...hex].map(digit => digit + digit).join('') : hex
  if (!/^[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(digits)) return undefined
  const channel = (at: number) => parseInt(digits.slice(at, at + 2), 16)
  return { r: channel(0), g: channel(2), b: channel(4), a: digits.length === 8 ? channel(6) / 255 : 1 }
}

/** `50%` → 0.5, `0.5` → 0.5, for alpha. */
const alphaOf = (text: string | undefined): number => {
  if (text === undefined) return 1
  const value = parseFloat(text)
  return clamp(text.trim().endsWith('%') ? value / 100 : value, 0, 1)
}

/** One rgb() channel: `255` or `100%`. */
const channelOf = (text: string): number => {
  const value = parseFloat(text)
  return clamp(Math.round(text.trim().endsWith('%') ? (value * 255) / 100 : value), 0, 255)
}

const hueOf = (text: string): number => {
  const value = parseFloat(text)
  if (/turn$/.test(text)) return value * 360
  if (/rad$/.test(text)) return (value * 180) / Math.PI
  if (/grad$/.test(text)) return value * 0.9
  return value
}

export const hslToRgb = (h: number, s: number, l: number, a = 1): Rgba => {
  const hue = ((h % 360) + 360) % 360
  const chroma = (1 - Math.abs(2 * l - 1)) * s
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = l - chroma / 2
  const [r1, g1, b1] =
    hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : hue < 180 ? [0, chroma, x] : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x]
  const to255 = (value: number) => clamp(Math.round((value + m) * 255), 0, 255)
  return { r: to255(r1), g: to255(g1), b: to255(b1), a }
}

export const rgbToHsl = ({ r, g, b }: Rgba): { h: number; s: number; l: number } => {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255]
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === rn ? ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60 : max === gn ? ((bn - rn) / d + 2) * 60 : ((rn - gn) / d + 4) * 60
  return { h, s, l }
}

/**
 * A CSS color value: hex, rgb()/rgba(), hsl()/hsla() (legacy or space syntax),
 * a named color or `transparent`. Undefined for anything else (currentColor,
 * gradients, oklch() and friends), which is then simply not checked.
 */
export const parseColor = (value: string): Rgba | undefined => {
  const text = value.trim().toLowerCase().replace(/\s*!important$/, '')
  if (text.startsWith('#')) return fromHex(text.slice(1))
  if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  const named = NAMED.get(text)
  if (named !== undefined) return fromHex(named)
  const call = /^(rgba?|hsla?)\(\s*([^)]*)\)$/.exec(text)
  if (call === null) return undefined
  const [, fn = '', body = ''] = call
  const [main = '', slashAlpha] = body.split('/')
  const parts = main.includes(',') ? main.split(',').map(part => part.trim()) : main.trim().split(/\s+/)
  const alphaText = slashAlpha ?? parts[3]
  if (parts.length < 3 || parts.slice(0, 3).some(part => part === '' || part === 'none')) return undefined
  const [first = '', second = '', third = ''] = parts
  if (fn.startsWith('rgb')) return { r: channelOf(first), g: channelOf(second), b: channelOf(third), a: alphaOf(alphaText) }
  return hslToRgb(hueOf(first), clamp(parseFloat(second) / 100, 0, 1), clamp(parseFloat(third) / 100, 0, 1), alphaOf(alphaText))
}

const linear = (channel: number): number => {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance. */
export const luminance = ({ r, g, b }: Rgba): number => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)

/** WCAG contrast ratio, 1 to 21. */
export const contrast = (a: Rgba, b: Rgba): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (light + 0.05) / (dark + 0.05)
}

/** `top` painted over an opaque `bottom`. */
export const over = (top: Rgba, bottom: Rgba): Rgba => ({
  r: Math.round(top.r * top.a + bottom.r * (1 - top.a)),
  g: Math.round(top.g * top.a + bottom.g * (1 - top.a)),
  b: Math.round(top.b * top.a + bottom.b * (1 - top.a)),
  a: 1,
})

export const toHex = ({ r, g, b }: Rgba): string => `#${[r, g, b].map(channel => channel.toString(16).padStart(2, '0')).join('')}`

/**
 * The nearest color to `color` that reaches `target` against `against`: same
 * hue and saturation, lightness moved as little as possible, darker first on a
 * light background. Undefined when neither direction gets there.
 */
export const adjustToPass = (color: Rgba, against: Rgba, target: number): Rgba | undefined => {
  const { h, s, l } = rgbToHsl(color)
  const passes = (lightness: number) => contrast(hslToRgb(h, s, lightness), against) >= target
  const extremes = luminance(against) > 0.18 ? [0, 1] : [1, 0]
  for (const extreme of extremes) {
    if (!passes(extreme)) continue
    // Contrast grows steadily toward the extreme: halve the gap to the closest lightness that passes.
    let [near, far] = [l, extreme]
    for (let step = 0; step < 24; step += 1) {
      const middle = (near + far) / 2
      if (passes(middle)) far = middle
      else near = middle
    }
    return hslToRgb(h, s, far)
  }
  return undefined
}

/** Two decimals, rounded down so 4.499 never reads as passing. */
export const ratioText = (ratio: number): string => `${(Math.floor(ratio * 100) / 100).toFixed(2)}:1`
