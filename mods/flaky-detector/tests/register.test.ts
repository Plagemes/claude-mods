import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { GO_FAIL } from './fixtures'
import { fakeHub } from './hub'

const PANE_PROPS = { title: 'Flaky tests', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const
const GO_PASS = 'ok  \texample.com/shop/calc\t0.004s\nok  \texample.com/shop/store\t0.002s\n'

type World = {
  tree: { id: string }
  output: { text: string; fails: boolean }
  store: Map<string, unknown>
  toasts: string[]
  submitted: string[]
  gitIndex: (string | undefined)[]
  clock: ReturnType<typeof mock.clock>
}

/** A Go module at /repo whose worktree fingerprint is `tree.id`, and whose `go test` prints `output`. */
const world = (on: On): World => {
  const state: World = {
    tree: { id: 'aaa111' },
    output: { text: GO_FAIL, fails: true },
    store: new Map(),
    toasts: [],
    submitted: [],
    gitIndex: [],
    clock: mock.clock(on, { now: Date.parse('2026-10-07T09:00:00Z') }),
  }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', ($, e) => {
    const line = e.argv.slice(1).join(' ')
    const answer = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (line === 'rev-parse --show-toplevel') return answer('/repo\n')
    if (line === 'rev-parse --git-path flaky-detector.index') return answer('.git/flaky-detector.index\n')
    if (line === 'write-tree') return answer(`${state.tree.id}\n`)
    state.gitIndex.push(e.init?.env?.GIT_INDEX_FILE)
    return answer('')
  })
  on('fs.exists', () => ({ value: true }))
  on('tool.call', ($, e) => {
    if (e.tool !== 'Bash') return { result: 'ok' }
    return state.output.fails
      ? { isError: true, result: 'Exit code 1', text: `Exit code 1\n${state.output.text}` }
      : { result: { stdout: state.output.text, stderr: '', interrupted: false } }
  })
  on('store.get', ($, e) => ({ value: state.store.get(e.key) }))
  on('store.set', ($, e) => {
    state.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', ($, e) => {
    state.submitted.push(e.text)
    return { text: e.text }
  })
  return state
}

const goTest = ($: Engine) => $.tool.call({ tool: 'Bash', command: 'go test ./...' })
const flaky = ($: Engine) =>
  $.command.run({ command: 'flaky', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 } })

test('fail, pass, fail on the same code marks the failing tests flaky, and the next failure tells Claude', async ($, on) => {
  const state = world(on)
  await goTest($)
  expect(state.gitIndex.every(path => path === '/repo/.git/flaky-detector.index')).toBe(true)

  state.output = { text: GO_PASS, fails: false }
  await goTest($)
  expect(state.toasts).toEqual([
    '⚠ Flaky: example.com/shop/calc.TestDiv changed outcome with no code change (/flaky)',
    '⚠ Flaky: example.com/shop/calc.TestTable changed outcome with no code change (/flaky)',
    '⚠ Flaky: example.com/shop/calc.TestTable/large changed outcome with no code change (/flaky)',
  ])

  state.output = { text: GO_FAIL, fails: true }
  const third = await goTest($)
  expect(third.isError).toBe(true)
  expect(third.context?.at(-1)).toStartWith('flaky-detector: known flaky tests failed: example.com/shop/calc.TestDiv (2 flips)')
})

test('when the code changed between the failure and the pass, nothing is flaky', async ($, on) => {
  const state = world(on)
  await goTest($)
  state.tree.id = 'bbb222'
  state.output = { text: GO_PASS, fails: false }
  const passed = await goTest($)
  expect(state.toasts).toEqual([])
  expect(passed.context).toBeUndefined()
  expect((await flaky($)).text).toBe('No flaky or failing tests in this project right now; they are tracked as tests run.')
})

test('/flaky lists suspects with flips on every surface; Stabilise asks Claude, Forget drops one', async ($, on) => {
  const state = world(on)
  await goTest($)
  state.output = { text: GO_PASS, fails: false }
  await goTest($)
  expect((await flaky($)).text).toBe('3 flaky suspects, 0 failing tests watched.')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'flaky-detector', surface, component: 'Pane', requestId: 'flaky', props: PANE_PROPS })
    expect((await ui.find({ key: 'header' }))?.text).toContain('3 suspects · 0 watched')
    const row = (await ui.find({ key: 'flaky:example.com/shop/calc.TestDiv' }))?.text ?? ''
    expect(row).toContain('1 flip')
    expect(row).toContain('✗✓')
    expect(row).toContain('go')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'flaky-detector', surface: 'terminal', component: 'Pane', requestId: 'flaky', props: PANE_PROPS })
  await ui.press({ key: 'fix:example.com/shop/calc.TestDiv' })
  await state.clock.advance(1)
  expect(state.submitted[0]).toStartWith('The test `example.com/shop/calc.TestDiv` (go) is flaky: it changed between passing and failing 1 time')
  await ui.press({ key: 'forget:example.com/shop/calc.TestDiv' })
  expect(await ui.find({ key: 'flaky:example.com/shop/calc.TestDiv' })).toBeUndefined()
  expect(await ui.find({ key: 'flaky:example.com/shop/calc.TestTable' })).toBeDefined()
  await ui.unmount()
})

test('commands that are not test runs, and runs with no readable summary, are left alone', async ($, on) => {
  const state = world(on)
  await $.tool.call({ tool: 'Bash', command: 'go build ./...' })
  state.output = { text: 'some unrelated text', fails: true }
  await goTest($)
  expect(state.store.size).toBe(0)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'flaky-detector', surface, component: 'Pane', requestId: 'flaky', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /No flaky tests seen/ })).toBeDefined()
    await ui.unmount()
  }
})

test('with mods-hub: says hello, publishes each new suspect and notifies a warning instead of toasting', async ($, on) => {
  const state = world(on)
  const hub = fakeHub(on)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['x.flaky-detector.suspect'], consumes: [] }])

  await goTest($)
  state.output = { text: GO_PASS, fails: false }
  await goTest($)

  expect(hub.published.map(event => event.data)).toEqual([
    { id: 'example.com/shop/calc.TestDiv', runner: 'go', scope: 'example.com/shop/calc', flips: 1, command: 'go test ./...' },
    { id: 'example.com/shop/calc.TestTable', runner: 'go', scope: 'example.com/shop/calc', flips: 1, command: 'go test ./...' },
    { id: 'example.com/shop/calc.TestTable/large', runner: 'go', scope: 'example.com/shop/calc', flips: 1, command: 'go test ./...' },
  ])
  expect(hub.published.every(event => event.topic === 'x.flaky-detector.suspect')).toBe(true)
  expect(hub.notified.map(notice => [notice.level, notice.topic])).toEqual([
    ['warning', 'x.flaky-detector.suspect'],
    ['warning', 'x.flaky-detector.suspect'],
    ['warning', 'x.flaky-detector.suspect'],
  ])
  expect(hub.notified[0]?.title).toBe('⚠ Flaky: example.com/shop/calc.TestDiv changed outcome with no code change (/flaky)')
  expect(state.toasts).toEqual([])

  // The next failure still tells Claude, hub or not.
  state.output = { text: GO_FAIL, fails: true }
  expect((await goTest($)).context?.at(-1)).toStartWith('flaky-detector: known flaky tests failed')
})

test('with mods-hub: the suspects are a section of the Tests tab beneath test-watch\'s body, on every surface', async ($, on) => {
  const state = world(on)
  const hub = fakeHub(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['TESTS BODY'] }) as never)
  await goTest($)
  state.output = { text: GO_PASS, fails: false }
  await goTest($)
  await flaky($)

  for (const surface of ['terminal', 'desktop'] as const) {
    hub.tab = 'home'
    let ui = await $.ui.mount({ plugin: 'flaky-detector', surface, component: 'Pane', requestId: 'claude-mods', props: { ...PANE_PROPS, title: 'Claude Mods' } })
    expect(await ui.find({ key: 'flaky-section' })).toBeUndefined()
    await ui.unmount()

    hub.tab = 'tests'
    ui = await $.ui.mount({ plugin: 'flaky-detector', surface, component: 'Pane', requestId: 'claude-mods', props: { ...PANE_PROPS, title: 'Claude Mods' } })
    expect(await ui.find({ type: 'Text', text: 'TESTS BODY' })).toBeDefined()
    expect((await ui.find({ key: 'flaky-section' }))?.text).toContain('3 suspects · 0 watched')
    expect((await ui.find({ key: 'suspect:example.com/shop/calc.TestDiv' }))?.text).toContain('1 flip')
    expect(await ui.find({ key: 'flaky-open' })).toBeDefined()
    await ui.unmount()
  }
})

test('with mods-hub but no suspects yet: the Tests tab is left as test-watch drew it', async ($, on) => {
  world(on)
  const hub = fakeHub(on)
  hub.tab = 'tests'
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['TESTS BODY'] }) as never)

  const ui = await $.ui.mount({ plugin: 'flaky-detector', surface: 'terminal', component: 'Pane', requestId: 'claude-mods', props: { ...PANE_PROPS, title: 'Claude Mods' } })
  expect(await ui.find({ type: 'Text', text: 'TESTS BODY' })).toBeDefined()
  expect(await ui.find({ key: 'flaky-section' })).toBeUndefined()
  await ui.unmount()
})
