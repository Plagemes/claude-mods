import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { GO_BENCH } from './fixtures'

const PANE_PROPS = { title: 'Benchmarks', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

/** GO_BENCH with Concat 30% slower and Builder twice as fast. */
const GO_BENCH_AFTER = GO_BENCH.replace('      6894 ns/op', '      8962 ns/op').replace('       535.2 ns/op', '       267.6 ns/op')

type World = {
  runs: { argv: readonly string[]; cwd: string | undefined }[]
  store: Map<string, unknown>
  statuses: (string | undefined)[]
  toasts: string[]
  opened: string[]
  output: { text: string; exitCode: number }
  branch: { name: string }
  clock: ReturnType<typeof mock.clock>
}

/** A Go module at /repo on branch `main` whose benchmarks print `output`. */
const world = (on: On, files: Record<string, string> = { '/repo/go.mod': 'module example.com/benchgo\n' }): World => {
  const state: World = {
    runs: [],
    store: new Map(),
    statuses: [],
    toasts: [],
    opened: [],
    output: { text: GO_BENCH, exitCode: 0 },
    branch: { name: 'main' },
    clock: mock.clock(on, { now: Date.parse('2026-10-07T10:00:00Z') }),
  }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', ($, e) => {
    const answer = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const line = e.argv.join(' ')
    if (line === 'git rev-parse --show-toplevel') return answer('/repo\n')
    if (line === 'git rev-parse --abbrev-ref HEAD') return answer(`${state.branch.name}\n`)
    if (line === 'git rev-parse --short HEAD') return answer(state.branch.name === 'main' ? 'a1b2c3d\n' : 'f00ba47\n')
    state.runs.push({ argv: e.argv, cwd: e.init?.cwd })
    return answer(state.output.text, state.output.exitCode)
  })
  on('fs.list', ($, e) => {
    const prefix = `${e.path}/`
    const names = Object.keys(files).filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length).split('/')[0] ?? '')
    return { value: [...new Set(names)].map(name => ({ name, kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', ($, e) => (files[e.path] === undefined ? { deny: 'ENOENT' } : { value: files[e.path] as string }))
  on('fs.exists', ($, e) => ({ value: e.path in files }))
  on('store.get', ($, e) => ({ value: state.store.get(e.key) }))
  on('store.set', ($, e) => {
    state.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...state.store.keys()] }))
  on('store.delete', ($, e) => {
    state.store.delete(e.key)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    state.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.status', ($, e) => {
    state.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)
    return { value: undefined }
  })
  return state
}

const bench = ($: Engine, args = '') =>
  $.command.run({ command: 'bench', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
const mountPane = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: 'benchmark-compare', surface, component: 'Pane', requestId: 'bench', props: PANE_PROPS })

test('/bench baseline finds go test -bench, runs it and keeps the numbers per project and branch', async ($, on) => {
  const state = world(on)
  expect((await bench($, 'baseline')).text).toBe('Running `go test -bench=. -benchmem -run=^$ ./...` for the main baseline…')
  expect(state.opened).toEqual(['bench'])
  await state.clock.advance(0)
  expect(state.runs).toEqual([{ argv: ['go', 'test', '-bench=.', '-benchmem', '-run=^$', './...'], cwd: '/repo' }])
  const saved = state.store.get('baseline:/repo:main') as { command: string; commit: string; results: unknown[] }
  expect(saved.command).toBe('go test -bench=. -benchmem -run=^$ ./...')
  expect(saved.commit).toBe('a1b2c3d')
  expect(saved.results).toHaveLength(5)
  expect(state.toasts).toEqual(['Baseline saved: 5 benchmarks on main @ a1b2c3d.'])
})

test('/bench compares with the baseline: deltas in the pane on every surface, regressions in the status line', async ($, on) => {
  const state = world(on)
  await bench($, 'baseline')
  await state.clock.advance(0)
  state.output.text = GO_BENCH_AFTER
  await state.clock.advance(3_600_000)
  expect((await bench($)).text).toBe('Running `go test -bench=. -benchmem -run=^$ ./...` to compare with the baseline…')
  await state.clock.advance(0)
  expect(state.statuses.at(-1)).toBe('⏱ bench: 1 slower')
  expect(state.toasts.at(-1)).toBe('Benchmarks: 1 slower · 1 faster · 3 same')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect((await ui.find({ key: 'header' }))?.text).toContain('⏱ Benchmarks · main vs main @ a1b2c3d (1 h ago)')
    const concat = (await ui.find({ key: 'row:strs.Concat' }))?.text ?? ''
    expect(concat).toContain('6.89 µs')
    expect(concat).toContain('8.96 µs')
    expect(concat).toContain('▼ 23.1% slower')
    expect((await ui.find({ key: 'row:strs.Builder' }))?.text).toContain('▲ 100.0% faster')
    expect((await ui.find({ key: 'row:hash.SHA256' }))?.text).toContain('≈ +0.0%')
    await ui.unmount()
  }

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'save' })
  await ui.unmount()
  expect(state.statuses.at(-1)).toBeUndefined()
  expect((state.store.get('baseline:/repo:main') as { results: { name: string; value: number }[] }).results.find(r => r.name === 'strs.Concat')?.value).toBe(8962)
})

test('a branch without a baseline compares with the newest one of the project', async ($, on) => {
  const state = world(on)
  await bench($, 'baseline')
  await state.clock.advance(0)
  state.branch.name = 'feature/faster-builder'
  state.output.text = GO_BENCH_AFTER
  await bench($)
  await state.clock.advance(0)
  expect(state.toasts.at(-1)).toBe('Benchmarks: 1 slower · 1 faster · 3 same (baseline from main)')
})

test('explains when no command is found, when the output has no numbers, and forgets a baseline on /bench clear', async ($, on) => {
  const state = world(on, { '/repo/README.md': '# hi' })
  expect((await bench($)).text).toStartWith('No benchmark command found.')

  state.output = { text: 'npm ERR! Missing script: "bench"\n', exitCode: 1 }
  expect((await bench($, 'npm run bench')).text).toBe('Running `npm run bench` to compare with the baseline…')
  await state.clock.advance(0)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: '✗ The command failed (exit 1).' })).toBeDefined()
    expect((await ui.find({ type: 'Code' }))?.text).toContain('Missing script')
    await ui.unmount()
  }

  state.store.set('baseline:/repo:main', { command: 'x', results: [], at: 0, branch: 'main', commit: '' })
  expect((await bench($, 'clear')).text).toBe('Forgot the benchmark baseline for main.')
  expect(state.store.has('baseline:/repo:main')).toBe(false)
  expect((await bench($, 'help')).text).toStartWith('Usage: /bench [baseline|clear] [command]')
})

test('a command that needs a shell runs through sh -c', { options: { regressionPercent: 10 } }, async ($, on) => {
  const state = world(on)
  await bench($, 'baseline cd strs && go test -bench=.')
  await state.clock.advance(0)
  expect(state.runs[0]?.argv).toEqual(['sh', '-c', 'cd strs && go test -bench=.'])
  state.output.text = GO_BENCH_AFTER
  await bench($)
  await state.clock.advance(0)
  // The baseline's command is reused; at 10% the 23% slowdown still counts.
  expect(state.runs[1]?.argv).toEqual(['sh', '-c', 'cd strs && go test -bench=.'])
  expect(state.toasts.at(-1)).toBe('Benchmarks: 1 slower · 1 faster · 3 same')
})
