import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { detectCommand } from '../hooks/detect'
import { findUrl, kindOf, lastErrorBlock, splitLines } from '../hooks/output'
import type { DevServerLine } from '../types'
import { fakeHub } from './hub'

const PLUGIN = 'dev-server-pane'
const PANE_PROPS = {
  title: 'Dev server',
  isFocused: false,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

type Piece = { kind: 'out'; stream: 'stdout' | 'stderr'; text: string } | { kind: 'exit'; code: number }

/** A fake child process the test writes output into and ends. */
type Server = {
  spawned: { argv: readonly string[]; cwd: string | undefined; env: Record<string, string> | undefined }[]
  killed: number
  write: (text: string, stream?: 'stdout' | 'stderr') => void
  exit: (code: number) => void
}

type World = {
  server: Server
  statuses: (string | undefined)[]
  toasts: string[]
  opened: string[]
  submitted: { text: string; context: readonly string[] }[]
  clock: ReturnType<typeof mock.clock>
}

const world = (on: On, files: Record<string, string>): World => {
  const clock = mock.clock(on)
  const queue: Piece[] = []
  let wake: (() => void) | undefined
  const server: Server = {
    spawned: [],
    killed: 0,
    write: (text, stream = 'stdout') => {
      queue.push({ kind: 'out', stream, text })
      wake?.()
    },
    exit: code => {
      queue.push({ kind: 'exit', code })
      wake?.()
    },
  }
  const w: World = { server, statuses: [], toasts: [], opened: [], submitted: [], clock }

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/app' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.list', ($, e) => {
    const prefix = `${e.path.replace(/\/$/, '')}/`
    const names = new Set(Object.keys(files).filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length).split('/')[0] ?? ''))
    return { value: [...names].map(name => ({ name, kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.exists', ($, e) => ({ value: e.path in files }))
  on('fs.read', ($, e) => (e.path in files ? { value: files[e.path] ?? '' } : { deny: 'ENOENT' }))
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.scroll', () => ({}))
  on('ui.status', ($, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    w.submitted.push({ text: e.text, context: e.context ?? [] })
    return { text: e.text }
  })
  on('process.spawn', async function* ($, e, next) {
    server.spawned.push({ argv: e.argv, cwd: e.cwd, env: e.env })
    queue.length = 0
    const killed = new Promise<'killed'>(resolve => next.signal.addEventListener('abort', () => resolve('killed')))
    for (;;) {
      const piece = queue.shift()
      if (piece?.kind === 'exit') return { value: { code: piece.code, signal: null } }
      if (piece !== undefined) {
        yield { stream: piece.stream, text: piece.text }
        continue
      }
      const woken = await Promise.race([new Promise<'woken'>(resolve => (wake = () => resolve('woken'))), killed])
      if (woken === 'killed') {
        server.killed += 1
        return { value: { code: null, signal: 'SIGTERM' } }
      }
    }
  })
  return w
}

/** A running server keeps work pending, which each act of the kit waits on for a moment. */
const SERVER_TEST = { timeoutMs: 30_000 }

const NODE_APP = {
  '/app/package.json': JSON.stringify({ name: 'web', scripts: { build: 'vite build', dev: 'vite' } }),
  '/app/pnpm-lock.yaml': '',
}

const VITE_BOOT = '\u001b[32m  VITE v5.2.0\u001b[39m  ready in 312 ms\n\n  ➜  Local:   \u001b[36mhttp://localhost:5173/\u001b[39m\n  ➜  Network: use --host to expose\n'
const VITE_ERROR = [
  '12:01:44 [vite] Internal server error: Transform failed with 1 error:',
  '/app/src/App.tsx:14:9: ERROR: Expected ")" but found "}"',
  '      at failureErrorWithLog (/app/node_modules/esbuild/lib/main.js:1472:15)',
  '      at /app/node_modules/esbuild/lib/main.js:755:50',
  '',
  '12:01:45 [vite] page reload src/main.tsx',
  '',
].join('\n')

const dev = ($: Engine, args = '') =>
  $.command.run({ command: 'dev', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

const mountPane = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'dev-server', props: PANE_PROPS })

test('/dev starts the detected script, streams its output and finds the URL and errors', SERVER_TEST, async ($, on) => {
  const w = world(on, NODE_APP)
  await $.session.start({ cwd: '/app', surface: 'terminal', isInteractive: true })

  expect((await dev($)).text).toBe('Started pnpm dev (package.json "dev" script). /dev stop stops it.')
  expect(w.server.spawned).toEqual([{ argv: ['sh', '-c', 'pnpm dev'], cwd: '/app', env: { BROWSER: 'none', FORCE_COLOR: '0' } }])
  expect(w.opened).toEqual(['dev-server'])

  w.server.write(VITE_BOOT)
  w.server.write(VITE_ERROR, 'stderr')
  await w.clock.advance(200)
  expect(w.statuses.at(-1)).toBe('▶ dev · localhost:5173 · ✗ 2 errors')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    const header = await ui.find({ key: 'header' })
    expect(header?.text).toContain('● running')
    expect(header?.text).toContain('pnpm dev')
    expect(header?.text).toContain('localhost:5173')
    expect(header?.text).toContain('2 errors')
    const errors = (await ui.findAll({ type: 'Text' })).filter(text => text.props.color === 'error' && text.text !== '2 errors')
    expect(errors.map(text => text.text)).toEqual([
      '12:01:44 [vite] Internal server error: Transform failed with 1 error:',
      '/app/src/App.tsx:14:9: ERROR: Expected ")" but found "}"',
    ])
    expect(await ui.find({ type: 'Text', text: '\u001b' })).toBeUndefined()
    await ui.unmount()
  }

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'fix' })
  const asked = w.submitted.at(-1)?.text ?? ''
  expect(asked).toContain('My dev server `pnpm dev` (http://localhost:5173/) printed this error:')
  expect(asked).toContain('Transform failed with 1 error:')
  expect(asked).toContain('at failureErrorWithLog')
  expect(asked).not.toContain('page reload')
  expect(asked).toContain('do not start another one')
  await dev($, 'stop')
})

test('/dev stop kills the server; a crash says so and Start runs the same command again', SERVER_TEST, async ($, on) => {
  const w = world(on, NODE_APP)
  await $.session.start({ cwd: '/app', surface: 'terminal', isInteractive: true })
  await dev($)
  w.server.write('ready\n')
  await w.clock.advance(200)

  expect((await dev($, 'stop')).text).toBe('Dev server stopped.')
  expect(w.server.killed).toBe(1)
  expect(w.statuses.at(-1)).toBeUndefined()
  expect((await dev($, 'stop')).text).toBe('No dev server is running.')

  await dev($, 'node server.js --port 4000')
  expect(w.server.spawned.at(-1)?.argv).toEqual(['sh', '-c', 'node server.js --port 4000'])
  w.server.write("Error: Cannot find module 'express'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1145:15)\n", 'stderr')
  w.server.exit(1)
  await w.clock.settle()
  expect(w.statuses.at(-1)).toBe('✗ dev exited (1) · /dev')
  expect(w.toasts.at(-1)).toBe('node server.js --port 4000 exited (1). /dev shows its output.')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect((await ui.find({ key: 'header' }))?.text).toContain('✗ exited (1)')
    expect((await ui.find({ key: 'meta' }))?.text).toContain('Exited with code 1.')
    expect(await ui.find({ key: 'stop' })).toBeUndefined()
    await ui.unmount()
  }
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'start' })
  expect(w.server.spawned.at(-1)?.argv).toEqual(['sh', '-c', 'node server.js --port 4000'])
  expect((await ui.find({ key: 'header' }))?.text).toContain('● running')
  await dev($, 'stop')
})

test('tells the model once that a server runs, and keeps only the last 500 lines', SERVER_TEST, async ($, on) => {
  const w = world(on, NODE_APP)
  await $.session.start({ cwd: '/app', surface: 'terminal', isInteractive: true })
  await dev($)
  w.server.write(VITE_BOOT)
  w.server.write(Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n') + '\n')
  await w.clock.advance(200)

  await $.prompt.submit({ text: 'add a login page', wait: false, origin: { kind: 'composer' } })
  await $.prompt.submit({ text: 'and a logout button', wait: false, origin: { kind: 'composer' } })
  expect(w.submitted[0]?.context).toEqual([
    'dev-server-pane: the dev server is already running in the background (`pnpm dev` in /app at http://localhost:5173/); the user watches its output in a pane. Don\'t start another one.',
  ])
  expect(w.submitted[1]?.context).toEqual([])

  const ui = await mountPane($, 'desktop')
  const texts = (await ui.findAll({ type: 'Text' })).map(text => text.text)
  expect(texts).toContain('line 599')
  expect(texts).toContain('line 100')
  expect(texts).not.toContain('line 99')
  await dev($, 'stop')
})

test('a progress line that is redrawn and never ended does not grow without bound', SERVER_TEST, async ($, on) => {
  const w = world(on, NODE_APP)
  await $.session.start({ cwd: '/app', surface: 'terminal', isInteractive: true })
  await dev($)
  for (let i = 0; i < 60; i += 1) w.server.write(Array.from({ length: 100 }, (_, j) => `\rbuilding ${i * 100 + j}%`).join(''))
  await w.clock.advance(200)

  const ui = await mountPane($, 'desktop')
  const texts = (await ui.findAll({ type: 'Text' })).map(text => text.text)
  expect(texts).toContain('building 5999%')
  expect(texts.every(text => text.length <= 2_001)).toBe(true)
  await ui.unmount()
  await dev($, 'stop')
})

test('detects Django with its virtualenv, and says when nothing is found', SERVER_TEST, async ($, on) => {
  const w = world(on, { '/app/manage.py': '', '/app/.venv/bin/python': '' })
  await $.session.start({ cwd: '/app', surface: 'terminal', isInteractive: true })
  expect((await dev($)).text).toBe('Started .venv/bin/python manage.py runserver (Django manage.py). /dev stop stops it.')
  expect(w.server.spawned[0]?.argv).toEqual(['sh', '-c', '.venv/bin/python manage.py runserver'])
  await dev($, 'stop')

  expect(detectCommand({ names: new Set(['README.md']) })).toBeUndefined()
  expect(detectCommand({ names: new Set(['package.json', 'yarn.lock']), packageJson: '{"scripts":{"start":"next start"}}' })?.command).toBe('yarn start')
  expect(detectCommand({ names: new Set(['package.json']), packageJson: '{"packageManager":"bun@1.1.0","scripts":{"dev":"x"}}' })?.command).toBe('bun run dev')
  expect(detectCommand({ names: new Set(['Gemfile', 'bin', 'bin/dev']) })?.command).toBe('bin/dev')
})

test('reads output pieces into clean lines, URLs and error blocks', () => {
  expect(splitLines('', 'a\nb')).toEqual({ lines: ['a'], partial: 'b' })
  expect(splitLines('b', 'c\n\u001b[33mwarn\u001b[0m\n')).toEqual({ lines: ['bc', 'warn'], partial: '' })
  expect(splitLines('', 'building 10%\rbuilding 100%\r\n')).toEqual({ lines: ['building 100%'], partial: '' })

  expect(findUrl('  - Local:        http://localhost:3000')).toBe('http://localhost:3000')
  expect(findUrl('Starting development server at http://127.0.0.1:8000/')).toBe('http://127.0.0.1:8000/')
  expect(findUrl('Listening on http://0.0.0.0:4000')).toBe('http://localhost:4000')
  expect(findUrl('Server listening on port 8080')).toBe('http://localhost:8080')
  expect(findUrl('compiled successfully')).toBeUndefined()

  expect(kindOf('Found 0 errors. Watching for file changes.')).toBe('info')
  expect(kindOf('ValueError: invalid literal for int()')).toBe('error')
  expect(kindOf('npm ERR! code ELIFECYCLE')).toBe('error')
  expect(kindOf('(!) Some chunks are larger than 500 kB: warning')).toBe('warning')

  const lines = (texts: string[]): DevServerLine[] => texts.map(text => ({ text, stream: 'stderr', kind: kindOf(text) }))
  const traceback = lines([
    '[07/Oct/2026 10:00:00] "GET / HTTP/1.1" 200 512',
    'Internal Server Error: /orders/',
    'Traceback (most recent call last):',
    '  File "/app/shop/views.py", line 12, in orders',
    '    total = int(request.GET["n"])',
    'ValueError: invalid literal for int() with base 10: \'x\'',
    '[07/Oct/2026 10:00:01] "GET /orders/?n=x HTTP/1.1" 500 6600',
  ])
  expect(lastErrorBlock(traceback)?.split('\n')).toEqual([
    'Internal Server Error: /orders/',
    'Traceback (most recent call last):',
    '  File "/app/shop/views.py", line 12, in orders',
    '    total = int(request.GET["n"])',
    "ValueError: invalid literal for int() with base 10: 'x'",
  ])
  expect(lastErrorBlock(lines(['ready', 'all good']))).toBeUndefined()
})

const HUB_PANE_PROPS = { ...PANE_PROPS, title: 'Claude Mods' }

test('with mods-hub: /dev opens the Dev server tab, publishes build.result as the server comes up, fails, and dies; the crash is an error notice', SERVER_TEST, async ($, on) => {
  const w = world(on, NODE_APP)
  const hub = fakeHub(on, {}, w.clock)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['HUB STRIP'] }) as never)
  await $.session.start({ cwd: '/app', surface: 'terminal', isInteractive: true })
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['build.result'], consumes: [] }])
  expect(hub.tabs).toEqual([{ id: 'devserver', title: 'Dev server', order: 300, command: 'dev' }])

  await dev($)
  expect(hub.shown).toEqual(['devserver'])
  expect(w.opened).toEqual([])
  hub.tab = 'devserver'

  w.server.write(VITE_BOOT)
  await w.clock.advance(200)
  expect(hub.published).toEqual([{ topic: 'build.result', data: { tool: 'pnpm dev', outcome: 'passed', command: 'pnpm dev' } }])

  w.server.write(VITE_ERROR, 'stderr')
  await w.clock.advance(6_000)
  expect(hub.published.at(-1)).toEqual({ topic: 'build.result', data: { tool: 'pnpm dev', outcome: 'failed', command: 'pnpm dev', errors: 2 } })
  expect(hub.published).toHaveLength(2)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'claude-mods', props: HUB_PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: 'HUB STRIP' })).toBeDefined()
    expect((await ui.find({ key: 'header' }))?.text).toContain('● running')
    expect(await ui.find({ key: 'pane' })).toBeDefined()
    expect(await ui.find({ key: 'close' })).toBeUndefined()
    expect(await ui.find({ key: 'fix' })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'claude-mods', props: HUB_PANE_PROPS })
  await ui.press({ key: 'pane' })
  expect(w.opened).toEqual(['dev-server'])
  await ui.unmount()

  w.server.exit(1)
  await w.clock.settle()
  expect(hub.published.at(-1)).toEqual({ topic: 'build.result', data: { tool: 'pnpm dev', outcome: 'error', command: 'pnpm dev', errors: 2 } })
  expect(hub.notified).toEqual([{ level: 'error', title: 'pnpm dev exited (1). /dev shows its output.' }])
  expect(w.toasts).toEqual([])
})

test('with mods-hub: a server that never prints an error is reported up once, and stopping it reports nothing more', SERVER_TEST, async ($, on) => {
  const w = world(on, NODE_APP)
  const hub = fakeHub(on, {}, w.clock)
  await $.session.start({ cwd: '/app', surface: 'terminal', isInteractive: true })
  await dev($)
  w.server.write(VITE_BOOT)
  await w.clock.advance(200)
  w.server.write('hot updated src/a.ts\n')
  await w.clock.advance(200)
  await dev($, 'stop')
  expect(hub.published.map(event => (event.data as { outcome: string }).outcome)).toEqual(['passed'])
  expect(hub.notified).toEqual([])
})

test('with mods-hub: another tab of the panel is left to its owner', SERVER_TEST, async ($, on) => {
  const w = world(on, NODE_APP)
  const hub = fakeHub(on, {}, w.clock)
  hub.tab = 'cost'
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['HUB STRIP'] }) as never)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'claude-mods', props: HUB_PANE_PROPS })
  expect(await ui.find({ key: 'header' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'No dev server yet' })).toBeUndefined()
  await ui.unmount()
})
