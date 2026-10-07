import type { ScreenshotCheckCapture as Capture, ScreenshotCheckShot as Shot } from '../types'

export const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
} as const

export type ViewName = keyof typeof VIEWPORTS

/** Files the edits of which can change what the page looks like. */
export const UI_FILE = /\.(?:[cm]?[jt]sx|vue|svelte|astro|html?|css|scss|sass|less|styl|pcss|mdx)$/i
export const NOT_UI_PATH = /(?:^|[\\/])(?:node_modules|dist|build|\.next|coverage|\.claude)[\\/]|\.(?:test|spec|stories)\.[cm]?[jt]sx?$/i

/**
 * Run with `node -e` in the project, so `require` finds its Playwright:
 * argv is url, folder, stamp, full-page flag. Shoots desktop and mobile, keeps
 * console and page errors, and draws a small JPEG of each shot through a
 * canvas (for surfaces that cannot open a file). Prints one JSON object.
 */
export const CAPTURE_SCRIPT = `
const [url, dir, stamp, fullPage] = process.argv.slice(1)
let pw
try { pw = require('playwright') } catch { pw = require('@playwright/test') }
const views = [
  ['desktop', { viewport: { width: ${VIEWPORTS.desktop.width}, height: ${VIEWPORTS.desktop.height} } }, 480],
  ['mobile', { viewport: { width: ${VIEWPORTS.mobile.width}, height: ${VIEWPORTS.mobile.height} }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, 180],
]
;(async () => {
  const browser = await pw.chromium.launch()
  const out = { status: null, title: '', consoleErrors: [], pageErrors: [], shots: [] }
  try {
    for (const [name, options, thumbWidth] of views) {
      const context = await browser.newContext(options)
      const page = await context.newPage()
      if (name === 'desktop') {
        page.on('console', m => { if (m.type() === 'error' && out.consoleErrors.length < 10) out.consoleErrors.push(m.text().slice(0, 300)) })
        page.on('pageerror', e => { if (out.pageErrors.length < 10) out.pageErrors.push(String(e.message).slice(0, 300)) })
      }
      const response = await page.goto(url, { waitUntil: 'load', timeout: 30000 })
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
      await page.waitForTimeout(300)
      if (name === 'desktop') { out.status = response ? response.status() : null; out.title = await page.title() }
      const file = dir + '/' + stamp + '-' + name + '.png'
      const png = await page.screenshot({ path: file, fullPage: fullPage === '1' })
      const blank = await context.newPage()
      const thumb = await blank.evaluate(async ([b64, width]) => {
        const img = new Image()
        img.src = 'data:image/png;base64,' + b64
        await img.decode()
        const scale = width / img.width
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = Math.min(Math.round(img.height * scale), width * 2)
        canvas.getContext('2d').drawImage(img, 0, 0, img.width * scale, img.height * scale)
        return { base64: canvas.toDataURL('image/jpeg', 0.72).split(',')[1], width: canvas.width, height: canvas.height }
      }, [png.toString('base64'), thumbWidth]).catch(() => null)
      out.shots.push({ name, file, width: options.viewport.width, height: options.viewport.height, thumb })
      await context.close()
    }
  } finally {
    await browser.close()
  }
  process.stdout.write(JSON.stringify(out))
})().catch(e => { process.stderr.write(String((e && e.message) || e)); process.exit(1) })
`

/** `playwright screenshot` arguments for one view, when the project has no Playwright of its own. */
export const cliArgs = (url: string, file: string, view: ViewName, fullPage: boolean): string[] => [
  'screenshot',
  ...(view === 'desktop' ? ['--viewport-size', `${VIEWPORTS.desktop.width}, ${VIEWPORTS.desktop.height}`] : ['--device', 'iPhone 13']),
  '--wait-for-timeout',
  '500',
  ...(fullPage ? ['--full-page'] : []),
  url,
  file,
]

/** The capture script's JSON, or undefined when it is not what the script prints. */
export const parseCapture = (stdout: string): Omit<Capture, 'url' | 'at' | 'runner'> | undefined => {
  try {
    const parsed = JSON.parse(stdout) as Partial<Capture> & { shots?: Partial<Shot>[] }
    if (!Array.isArray(parsed.shots) || parsed.shots.length === 0) return undefined
    const shots = parsed.shots.filter((shot): shot is Shot => typeof shot.file === 'string' && (shot.name === 'desktop' || shot.name === 'mobile'))
    return {
      status: typeof parsed.status === 'number' ? parsed.status : null,
      title: typeof parsed.title === 'string' ? parsed.title : '',
      consoleErrors: Array.isArray(parsed.consoleErrors) ? parsed.consoleErrors.filter(item => typeof item === 'string') : [],
      pageErrors: Array.isArray(parsed.pageErrors) ? parsed.pageErrors.filter(item => typeof item === 'string') : [],
      shots: shots.map(shot => ({ ...shot, thumb: typeof shot.thumb?.base64 === 'string' ? shot.thumb : null })),
    }
  } catch {
    return undefined
  }
}

/** What Claude reads after a capture: where the files are, and what the browser complained about. */
export const captureNote = (capture: Capture, reason: string): string =>
  [
    `screenshot-check: ${reason}, ${capture.url} was captured at ${capture.shots.map(shot => `${shot.name} ${shot.width}×${shot.height}`).join(' and ')}:`,
    ...capture.shots.map(shot => `- ${shot.file}`),
    'Read these PNG files with the Read tool to see how the page really looks before saying the UI is done.',
    ...(capture.status !== null && capture.status >= 400 ? [`The page answered HTTP ${capture.status}.`] : []),
    ...(capture.pageErrors.length > 0 ? [`Uncaught errors on the page: ${capture.pageErrors.join(' | ')}`] : []),
    ...(capture.consoleErrors.length > 0 ? [`Console errors: ${capture.consoleErrors.join(' | ')}`] : []),
  ].join('\n')

/** Terminal cells for an image: cells are about twice as tall as wide. */
export const cellsFor = (width: number, height: number, columns: number, maxRows: number): { columns: number; rows: number } => {
  let cols = Math.max(4, Math.min(255, columns))
  let rows = Math.round((cols * height) / width / 2)
  if (rows > maxRows) {
    rows = maxRows
    cols = Math.max(4, Math.round((rows * 2 * width) / height))
  }
  return { columns: cols, rows: Math.max(2, Math.min(255, rows)) }
}

/** An SVG that shows a JPEG thumbnail, for surfaces that draw SVG but cannot open a file. */
export const thumbSvg = (base64: string, width: number, height: number): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image href="data:image/jpeg;base64,${base64}" width="${width}" height="${height}"/></svg>`

export const stampOf = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace(/:/g, '-')
