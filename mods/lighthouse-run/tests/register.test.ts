import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { deltaText, fixPrompt, gaugeSvg, parseReport } from '../hooks/report'
import { fakeHub } from './hub'
import { pageUrl, portsFromPackage } from '../hooks/server'

const PLUGIN = 'lighthouse-run'
const PANE_PROPS = {
  title: 'Lighthouse',
  isFocused: true,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

/** A Lighthouse 12 report cut down to the fields the mod reads. */
const report = (scores: [number, number, number, number], formFactor = 'mobile') =>
  JSON.stringify({
    lighthouseVersion: '12.8.2',
    finalDisplayedUrl: 'http://localhost:5173/',
    configSettings: { formFactor },
    runWarnings: [],
    categories: {
      performance: { score: scores[0], auditRefs: [{ id: 'first-contentful-paint', weight: 10, group: 'metrics' }, { id: 'modern-image-formats', weight: 0, group: 'diagnostics' }, { id: 'cache-insight', weight: 0, group: 'hidden' }] },
      accessibility: { score: scores[1], auditRefs: [{ id: 'image-alt', weight: 10, group: 'a11y-names-labels' }, { id: 'color-contrast', weight: 7, group: 'a11y-color-contrast' }] },
      'best-practices': { score: scores[2], auditRefs: [{ id: 'errors-in-console', weight: 1, group: 'best-practices-general' }] },
      seo: { score: scores[3], auditRefs: [{ id: 'meta-description', weight: 1, group: 'seo-content' }, { id: 'image-alt', weight: 1, group: 'seo-content' }] },
    },
    audits: {
      'first-contentful-paint': { title: 'First Contentful Paint', score: 0.4, scoreDisplayMode: 'numeric', displayValue: '3.1 s' },
      'largest-contentful-paint': { title: 'Largest Contentful Paint', score: 0.91, scoreDisplayMode: 'numeric', displayValue: '2.4 s' },
      'modern-image-formats': {
        title: 'Serve images in next-gen formats',
        description: 'Image formats like WebP and AVIF often provide better compression. [Learn more](https://web.dev/x).',
        score: 0,
        scoreDisplayMode: 'metricSavings',
        displayValue: 'Est savings of 263 KiB',
        details: { overallSavingsMs: 1500, items: [{ url: 'http://localhost:5173/big.png' }] },
        metricSavings: { LCP: 1500, FCP: 0 },
      },
      'cache-insight': { title: 'Use efficient cache lifetimes', score: 0, scoreDisplayMode: 'metricSavings', metricSavings: { LCP: 1500 } },
      'image-alt': { title: 'Image elements do not have `[alt]` attributes', description: 'Informative elements should aim for short alt text. More text.', score: 0, scoreDisplayMode: 'binary', details: { items: [{ node: { snippet: '<img src="big.png">' } }] } },
      'color-contrast': { title: 'Background and foreground colors do not have a sufficient contrast ratio.', description: 'Low-contrast text is hard to read.', score: 1, scoreDisplayMode: 'binary' },
      'errors-in-console': { title: 'Browser errors were logged to the console', description: 'Errors logged to the console indicate unresolved problems.', score: 0, scoreDisplayMode: 'binary' },
      'meta-description': { title: 'Document does not have a meta description', description: 'Meta descriptions may be included in search results.', score: 0, scoreDisplayMode: 'binary' },
    },
  })

type World = { runs: { argv: readonly string[]; env: Record<string, string> }[]; submitted: string[]; store: Map<string, unknown>; clock: ReturnType<typeof mock.clock> }

const world = (on: On, outputs: { exitCode: number; stdout: string; stderr?: string }[], options: { openPorts?: number[]; hangingPorts?: number[]; env?: Record<string, string> } = {}): World => {
  const state: World = { runs: [], submitted: [], store: new Map(), clock: mock.clock(on, { now: 1_000_000 }) }
  mock.env(on, options.env ?? { HOME: '/home/dev', USER: 'dev' })
  on('session.cwd', () => ({ value: '/work/site' }))
  on('fs.read', ($, e) => (e.path === '/work/site/package.json' ? { value: '{"scripts":{"dev":"vite --port 5199"}}' } : { deny: 'ENOENT' }))
  on('fs.exists', ($, e) => ({ value: e.path === '/home/dev/.cache/ms-playwright/chromium-1194/chrome-linux/chrome' }))
  on('fs.list', ($, e) =>
    e.path === '/home/dev/.cache/ms-playwright'
      ? { value: ['chromium-1100', 'chromium-1194', 'ffmpeg-1011'].map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }
      : { deny: 'ENOENT' },
  )
  on('http.fetch', ($, e) => {
    const port = Number(new URL(e.url).port)
    if (options.hangingPorts?.includes(port) === true) return new Promise<never>(() => undefined)
    return (options.openPorts ?? [5173]).includes(port) ? { value: { status: 200, ok: true, headers: {}, text: '<html>' } } : { deny: 'ECONNREFUSED' }
  })
  on('process.run', ($, e) => {
    state.runs.push({ argv: e.argv, env: e.init?.env ?? {} })
    const output = outputs[state.runs.length - 1] ?? { exitCode: 1, stdout: '', stderr: 'no more runs' }
    return { value: { exitCode: output.exitCode, stdout: output.stdout, stderr: output.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('store.get', ($, e) => ({ value: state.store.get(e.key) }))
  on('store.set', ($, e) => {
    state.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => {
    state.submitted.push(e.text)
    return { text: e.text }
  })
  return state
}

const lighthouse = ($: Engine, args: string) =>
  $.command.run({ command: 'lighthouse', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

const mountPane = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'lighthouse', props: PANE_PROPS })

test('reads scores, metrics and the failing audits worth fixing, biggest win first', () => {
  const result = parseReport(report([0.62, 0.81, 0.92, 0.9]))
  if ('error' in result) throw new Error(result.error)
  expect(result.scores).toEqual({ performance: 62, accessibility: 81, 'best-practices': 92, seo: 90 })
  expect(result.metrics[0]).toEqual({ label: 'FCP', value: '3.1 s', score: 0.4 })
  expect(result.audits.map(item => item.id)).toEqual(['modern-image-formats', 'image-alt', 'errors-in-console', 'meta-description'])
  expect(result.audits[0]?.displayValue).toBe('Est savings of 263 KiB')
  expect(result.audits[0]?.description).toBe('Image formats like WebP and AVIF often provide better compression.')
  expect(result.audits[1]?.items).toEqual(['<img src="big.png">'])
  expect(fixPrompt(result)).toContain('1. [performance] Serve images in next-gen formats (Est savings of 263 KiB)')
  expect(parseReport('{"runtimeError":{"code":"NO_FCP","message":"The page did not paint any content."}}')).toEqual({ error: 'Lighthouse could not load the page: The page did not paint any content.' })
  expect(gaugeSvg(95, 'SEO')).toContain('#0cce6b')
  expect([deltaText(90, 84), deltaText(80, 85), deltaText(80, 80), deltaText(80, undefined)]).toEqual(['+6', '−5', '±0', 'new'])
  expect(pageUrl('/pricing', 'http://localhost:5173/')).toBe('http://localhost:5173/pricing')
  expect(pageUrl('javascript:alert(1)', undefined)).toBeUndefined()
  expect(portsFromPackage('{"scripts":{"dev":"next dev -p 3005"}}')).toEqual([3005])
})

test('/lighthouse finds the dev server, runs Lighthouse with a Playwright Chromium and shows the scores', async ($, on) => {
  const state = world(on, [{ exitCode: 0, stdout: report([0.62, 0.81, 0.92, 0.9]) }])
  expect((await lighthouse($, '')).text).toBe('Running Lighthouse (mobile) on http://localhost:5173/: scores appear in the Lighthouse pane in 20–60 s.')
  await state.clock.settle()

  const [run] = state.runs
  expect(run?.argv.slice(0, 4)).toEqual(['npx', '--yes', 'lighthouse@12', 'http://localhost:5173/'])
  expect(run?.argv).toContain('--output=json')
  expect(run?.argv).toContain('--chrome-flags=--headless=new')
  expect(run?.env).toEqual({ CHROME_PATH: '/home/dev/.cache/ms-playwright/chromium-1194/chrome-linux/chrome' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect((await ui.find({ key: 'score:performance' }))?.text).toContain('first run')
    expect((await ui.find({ key: 'audit:modern-image-formats' }))?.text).toContain('Serve images in next-gen formats · Est savings of 263 KiB · ~1.5 s')
    if (surface === 'desktop') expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe('Performance: 62')
    else expect((await ui.find({ key: 'score:performance' }))?.text).toContain('62')
    await ui.unmount()
  }
})

test('with mods-hub: says hello and publishes the scores of each finished run', async ($, on) => {
  const state = world(on, [{ exitCode: 0, stdout: report([0.62, 0.81, 0.92, 0.9]) }, { exitCode: 1, stdout: '', stderr: 'Unable to connect' }])
  const hub = fakeHub(on, {}, state.clock)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))

  await $.session.start({ cwd: '/work/site', surface: 'terminal', isInteractive: true })
  await state.clock.advance(1_500)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['x.lighthouse-run.scores'], consumes: [] }])

  await lighthouse($, '')
  await state.clock.settle()
  expect(hub.published).toEqual([
    {
      topic: 'x.lighthouse-run.scores',
      data: { url: 'http://localhost:5173/', formFactor: 'mobile', scores: { performance: 62, accessibility: 81, 'best-practices': 92, seo: 90 } },
    },
  ])

  await lighthouse($, 'desktop')
  await state.clock.settle()
  expect(hub.published).toHaveLength(1)
})

test('a second run shows deltas, and Ask Claude sends the top issues', async ($, on) => {
  const state = world(on, [{ exitCode: 0, stdout: report([0.62, 0.81, 0.92, 0.9]) }, { exitCode: 0, stdout: report([0.7, 0.81, 0.88, 0.9]) }])
  await lighthouse($, 'localhost:5173 mobile')
  await state.clock.settle()
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'rerun' })
  await state.clock.settle()
  expect((await ui.find({ key: 'score:performance' }))?.text).toContain('+8')
  expect((await ui.find({ key: 'score:best-practices' }))?.text).toContain('−4')
  expect((await ui.find({ key: 'score:seo' }))?.text).toContain('±0')

  await ui.press({ key: 'ask' })
  expect(state.submitted[0]).toContain('Lighthouse (mobile) on http://localhost:5173/ scored Perf 70, A11y 81, Best 88, SEO 90.')
  expect(state.submitted[0]).toContain('<img src="big.png">')
})

test('desktop runs use the preset; running as root turns the sandbox off', async ($, on) => {
  const state = world(on, [{ exitCode: 0, stdout: report([0.9, 0.9, 0.9, 0.9], 'desktop') }], { env: { HOME: '/root', USER: 'root', CHROME_PATH: '/usr/bin/chromium' } })
  expect((await lighthouse($, 'https://example.com desktop')).text).toContain('Running Lighthouse (desktop) on https://example.com/')
  await state.clock.settle()
  expect(state.runs[0]?.argv).toContain('--preset=desktop')
  expect(state.runs[0]?.argv).toContain('--chrome-flags=--headless=new --no-sandbox')
  expect(state.runs[0]?.env).toEqual({ CHROME_PATH: '/usr/bin/chromium' })
})

test('failures are explained in plain words', async ($, on) => {
  const state = world(on, [
    { exitCode: 1, stdout: '', stderr: 'Runtime error encountered: waiting for dynamic debugging port in chrome-err.log\n    at checkReady (x.js:1)\n' },
    { exitCode: 1, stdout: '', stderr: 'LH:ChromeLauncher Error: net::ERR_CONNECTION_REFUSED\n' },
  ])
  await lighthouse($, 'http://localhost:4000')
  await state.clock.settle()
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'error' }))?.text).toContain('Chrome could not start')
  await ui.press({ key: 'rerun' })
  await state.clock.settle()
  expect((await ui.find({ key: 'error' }))?.text).toBe('Nothing answers at http://localhost:4000/: is the server running?')
})

test('with no URL and no dev server it says how to give one', async ($, on) => {
  const state = world(on, [], { openPorts: [] })
  expect((await lighthouse($, '')).text).toContain('No dev server answers on the usual ports')
  expect((await lighthouse($, 'ftp://example.com')).text).toBe('"ftp://example.com" is not an http(s) URL.')
  expect(state.runs).toHaveLength(0)
})

test("the project's own port comes first", async ($, on) => {
  const state = world(on, [{ exitCode: 0, stdout: report([1, 1, 1, 1]) }], { openPorts: [5173, 5199] })
  expect((await lighthouse($, '/about')).text).toContain('on http://localhost:5199/about')
  expect(state.runs).toHaveLength(0)
})

test('a port that never answers does not hide the dev server on another one', async ($, on) => {
  const state = world(on, [{ exitCode: 0, stdout: report([1, 1, 1, 1]) }], { openPorts: [5173], hangingPorts: [8080] })
  const pending = lighthouse($, '/about')
  await state.clock.advance(2_000)
  expect((await pending).text).toContain('on http://localhost:5173/about')
})
