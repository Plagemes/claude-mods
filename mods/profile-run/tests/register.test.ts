import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { NODE_CPUPROFILE, PSTATS_DUMP } from './fixtures'

const PANE_PROPS = { title: 'Profile', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const
const PROFILE_DIR = '/home/dev/app/.claude/profiles'
/** The npm process's own profile: idle while its script runs. */
const NPM_PROFILE = JSON.stringify({
  nodes: [
    { id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 }, hitCount: 0, children: [2, 3] },
    { id: 2, callFrame: { functionName: '(idle)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 }, hitCount: 90, children: [] },
    { id: 3, callFrame: { functionName: 'exec', scriptId: '9', url: 'file:///usr/lib/node_modules/npm/lib/npm.js', lineNumber: 10, columnNumber: 0 }, hitCount: 10, children: [] },
  ],
  startTime: 0,
  endTime: 200_000,
  samples: [2, 2, 3, 2],
  timeDeltas: [0, 50_000, 50_000, 50_000],
})

type World = { runs: { argv: readonly string[]; env: Record<string, string> | undefined }[]; files: Map<string, string>; toasts: string[]; submitted: string[]; clock: ReturnType<typeof mock.clock> }

/** A project at /home/dev/app; running a node program writes the profiles in `writes`. */
const world = (on: On, writes: Record<string, string> = {}, exitCode = 0): World => {
  const state: World = { runs: [], files: new Map(), toasts: [], submitted: [], clock: mock.clock(on, { now: Date.parse('2026-10-07T12:00:00Z') }) }
  mock.env(on, {})
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/home/dev/app' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', ($, e) => {
    const answer = (stdout: string, code = 0) => ({ value: { exitCode: code, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'git') return answer('/home/dev/app\n')
    state.runs.push({ argv: e.argv, env: e.init?.env })
    if (e.argv.includes('-c') && e.argv[0]?.includes('python')) return answer(PSTATS_DUMP)
    for (const [name, text] of Object.entries(writes)) state.files.set(`${PROFILE_DIR}/${name}`, text)
    return answer('done\n', exitCode)
  })
  on('fs.exists', () => ({ value: false }))
  on('fs.list', ($, e) => {
    if (e.path !== PROFILE_DIR) return { deny: 'ENOENT' }
    return { value: [...state.files.keys()].map(path => ({ name: path.slice(PROFILE_DIR.length + 1), kind: 'file' as const, size: 10, mtimeMs: 0, isLink: false })) }
  })
  on('fs.stat', ($, e) => {
    const text = state.files.get(e.path)
    return text === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file' as const, size: text.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', ($, e) => {
    const text = state.files.get(e.path)
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    state.submitted.push(e.text)
    return { text: e.text }
  })
  return state
}

const profile = ($: Engine, args: string) =>
  $.command.run({ command: 'profile', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
const mountPane = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: 'profile-run', surface, component: 'Pane', requestId: 'profile', props: PANE_PROPS })

test('/profile npm run build profiles every node process and shows the busiest one', async ($, on) => {
  const state = world(on, { 'CPU.1.cpuprofile': NPM_PROFILE, 'CPU.2.cpuprofile': NODE_CPUPROFILE })
  expect((await profile($, 'npm run build')).text).toBe('Profiling `npm run build` with node --cpu-prof…')
  await state.clock.advance(0)
  expect(state.runs[0]).toEqual({ argv: ['npm', 'run', 'build'], env: { NODE_OPTIONS: `--cpu-prof --cpu-prof-dir=${PROFILE_DIR}` } })
  expect(state.toasts).toEqual(['Hottest: sortNumbers · 112 ms self (62%)'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect((await ui.find({ key: 'header' }))?.text).toContain('181 ms sampled · node · 2 processes, the busiest shown · .claude/profiles/CPU.2.cpuprofile')
    const first = (await ui.find({ key: 'fn:0' }))?.text ?? ''
    expect(first).toContain('sortNumbers')
    expect(first).toContain('slow.js:3')
    expect(first).toContain('111.9')
    expect(first).toContain('61.7%')
    expect(first).toContain('69.9%')
    await ui.unmount()
  }

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'sort' })
  expect((await ui.find({ key: 'fn:0' }))?.text).toContain('main')
  await ui.press({ key: 'optimise' })
  await ui.unmount()
  await state.clock.advance(1)
  expect(state.submitted[0]).toContain('1. sortNumbers at slow.js:3: 112 ms self (61.7%), 69.9% total')
})

test('python runs under cProfile, then the stats are read with pstats', async ($, on) => {
  const state = world(on)
  expect((await profile($, 'python3 slow.py')).text).toBe('Profiling `python3 slow.py` with cProfile…')
  await state.clock.advance(0)
  expect(state.runs[0]?.argv).toEqual(['python3', '-m', 'cProfile', '-o', `${PROFILE_DIR}/profile-2026-10-07T12-00-00-000Z.pstats`, 'slow.py'])
  expect(state.runs[1]?.argv.slice(0, 2)).toEqual(['python3', '-c'])
  const ui = await mountPane($, 'desktop')
  expect((await ui.find({ key: 'fn:0' }))?.text).toContain('<genexpr>')
  expect((await ui.find({ key: 'fn:1' }))?.text).toContain('(built-in)')
  await ui.unmount()
})

test('explains what it cannot profile, and failures that leave no profile', async ($, on) => {
  const state = world(on, {}, 1)
  expect((await profile($, '')).text).toStartWith('Usage: /profile <command>')
  expect((await profile($, 'go run ./cmd/server')).text).toContain('go tool pprof -top')
  expect(state.runs).toEqual([])

  await profile($, 'node broken.js')
  await state.clock.advance(0)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /The command failed \(exit 1\) and left no profile: node wrote no \.cpuprofile/ })).toBeDefined()
    expect((await ui.find({ type: 'Code' }))?.text).toContain('done')
    await ui.unmount()
  }
})
