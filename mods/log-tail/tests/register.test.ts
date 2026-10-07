import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { compileFilter, kindOf, targetOf, uniqueId } from '../hooks/lines'

const PLUGIN = 'log-tail'
const PANE_PROPS = {
  title: 'tail',
  isFocused: true,
  bodyColumns: 120,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const
/** A running tail keeps work pending, which each act of the kit waits on for a moment. */
const TAIL_TEST = { timeoutMs: 30_000 }

/** One fake child process: the test writes its output and ends it. */
type Child = { argv: readonly string[]; write: (text: string) => void; exit: (code: number) => void; isKilled: boolean }

type World = {
  children: Child[]
  statuses: (string | undefined)[]
  toasts: string[]
  opened: string[]
  submitted: string[]
  selection: { text: string } | undefined
  clock: ReturnType<typeof mock.clock>
}

const world = (on: On, files: readonly string[] = ['/work/logs/app.log'], missing: readonly string[] = []): World => {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/me' })
  const w: World = { children: [], statuses: [], toasts: [], opened: [], submitted: [], selection: undefined, clock }

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.stat', ($, e) =>
    files.includes(e.path) ? { value: { kind: 'file' as const, size: 10, mtimeMs: 0, isLink: false } } : e.path === '/work/logs' ? { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } } : { deny: 'ENOENT' },
  )
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.scroll', () => ({}))
  on('ui.status', ($, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.selection', () => ({ value: w.selection }))
  on('prompt.submit', ($, e) => {
    w.submitted.push(e.text)
    return { text: e.text }
  })
  on('process.spawn', async function* ($, e, next) {
    if (missing.includes(e.argv[0] ?? '')) return { deny: 'failed to start: ENOENT' }
    const queue: ({ text: string } | { code: number })[] = []
    let wake: (() => void) | undefined
    const child: Child = {
      argv: e.argv,
      isKilled: false,
      write: text => {
        queue.push({ text })
        wake?.()
      },
      exit: code => {
        queue.push({ code })
        wake?.()
      },
    }
    w.children.push(child)
    const killed = new Promise<'killed'>(resolve => next.signal.addEventListener('abort', () => resolve('killed')))
    for (;;) {
      const piece = queue.shift()
      if (piece !== undefined && 'code' in piece) return { value: { code: piece.code, signal: null } }
      if (piece !== undefined) {
        yield { stream: 'stdout' as const, text: piece.text }
        continue
      }
      if ((await Promise.race([new Promise<'woken'>(resolve => (wake = () => resolve('woken'))), killed])) === 'killed') {
        child.isKilled = true
        return { value: { code: null, signal: 'SIGTERM' } }
      }
    }
  })
  return w
}

const LOG = [
  '2026-10-07 10:00:01 INFO  api: listening on :8080',
  '2026-10-07 10:00:02 WARN  db: slow query took 812ms',
  '2026-10-07 10:00:03 ERROR api: request timeout user=42 path=/orders',
  '2026-10-07 10:00:04 INFO  api: GET /health 200',
  '',
].join('\n')

const tail = ($: Engine, args: string) =>
  $.command.run({ command: 'tail', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

const mountPane = ($: Engine, surface: 'terminal' | 'desktop', id = 'log-tail-app-log') =>
  $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: id, props: PANE_PROPS })

const shownLines = async (ui: Awaited<ReturnType<typeof mountPane>>): Promise<string[]> =>
  ((await ui.find({ key: 'lines' }))?.children ?? []).flatMap(child =>
    typeof child === 'object' && child !== null && 'children' in child ? [(child as { children: unknown[] }).children.join('')] : [],
  )

test('/tail follows a file in a pane, counts its lines and errors, keeps the last 1000 lines', TAIL_TEST, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  expect((await tail($, 'logs/app.log')).text).toBe('Following /work/logs/app.log as tail app-log. /tail stop app-log stops it.')
  expect(w.children[0]?.argv).toEqual(['tail', '-n', '200', '-F', '/work/logs/app.log'])
  expect(w.opened).toEqual(['log-tail-app-log'])

  w.children[0]?.write(LOG)
  await w.clock.advance(200)
  expect(w.statuses.at(-1)).toBe('⇣ tail app.log · ✗ 1 error')
  w.children[0]?.write(Array.from({ length: 1200 }, (_, i) => `line ${i}`).join('\n') + '\n')
  w.children[0]?.exit(0)
  await w.clock.settle()
  expect(w.toasts.at(-1)).toBe('tail app.log ended: Exited with code 0.')
  expect(w.statuses.at(-1)).toBeUndefined()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    const header = await ui.find({ key: 'header' })
    expect(header?.text).toContain('✗ ended')
    expect(header?.text).toContain('1,204 lines')
    expect(header?.text).toContain('1 error')
    const lines = await shownLines(ui)
    expect(lines).toHaveLength(1000)
    expect(lines.at(-1)).toBe('line 1199')
    expect(lines[0]).toBe('line 200')
    expect(await ui.find({ key: 'restart' })).toBeDefined()
    await ui.unmount()
  }
})

test('colors errors and warnings while following', TAIL_TEST, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await tail($, 'logs/app.log')
  w.children[0]?.write(LOG)
  await w.clock.advance(200)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect((await ui.find({ key: 'header' }))?.text).toContain('● following')
    const texts = await ui.findAll({ type: 'Text' })
    expect(texts.find(text => text.text.includes('ERROR api'))?.props.color).toBe('error')
    expect(texts.find(text => text.text.includes('WARN  db'))?.props.color).toBe('warning')
    expect(texts.find(text => text.text.includes('GET /health'))?.props.color).toBeUndefined()
    await ui.unmount()
  }
  await tail($, 'stop')
})

test('filters by text or /regex/ and shows errors only', TAIL_TEST, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await tail($, 'logs/app.log')
  w.children[0]?.write(LOG)
  w.children[0]?.exit(0)
  await w.clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    await ui.input({ key: 'filter', text: 'API', kind: 'change' })
    expect(await shownLines(ui)).toEqual([
      'Showing 3 lines of 4',
      '2026-10-07 10:00:01 INFO  api: listening on :8080',
      '2026-10-07 10:00:03 ERROR api: request timeout user=42 path=/orders',
      '2026-10-07 10:00:04 INFO  api: GET /health 200',
    ])
    await ui.input({ key: 'filter', text: '/user=\\d+/' })
    expect((await shownLines(ui)).slice(1)).toEqual(['2026-10-07 10:00:03 ERROR api: request timeout user=42 path=/orders'])
    await ui.input({ key: 'filter', text: '/(oops/' })
    expect((await ui.find({ key: 'filter-error' }))?.text).toContain('Not a regex')
    await ui.input({ key: 'filter', text: '' })
    await ui.press({ key: 'errors' })
    expect(await shownLines(ui)).toEqual(['Showing 1 line of 4 · errors only', '2026-10-07 10:00:03 ERROR api: request timeout user=42 path=/orders'])
    await ui.press({ key: 'errors' })
    await ui.unmount()
  }
})

test('Pause freezes the lines and counts what arrives; Resume shows it', TAIL_TEST, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await tail($, 'logs/app.log')
  w.children[0]?.write(LOG)
  await w.clock.advance(200)
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'pause' })
  w.children[0]?.write('2026-10-07 10:00:05 INFO  later\n')
  await w.clock.advance(200)
  const header = (await ui.find({ key: 'header' }))?.text
  expect(header).toContain('⏸ paused')
  expect(header).toContain('1 new')
  expect(await shownLines(ui)).not.toContain('2026-10-07 10:00:05 INFO  later')
  await ui.press({ key: 'pause' })
  expect(await shownLines(ui)).toContain('2026-10-07 10:00:05 INFO  later')
  await tail($, 'stop')
})

test('Send to Claude sends the selection, else the last lines shown', TAIL_TEST, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await tail($, 'logs/app.log')
  w.children[0]?.write(LOG)
  w.children[0]?.exit(0)
  await w.clock.settle()
  const ui = await mountPane($, 'terminal')

  w.selection = { text: 'ERROR api: request timeout user=42' }
  await ui.press({ key: 'send' })
  expect(w.submitted.at(-1)).toBe(
    'These lines are from the log file `/work/logs/app.log`:\n\n```\nERROR api: request timeout user=42\n```\n\nExplain what they show. If they point to a problem in this project, find the cause.',
  )

  w.selection = undefined
  await ui.press({ key: 'errors' })
  await ui.press({ key: 'send' })
  expect(w.submitted.at(-1)).toContain('The last 1 line (errors only) are from the log file `/work/logs/app.log`:')
  expect(w.submitted.at(-1)).toContain('ERROR api: request timeout user=42 path=/orders')
})

test('runs several tails by id, stops them one by one, and says when docker is missing', TAIL_TEST, async ($, on) => {
  const w = world(on, ['/work/logs/app.log'], [])
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await tail($, 'docker:web')
  await tail($, 'compose:worker')
  expect(w.children.map(child => child.argv)).toEqual([
    ['docker', 'logs', '-f', '--tail', '200', 'web'],
    ['docker', 'compose', 'logs', '-f', '--tail', '200', '--no-color', '--no-log-prefix', 'worker'],
  ])
  expect(w.opened).toEqual(['log-tail-web', 'log-tail-worker'])
  expect(w.statuses.at(-1)).toBe('⇣ 2 tails')
  expect((await tail($, 'docker:web')).text).toBe('Already following web (tail web).')

  expect((await tail($, '')).text).toBe('web  following  docker:web\nworker  following  compose:worker\n/tail stop <id> stops one; /tail stop all stops them all.')
  expect((await tail($, 'stop')).text).toBe('2 tails run: name one (web, worker) or all.')
  expect((await tail($, 'stop web')).text).toBe('Stopped tail web.')
  expect(w.children[0]?.isKilled).toBe(true)
  expect(w.statuses.at(-1)).toBe('⇣ tail compose:worker')

  w.children[1]?.write('Error response from daemon: no such service: worker\n')
  w.children[1]?.exit(1)
  await w.clock.settle()
  expect(w.toasts.at(-1)).toBe('tail compose:worker ended: Exited with code 1.')
  expect(w.statuses.at(-1)).toBeUndefined()
  const ui = await mountPane($, 'desktop', 'log-tail-worker')
  expect((await ui.find({ key: 'header' }))?.text).toContain('✗ ended')
  expect(await ui.find({ key: 'restart' })).toBeDefined()
  expect((await tail($, 'logs')).text).toBe('/work/logs is a folder: name a file in it.')
})

test('a missing docker binary is said plainly', TAIL_TEST, async ($, on) => {
  const w = world(on, [], ['docker'])
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await tail($, 'docker:db')
  await w.clock.settle()
  expect(w.toasts.at(-1)).toBe('tail docker:db could not start: docker is not installed (or not on PATH).')
  const ui = await mountPane($, 'terminal', 'log-tail-db')
  expect((await ui.find({ key: 'header' }))?.text).toContain('could not start')
})

test('reads targets, levels and filters', () => {
  expect(targetOf('~/logs/a b.log', '/work', '/home/me', 200)).toEqual({
    source: 'file',
    target: '/home/me/logs/a b.log',
    argv: ['tail', '-n', '200', '-F', '/home/me/logs/a b.log'],
    id: 'a-b-log',
  })
  expect(targetOf('./var/app.log', '/work/', undefined, 50).target).toBe('/work/var/app.log')
  expect(uniqueId('web', new Set(['web', 'web-2']))).toBe('web-3')

  expect(kindOf('{"level":"error","msg":"boom"}')).toBe('error')
  expect(kindOf('level=warn msg="disk 91%"')).toBe('warning')
  expect(kindOf('2026/10/07 [error] 12#12: connect() failed')).toBe('error')
  expect(kindOf('TypeError: Cannot read properties of undefined')).toBe('error')
  expect(kindOf('    at handler (/app/src/api.ts:12:5)')).toBe('info')
  expect(kindOf('compiled with 0 errors')).toBe('info')
  expect(kindOf('GET /api/errors-dashboard 200')).toBe('info')

  expect(compileFilter('Timeout').keeps('request TIMEOUT')).toBe(true)
  expect(compileFilter('/^GET/').keeps('POST /x')).toBe(false)
  expect(compileFilter('/[/').error).toContain('Not a regex')
})
