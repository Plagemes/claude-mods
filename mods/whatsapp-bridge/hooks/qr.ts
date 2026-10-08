/**
 * The linking QR, from the PNG OpenWA serves (`GET /sessions/{id}/qr` → `data:image/png;base64,…`) to a module grid
 * the pane can draw anywhere: an SVG on the desktop, half-block characters on a terminal. Pure: no `$`.
 *
 * OpenWA renders the QR with the `qrcode` library (`toDataURL`): an 8-bit PNG, a 4-module white margin, whole pixels
 * per module. The decoder below reads any non-interlaced 8-bit PNG (grey, RGB, palette, with or without alpha).
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard base64 to bytes (the module has no `atob`); anything outside the alphabet is skipped. */
export function base64Bytes(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 3) / 4) + 3)
  let value = 0
  let bits = 0
  let n = 0
  for (const ch of text) {
    const digit = B64.indexOf(ch)
    if (digit < 0) continue
    value = ((value << 6) | digit) & 0xffffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[n] = (value >> bits) & 0xff
      n += 1
    }
  }
  return out.subarray(0, n)
}

// ── inflate (RFC 1951), after zlib's puff.c ─────────────────────────────────────────────────────

type BitReader = { data: Uint8Array; pos: number; bit: number }
type Huffman = { counts: number[]; symbols: number[] }

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const CODE_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

function bits(reader: BitReader, count: number): number {
  let value = 0
  for (let i = 0; i < count; i += 1) {
    const byte = reader.data[reader.pos]
    if (byte === undefined) throw new Error('inflate: data ends early')
    value |= ((byte >> reader.bit) & 1) << i
    reader.bit += 1
    if (reader.bit === 8) {
      reader.bit = 0
      reader.pos += 1
    }
  }
  return value
}

function huffman(lengths: readonly number[]): Huffman {
  const counts = new Array<number>(16).fill(0)
  for (const length of lengths) counts[length] = (counts[length] ?? 0) + 1
  counts[0] = 0
  const offsets = new Array<number>(16).fill(0)
  for (let len = 1; len < 16; len += 1) offsets[len] = (offsets[len - 1] ?? 0) + (counts[len - 1] ?? 0)
  const symbols = new Array<number>(lengths.length).fill(0)
  lengths.forEach((length, symbol) => {
    if (length === 0) return
    symbols[offsets[length] ?? 0] = symbol
    offsets[length] = (offsets[length] ?? 0) + 1
  })
  return { counts, symbols }
}

function decodeSymbol(reader: BitReader, table: Huffman): number {
  let code = 0
  let first = 0
  let index = 0
  for (let len = 1; len < 16; len += 1) {
    code |= bits(reader, 1)
    const count = table.counts[len] ?? 0
    if (code - count < first) return table.symbols[index + (code - first)] ?? 0
    index += count
    first = (first + count) << 1
    code <<= 1
  }
  throw new Error('inflate: bad code')
}

const FIXED_LIT = huffman(Array.from({ length: 288 }, (_, i) => (i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8)))
const FIXED_DIST = huffman(new Array<number>(30).fill(5))

function dynamicTables(reader: BitReader): [Huffman, Huffman] {
  const nlen = bits(reader, 5) + 257
  const ndist = bits(reader, 5) + 1
  const ncode = bits(reader, 4) + 4
  const codeLengths = new Array<number>(19).fill(0)
  for (let i = 0; i < ncode; i += 1) codeLengths[CODE_ORDER[i] ?? 0] = bits(reader, 3)
  const codes = huffman(codeLengths)
  const lengths: number[] = []
  while (lengths.length < nlen + ndist) {
    const symbol = decodeSymbol(reader, codes)
    if (symbol < 16) lengths.push(symbol)
    else if (symbol === 16) {
      const previous = lengths.at(-1)
      if (previous === undefined) throw new Error('inflate: repeat with no length')
      lengths.push(...new Array<number>(3 + bits(reader, 2)).fill(previous))
    } else lengths.push(...new Array<number>(symbol === 17 ? 3 + bits(reader, 3) : 11 + bits(reader, 7)).fill(0))
  }
  return [huffman(lengths.slice(0, nlen)), huffman(lengths.slice(nlen, nlen + ndist))]
}

/** Raw DEFLATE data to bytes. */
export function inflateRaw(data: Uint8Array): Uint8Array {
  const reader: BitReader = { data, pos: 0, bit: 0 }
  const out: number[] = []
  let isLast = false
  while (!isLast) {
    isLast = bits(reader, 1) === 1
    const type = bits(reader, 2)
    if (type === 0) {
      if (reader.bit !== 0) {
        reader.bit = 0
        reader.pos += 1
      }
      const length = (data[reader.pos] ?? 0) | ((data[reader.pos + 1] ?? 0) << 8)
      reader.pos += 4
      for (let i = 0; i < length; i += 1) out.push(data[reader.pos + i] ?? 0)
      reader.pos += length
      continue
    }
    if (type === 3) throw new Error('inflate: bad block type')
    const [lit, dist] = type === 1 ? [FIXED_LIT, FIXED_DIST] : dynamicTables(reader)
    for (;;) {
      const symbol = decodeSymbol(reader, lit)
      if (symbol < 256) out.push(symbol)
      else if (symbol === 256) break
      else {
        const at = symbol - 257
        const length = (LEN_BASE[at] ?? 0) + bits(reader, LEN_EXTRA[at] ?? 0)
        const code = decodeSymbol(reader, dist)
        const distance = (DIST_BASE[code] ?? 1) + bits(reader, DIST_EXTRA[code] ?? 0)
        if (distance > out.length) throw new Error('inflate: distance too far')
        for (let i = 0; i < length; i += 1) out.push(out[out.length - distance] ?? 0)
      }
    }
  }
  return Uint8Array.from(out)
}

// ── PNG ──────────────────────────────────────────────────────────────────────────────────────────

/** A decoded picture: its size and how light each pixel is (0 black … 255 white, alpha over white). */
export type Picture = { width: number; height: number; luma: (x: number, y: number) => number }

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

const u32 = (bytes: Uint8Array, at: number): number =>
  (((bytes[at] ?? 0) << 24) | ((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0)) >>> 0

/** An 8-bit, non-interlaced PNG; null for anything else or a broken file. */
export function decodePng(base64: string): Picture | null {
  try {
    const bytes = base64Bytes(base64)
    if (u32(bytes, 0) !== 0x89504e47) return null
    let width = 0
    let height = 0
    let colorType = -1
    let palette: Uint8Array = new Uint8Array(0)
    const idat: Uint8Array[] = []
    for (let at = 8; at + 8 <= bytes.length; ) {
      const length = u32(bytes, at)
      const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
      const data = bytes.subarray(at + 8, at + 8 + length)
      if (type === 'IHDR') {
        width = u32(data, 0)
        height = u32(data, 4)
        colorType = data[9] ?? -1
        if (data[8] !== 8 || data[12] !== 0) return null
      } else if (type === 'PLTE') palette = data
      else if (type === 'IDAT') idat.push(data)
      else if (type === 'IEND') break
      at += 12 + length
    }
    const channels = CHANNELS[colorType]
    if (channels === undefined || width === 0 || height === 0 || width * height > 4_000_000) return null
    const zlib = new Uint8Array(idat.reduce((sum, part) => sum + part.length, 0))
    let offset = 0
    for (const part of idat) {
      zlib.set(part, offset)
      offset += part.length
    }
    const raw = inflateRaw(zlib.subarray(2))
    const stride = width * channels
    const pixels = new Uint8Array(stride * height)
    for (let y = 0; y < height; y += 1) {
      const filter = raw[y * (stride + 1)] ?? 0
      for (let x = 0; x < stride; x += 1) {
        const value = raw[y * (stride + 1) + 1 + x] ?? 0
        const left = x >= channels ? (pixels[y * stride + x - channels] ?? 0) : 0
        const up = y > 0 ? (pixels[(y - 1) * stride + x] ?? 0) : 0
        const upLeft = x >= channels && y > 0 ? (pixels[(y - 1) * stride + x - channels] ?? 0) : 0
        let predictor = 0
        if (filter === 1) predictor = left
        else if (filter === 2) predictor = up
        else if (filter === 3) predictor = (left + up) >> 1
        else if (filter === 4) {
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
        }
        pixels[y * stride + x] = (value + predictor) & 0xff
      }
    }
    const luma = (x: number, y: number): number => {
      const at = y * stride + x * channels
      const over = (value: number, alpha: number): number => (value * alpha + 255 * (255 - alpha)) / 255
      switch (colorType) {
        case 0:
          return pixels[at] ?? 255
        case 2:
          return ((pixels[at] ?? 0) + (pixels[at + 1] ?? 0) + (pixels[at + 2] ?? 0)) / 3
        case 3: {
          const index = (pixels[at] ?? 0) * 3
          return ((palette[index] ?? 0) + (palette[index + 1] ?? 0) + (palette[index + 2] ?? 0)) / 3
        }
        case 4:
          return over(pixels[at] ?? 0, pixels[at + 1] ?? 255)
        default:
          return over(((pixels[at] ?? 0) + (pixels[at + 1] ?? 0) + (pixels[at + 2] ?? 0)) / 3, pixels[at + 3] ?? 255)
      }
    }
    return { width, height, luma }
  } catch {
    return null
  }
}

// ── QR grid ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The QR's modules, one string per row, `1` dark and `0` light, without the margin; [] when the picture is no QR.
 * Measured from the top-left finder pattern (7 modules wide) and the top-right one's far edge.
 */
export function qrModules(picture: Picture): string[] {
  const isDark = (x: number, y: number): boolean => picture.luma(x, y) < 128
  let top = -1
  let left = -1
  for (let y = 0; y < picture.height && top < 0; y += 1) {
    for (let x = 0; x < picture.width; x += 1) {
      if (isDark(x, y)) {
        top = y
        left = x
        break
      }
    }
  }
  if (top < 0) return []
  let run = 0
  while (left + run < picture.width && isDark(left + run, top)) run += 1
  let right = picture.width - 1
  while (right > left && !isDark(right, top)) right -= 1
  const size = run / 7
  const count = Math.round((right - left + 1) / size)
  if (size < 1 || count < 21 || count > 177 || (count - 17) % 4 !== 0) return []
  const rows: string[] = []
  for (let row = 0; row < count; row += 1) {
    let line = ''
    for (let column = 0; column < count; column += 1) {
      const x = Math.floor(left + (column + 0.5) * size)
      const y = Math.floor(top + (row + 0.5) * size)
      if (x >= picture.width || y >= picture.height) return []
      line += isDark(x, y) ? '1' : '0'
    }
    rows.push(line)
  }
  // The bottom-left finder must be there too, or this was not a QR.
  return rows[count - 1]?.startsWith('1111111') === true ? rows : []
}

/** The QR as an SVG (black on white, a 4-module quiet zone), crisp at any size. */
export function qrSvg(rows: readonly string[]): string {
  const quiet = 4
  const size = rows.length + quiet * 2
  let path = ''
  rows.forEach((line, y) => {
    for (const match of line.matchAll(/1+/g)) path += `M${(match.index ?? 0) + quiet} ${y + quiet}h${match[0].length}v1h-${match[0].length}z`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#ffffff"/><path fill="#000000" d="${path}"/></svg>`
}

/**
 * The QR in half-block characters, two module rows per text row, with a quiet zone of `quiet` modules.
 * `ink: 'dark'` draws the dark modules (for black text on a white background); `ink: 'light'` draws the light ones,
 * the usual way for plain text on a dark terminal.
 */
export function qrBlocks(rows: readonly string[], options: { quiet: number; ink: 'dark' | 'light' }): string[] {
  const size = rows.length + options.quiet * 2
  const isDark = (x: number, y: number): boolean => rows[y - options.quiet]?.[x - options.quiet] === '1'
  const inked = (x: number, y: number): boolean => y < size && (options.ink === 'dark' ? isDark(x, y) : !isDark(x, y))
  const lines: string[] = []
  for (let y = 0; y < size; y += 2) {
    let line = ''
    for (let x = 0; x < size; x += 1) {
      const upper = inked(x, y)
      const lower = inked(x, y + 1)
      line += upper && lower ? '█' : upper ? '▀' : lower ? '▄' : ' '
    }
    lines.push(line)
  }
  return lines
}
