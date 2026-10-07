export type Rgb = readonly [number, number, number]

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

const numbersIn = (args: string): number[] => [...args.matchAll(/(-?\d*\.?\d+)(%?)/g)].map(match => (match[2] === '%' ? Number(match[1]) / 100 : Number(match[1])))

/** The color a CSS color literal stands for (alpha ignored): hex, rgb(), hsl(), and the words white and black. */
export const parseColor = (text: string): Rgb | undefined => {
  const value = text.trim().toLowerCase()
  if (value === 'white') return [255, 255, 255]
  if (value === 'black') return [0, 0, 0]
  const hex = /^#([0-9a-f]{3,8})$/.exec(value)?.[1]
  if (hex !== undefined && [3, 4, 6, 8].includes(hex.length)) {
    const full = hex.length <= 4 ? [...hex].map(char => char + char).join('') : hex
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)]
  }
  const call = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(value)
  if (call === null || call[2]?.includes('var(')) return undefined
  const [first, second, third] = numbersIn(call[2] ?? '')
  if (first === undefined || second === undefined || third === undefined) return undefined
  if (call[1]?.startsWith('hsl')) return hslToRgb(first, second > 1 ? second / 100 : second, third > 1 ? third / 100 : third)
  const scale = /%/.test((call[2] ?? '').split(/[,/ ]+/)[0] ?? '') ? 255 : 1
  return [clampByte(first * scale), clampByte(second * scale), clampByte(third * scale)]
}

/** How light a color is (0 to 1) and how far from grey (chroma, 0 to 1): navy text at 39% HSL saturation still has a chroma of 0.09. */
export const lightnessOf = ([r, g, b]: Rgb): { lightness: number; chroma: number } => {
  const [max, min] = [Math.max(r, g, b) / 255, Math.min(r, g, b) / 255]
  return { lightness: (max + min) / 2, chroma: max - min }
}
