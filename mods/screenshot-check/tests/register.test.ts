import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { captureNote, cellsFor, cliArgs, parseCapture } from '../hooks/capture'

const PLUGIN = 'screenshot-check'
const ROOT = '/work/web'
const DIR = `${ROOT}/.claude/screenshots`
const NOW = Date.UTC(2026, 9, 7, 16, 20, 0)
const STAMP = '2026-10-07T16-20-00'
const PANE_PROPS = {
  title: 'Screenshots',
  isFocused: true,
  bodyColumns: 120,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 60 },
  view: {},
} as const

const scriptOutput = (consoleErrors: string[] = []) =>
  JSON.stringify({
    status: 200,
    title: 'Demo shop',
    consoleErrors,
    pageErrors: [],
    shots: [
      { name: 'desktop', file: `${DIR}/${STAMP}-desktop.png`, width: 1280, height: 800, thumb: { base64: 'AAAA', width: 480, height: 300 } },
      { name: 'mobile', file: `${DIR}/${STAMP}-mobile.png`, width: 390, height: 844, thumb: { base64: 'BBBB', width: 180, height: 360 } },
    ],
  })

type World = {
  runs: { argv: readonly string[]; cwd: string | undefined }[]
  files: Set<string>
  listing: string[]
  submitted: string[]
  toasts: string[]
  clock: ReturnType<typeof mock.clock>
}

type Options = { hasPlaywright?: boolean; openPorts?: number[]; output?: { exitCode: number; stdout: string; stderr?: string } }

const world = (on: On, options: Options = {}): World => {
  const state: World = {
    runs: [],
    files: new Set(options.hasPlaywright === false ? [] : [`${ROOT}/node_modules/playwright/package.json`]),
    listing: [],
    submitted: [],
    toasts: [],
    clock: mock.clock(on, { now: NOW }),
  }
  on('session.cwd', () => ({ value: ROOT }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('fs.exists', ($, e) => ({ value: state.files.has(e.path) }))
  on('fs.write', ($, e) => {
    state.files.add(e.path)
    return { value: undefined }
  })
  on('fs.list', () => ({ value: state.listing.map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }))
  on('http.fetch', ($, e) =>
    (options.openPorts ?? [3000]).includes(Number(new URL(e.url).port)) ? { value: { status: 200, ok: true, headers: {}, text: '' } } : { deny: 'ECONNREFUSED' },
  )
  on('process.run', ($, e) => {
    state.runs.push({ argv: e.argv, cwd: e.init?.cwd })
    const output = e.argv[0] === 'rm' ? { exitCode: 0, stdout: '' } : options.output ?? { exitCode: 0, stdout: e.argv[0] === 'node' ? scriptOutput() : 'Capturing screenshot' }
    return { value: { exitCode: output.exitCode, stdout: output.stdout, stderr: 'stderr' in output ? output.stderr ?? '' : '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    state.submitted.push(e.text)
    return { text: e.text }
  })
  on('tool.call', () => ({ result: 'ok' }))
  return state
}

const screenshot = ($: Engine, args = '') =>
  $.command.run({ command: 'screenshot', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 180 } })

const mountPane = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'screenshots', props: PANE_PROPS })

test('sizes images for terminal cells and reads the capture script', () => {
  expect(cellsFor(1280, 800, 80, 40)).toEqual({ columns: 80, rows: 25 })
  expect(cellsFor(390, 844, 80, 30)).toEqual({ columns: 28, rows: 30 })
  expect(cliArgs('http://localhost:3000/', '/tmp/m.png', 'mobile', true)).toEqual(['screenshot', '--device', 'iPhone 13', '--wait-for-timeout', '500', '--full-page', 'http://localhost:3000/', '/tmp/m.png'])
  expect(parseCapture('not json')).toBeUndefined()
  const parsed = parseCapture(scriptOutput(['Uncaught TypeError: x is undefined']))
  expect(parsed?.shots.map(shot => shot.name)).toEqual(['desktop', 'mobile'])
  const note = parsed === undefined ? '' : captureNote({ ...parsed, url: 'http://localhost:3000/', at: NOW, runner: 'project' }, 'After your edits to App.tsx')
  expect(note).toContain('screenshot-check: After your edits to App.tsx, http://localhost:3000/ was captured at desktop 1280×800 and mobile 390×844:')
  expect(note).toContain(`- ${DIR}/${STAMP}-mobile.png`)
  expect(note).toContain('Read these PNG files with the Read tool')
  expect(note).toContain('Console errors: Uncaught TypeError: x is undefined')
})

test("/screenshot captures the dev server with the project's Playwright and tells Claude where the files are", async ($, on) => {
  const state = world(on)
  const result = await screenshot($)
  expect(result.text).toBe(`Captured http://localhost:3000/ at desktop and mobile widths: .claude/screenshots/${STAMP}-desktop.png, .claude/screenshots/${STAMP}-mobile.png`)
  expect(result.context?.[0]).toContain("On the user's request, http://localhost:3000/ was captured")
  const [run] = state.runs
  expect(run?.argv.slice(0, 2)).toEqual(['node', '-e'])
  expect(run?.argv.slice(3)).toEqual(['http://localhost:3000/', DIR, STAMP, '0'])
  expect(run?.cwd).toBe(ROOT)
  expect(state.files.has(`${DIR}/.gitignore`)).toBe(true)

  const terminal = await mountPane($, 'terminal')
  const image = await terminal.find({ key: 'image:desktop' })
  expect(image?.type).toBe('Image')
  expect(image?.props.source).toEqual({ file: `${DIR}/${STAMP}-desktop.png`, format: 'png' })
  expect((await terminal.find({ key: 'facts' }))?.text).toContain('HTTP 200 · Demo shop · 0 errors in the console')
  await terminal.press({ key: 'show:mobile' })
  expect(await terminal.find({ key: 'image:desktop' })).toBeUndefined()
  expect((await terminal.find({ key: 'image:mobile' }))?.type).toBe('Image')
  await terminal.press({ key: 'show:both' })
  await terminal.unmount()

  const desktop = await mountPane($, 'desktop')
  expect(await desktop.find({ type: 'Image' })).toBeUndefined()
  expect(String((await desktop.find({ type: 'Svg' }))?.props.source)).toContain('data:image/jpeg;base64,AAAA')
  await desktop.press({ key: 'review' })
  expect(state.submitted[0]).toContain('Look at both screenshots and review the page')
})

test('without Playwright in the project it uses npx playwright screenshot for each width', async ($, on) => {
  const state = world(on, { hasPlaywright: false })
  expect((await screenshot($, '/pricing')).text).toContain('Captured http://localhost:3000/pricing')
  expect(state.runs.map(run => run.argv.slice(0, 5).join(' '))).toEqual([
    'npx --yes playwright screenshot --viewport-size',
    'npx --yes playwright screenshot --device',
  ])
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'facts' }))?.text).toContain('console not watched')
})

test('console errors show in the pane; failures are explained', async ($, on) => {
  world(on, { output: { exitCode: 1, stdout: '', stderr: "browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium-1200/chrome-linux/chrome\n" } })
  expect((await screenshot($, 'http://localhost:3000')).text).toBe("Playwright's Chromium is not installed: run npx playwright install chromium")
  const ui = await mountPane($, 'desktop')
  expect((await ui.find({ key: 'error' }))?.text).toContain('npx playwright install chromium')
})

test('with no dev server it asks for a URL', async ($, on) => {
  const state = world(on, { openPorts: [] })
  expect((await screenshot($)).text).toContain('No dev server answers on the usual ports')
  expect((await screenshot($, 'file:///etc/passwd')).text).toBe('"file:///etc/passwd" is not an http(s) URL.')
  expect(state.runs).toHaveLength(0)
})

test('auto mode captures once UI edits settle and skips other files', { options: { auto: true, delaySeconds: 5 } }, async ($, on) => {
  const state = world(on)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/App.tsx`, old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/app.css`, content: 'x' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/App.test.tsx`, content: 'x' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/README.md`, content: 'x' })
  await state.clock.advance(4000)
  expect(state.runs).toHaveLength(0)
  await state.clock.advance(1500)
  expect(state.runs.filter(run => run.argv[0] === 'node')).toHaveLength(1)
  expect(state.toasts).toEqual(['📸 Screenshots of http://localhost:3000/ updated'])
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'facts' }))?.text).toContain('after your edits to App.tsx, app.css')
})

test('auto mode is off by default, and old captures are pruned', { options: { keep: 1 } }, async ($, on) => {
  const state = world(on)
  state.listing = ['2026-10-01T10-00-00-desktop.png', '2026-10-01T10-00-00-mobile.png', `${STAMP}-desktop.png`, `${STAMP}-mobile.png`, '.gitignore']
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/App.tsx`, old_string: 'a', new_string: 'b' })
  await state.clock.advance(60_000)
  expect(state.runs).toHaveLength(0)

  await screenshot($)
  const rm = state.runs.find(run => run.argv[0] === 'rm')
  expect(rm?.argv).toEqual(['rm', '-f', '--', `${DIR}/2026-10-01T10-00-00-desktop.png`, `${DIR}/2026-10-01T10-00-00-mobile.png`])
})
