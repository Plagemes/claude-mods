/** One bar of a chart: its label and one or two values (the second drawn stacked, e.g. failures over passes). */
export type Bar = { label: string; value: number; second?: number }

export type Chart = { title: string; unit: string; bars: Bar[]; legend?: [string, string] }

const WIDTH = 640
const HEIGHT = 360
const PAD = { top: 56, right: 24, bottom: 56, left: 64 }
const COLORS = { first: '#25D366', second: '#E8505B', axis: '#8A8F98', text: '#1F2328', bg: '#FFFFFF' }

const escapeXml = (text: string): string => text.replace(/[<>&"']/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[ch] ?? ch)

const formatValue = (value: number, unit: string): string =>
  unit === '$' ? `$${value >= 100 ? value.toFixed(0) : value.toFixed(2)}` : `${Number.isInteger(value) ? value : value.toFixed(1)}${unit}`

/** A bar chart as a standalone SVG document, for a local SVG→PNG converter. */
export const chartSvg = (chart: Chart): string => {
  const plotW = WIDTH - PAD.left - PAD.right
  const plotH = HEIGHT - PAD.top - PAD.bottom
  const max = Math.max(1e-9, ...chart.bars.map(bar => bar.value + (bar.second ?? 0)))
  const slot = plotW / Math.max(1, chart.bars.length)
  const barW = Math.max(4, Math.min(56, slot * 0.6))
  const y = (value: number): number => PAD.top + plotH - (value / max) * plotH
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="Helvetica, Arial, sans-serif">`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${COLORS.bg}"/>`,
    `<text x="${PAD.left}" y="32" font-size="20" font-weight="bold" fill="${COLORS.text}">${escapeXml(chart.title)}</text>`,
    `<line x1="${PAD.left}" y1="${PAD.top + plotH}" x2="${WIDTH - PAD.right}" y2="${PAD.top + plotH}" stroke="${COLORS.axis}"/>`,
    `<text x="${PAD.left - 8}" y="${PAD.top + 4}" font-size="12" text-anchor="end" fill="${COLORS.axis}">${escapeXml(formatValue(max, chart.unit))}</text>`,
    `<text x="${PAD.left - 8}" y="${PAD.top + plotH}" font-size="12" text-anchor="end" fill="${COLORS.axis}">0</text>`,
  ]
  chart.bars.forEach((bar, index) => {
    const x = PAD.left + slot * index + (slot - barW) / 2
    const top = y(bar.value)
    parts.push(`<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${(PAD.top + plotH - top).toFixed(1)}" fill="${COLORS.first}" rx="3"/>`)
    if (bar.second !== undefined && bar.second > 0) {
      const secondTop = y(bar.value + bar.second)
      parts.push(`<rect x="${x.toFixed(1)}" y="${secondTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${(top - secondTop).toFixed(1)}" fill="${COLORS.second}" rx="3"/>`)
    }
    const total = bar.value + (bar.second ?? 0)
    parts.push(`<text x="${(x + barW / 2).toFixed(1)}" y="${(y(total) - 6).toFixed(1)}" font-size="11" text-anchor="middle" fill="${COLORS.text}">${escapeXml(formatValue(total, chart.unit))}</text>`)
    parts.push(`<text x="${(x + barW / 2).toFixed(1)}" y="${PAD.top + plotH + 20}" font-size="12" text-anchor="middle" fill="${COLORS.axis}">${escapeXml(bar.label)}</text>`)
  })
  if (chart.legend !== undefined) {
    parts.push(`<rect x="${WIDTH - 220}" y="18" width="12" height="12" fill="${COLORS.first}"/><text x="${WIDTH - 202}" y="29" font-size="12" fill="${COLORS.text}">${escapeXml(chart.legend[0])}</text>`)
    parts.push(`<rect x="${WIDTH - 120}" y="18" width="12" height="12" fill="${COLORS.second}"/><text x="${WIDTH - 102}" y="29" font-size="12" fill="${COLORS.text}">${escapeXml(chart.legend[1])}</text>`)
  }
  parts.push('</svg>')
  return parts.join('\n')
}

/** The same chart as a monospace text table, for when no converter is installed. */
export const chartText = (chart: Chart): string => {
  const max = Math.max(1e-9, ...chart.bars.map(bar => bar.value + (bar.second ?? 0)))
  const rows = chart.bars.map(bar => {
    const total = bar.value + (bar.second ?? 0)
    const blocks = '█'.repeat(Math.round((total / max) * 12))
    const second = bar.second === undefined ? '' : ` (${chart.legend?.[1] ?? 'second'} ${formatValue(bar.second, chart.unit)})`
    return `${bar.label.padEnd(6)} ${blocks.padEnd(12)} ${formatValue(total, chart.unit)}${second}`
  })
  return [`*${chart.title}*`, '```', ...rows, '```'].join('\n')
}

/** The last `days` day keys up to `today` (YYYY-MM-DD), oldest first. */
export const lastDays = (today: string, days: number): string[] => {
  const [y, m, d] = today.split('-').map(Number)
  const base = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)
  return Array.from({ length: days }, (_, index) => new Date(base - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10))
}

/** Cost per day over the last week, summed over every session's stats. */
export const costChart = (byDay: Readonly<Record<string, number>>, today: string): Chart => ({
  title: 'Claude Code cost per day',
  unit: '$',
  bars: lastDays(today, 7).map(day => ({ label: day.slice(5), value: Math.round((byDay[day] ?? 0) * 100) / 100 })),
})

/** Test runs per day: passes, failures stacked. */
export const testsChart = (byDay: Readonly<Record<string, { pass: number; fail: number }>>, today: string): Chart => ({
  title: 'Test runs per day',
  unit: '',
  legend: ['pass', 'fail'],
  bars: lastDays(today, 7).map(day => ({ label: day.slice(5), value: byDay[day]?.pass ?? 0, second: byDay[day]?.fail ?? 0 })),
})

/** smart-router's daily.json (one day or a list of days) → spent vs saved per day; null when unreadable. */
export const routerChart = (value: unknown): Chart | null => {
  const days = (Array.isArray(value) ? value : [value])
    .filter((day): day is Record<string, unknown> => typeof day === 'object' && day !== null)
    .map(day => ({ date: String(day.date ?? ''), spent: Number(day.spent), saved: Number(day.saved) }))
    .filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day.date) && Number.isFinite(day.spent) && Number.isFinite(day.saved))
    .slice(-7)
  if (days.length === 0) return null
  return {
    title: 'smart-router: spent vs saved',
    unit: '$',
    legend: ['spent', 'saved'],
    bars: days.map(day => ({ label: day.date.slice(5), value: Math.round(day.spent * 100) / 100, second: Math.round(day.saved * 100) / 100 })),
  }
}
