/** One bar of the chart: its value and its colour, `0xRRGGBB`. */
export type Bar = { value: number; color: number }

/** Space and the eighth blocks, from empty to full. */
const BLOCKS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
const ZERO_MARK = '·'
/** The terminal's own colour (bit 24 alone). */
const DEFAULT_COLOR = 0x01000000
const ZERO_COLOR = 0x6e6e6e
const BYTES_PER_CELL = 12

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)

  return btoa(binary)
}

/**
 * Packs a bar chart into `Raster` cells: one column per bar with `gap` empty
 * columns between, `rows` tall at an eighth of a row's resolution.
 */
export const barChartCells = (bars: readonly Bar[], rows: number, gap: number): { cells: string; columns: number } => {
  const stride = 1 + gap
  const columns = Math.max(1, bars.length * stride - gap)
  const max = Math.max(0, ...bars.map(bar => bar.value))
  const view = new DataView(new ArrayBuffer(columns * rows * BYTES_PER_CELL))

  for (let row = 0; row < rows; row += 1) {
    for (let x = 0; x < columns; x += 1) {
      const bar = x % stride === 0 ? bars[x / stride] : undefined
      const height = bar === undefined || max === 0 ? 0 : Math.max(1, Math.round((bar.value / max) * rows * 8))
      const fill = Math.min(8, Math.max(0, height - (rows - 1 - row) * 8))
      const isZeroMark = bar !== undefined && bar.value <= 0 && row === rows - 1
      const glyph = isZeroMark ? ZERO_MARK : bar !== undefined && bar.value > 0 ? (BLOCKS[fill] ?? ' ') : ' '
      const offset = (row * columns + x) * BYTES_PER_CELL

      view.setUint32(offset, glyph.codePointAt(0) ?? 32, true)
      view.setUint32(offset + 4, isZeroMark ? ZERO_COLOR : (bar?.color ?? DEFAULT_COLOR), true)
      view.setUint32(offset + 8, DEFAULT_COLOR, true)
    }
  }

  return { cells: toBase64(new Uint8Array(view.buffer)), columns }
}
