import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, RenderPropsOf, TurnCompleteInput } from 'claude-code'

import { changedBetween, nextOccurrence, parseClock, parseShiftArgs, snapshotOf } from '../hooks/shift'
import { fakeHub } from './hub'

const ROOT = '/work/shop'
const BASE = 'abc1234def5678'
const REPORT = `${ROOT}/.claude/night-shift/2026-10-08.md`
const MINUTE = 60_000
const PANE: RenderPropsOf['Pane'] = {
  title: 'Night shift',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

/** A task as the shift submitted it: its own words, and the whole text with the unattended note. */
type Submitted = { text: string; full: string }
type World = {
  clock: MockClock
  submitted: Submitted[]
  toasts: string[]
  statuses: (string | undefined)[]
  files: Map<string, string>
  aborted: string[]
  git: { status: string; numstat: string; untracked: string; stat: string }
}

/** A clean repository at 01:50 local time, and an engine that records what the shift submits. */
function world(on: On): World {
  const seen: World = {
    clock: mock.clock(on, { now: new Date(2026, 9, 8, 1, 50).getTime() }),
    submitted: [],
    toasts: [],
    statuses: [],
    files: new Map(),
    aborted: [],
    git: { status: '', numstat: '', untracked: '', stat: '' },
  }
  mock.store(on)
  on('session.root', () => ({ value: ROOT }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', ($, e) => {
    const args = e.argv.slice(1).join(' ')
    const answer = (exitCode: number, stdout = '') => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (args === 'rev-parse --show-toplevel') return answer(0, `${ROOT}\n`)
    if (args === 'rev-parse --verify -q HEAD') return answer(0, `${BASE}\n`)
    if (args === 'status --porcelain') return answer(0, seen.git.status)
    if (args.startsWith('diff --numstat')) return answer(0, seen.git.numstat)
    if (args.startsWith('ls-files')) return answer(0, args.includes('-z') ? seen.git.untracked : seen.git.untracked.replaceAll('\0', '\n'))
    if (args.startsWith('diff --stat')) return answer(0, seen.git.stat)
    return answer(1)
  })
  on('fs.exists', ($, e) => ({ value: seen.files.has(e.path) }))
  on('fs.write', ($, e) => {
    seen.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    if (e.origin.kind === 'plugin') seen.submitted.push({ text: e.text.split('\n\n(night-shift')[0] ?? '', full: e.text })
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.abort', ($, e) => {
    seen.aborted.push(e.turnId)
    return { value: undefined }
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', () => ({ value: undefined }))
  return seen
}

const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

const shift = async ($: Engine, args: string): Promise<string> =>
  (await $.command.run({ command: 'night-shift', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })).text ?? ''

const ended = (turnId: string, reason: 'answer' | 'aborted' | 'error', answer = 'Done.'): TurnCompleteInput => ({
  answer,
  durationMs: 12 * MINUTE,
  isAborted: reason === 'aborted',
  turnId,
  reason,
})

test('reads times, arguments and git snapshots', async () => {
  expect(parseClock('02:00')).toEqual({ hour: 2, minute: 0 })
  expect(parseClock('11:30pm')).toEqual({ hour: 23, minute: 30 })
  expect(parseClock('2am')).toEqual({ hour: 2, minute: 0 })
  expect(parseClock('25:00')).toBeUndefined()
  expect(parseClock('7')).toBeUndefined()
  expect(parseShiftArgs('at 2am')).toEqual({ kind: 'at', hour: 2, minute: 0 })
  expect(parseShiftArgs('add fix the flaky test')).toEqual({ kind: 'add', text: 'fix the flaky test' })
  expect(parseShiftArgs('at noon').kind).toBe('usage')
  expect(parseShiftArgs('fix it').kind).toBe('usage')

  const evening = new Date(2026, 9, 7, 22, 0).getTime()
  expect(nextOccurrence(evening, 2, 0)).toBe(new Date(2026, 9, 8, 2, 0).getTime())
  expect(nextOccurrence(evening, 23, 0)).toBe(new Date(2026, 9, 7, 23, 0).getTime())

  const before = snapshotOf('1\t0\tsrc/a.ts\0', '')
  const after = snapshotOf('4\t1\tsrc/a.ts\x002\t0\tREADME.md\0', 'notes.txt\0')
  expect(changedBetween(before, after)).toEqual(['README.md', 'notes.txt', 'src/a.ts'])
  expect(changedBetween(after, after)).toEqual([])
})

test('runs the queued tasks one by one at the set time and leaves a report for the morning', async ($, on) => {
  const seen = world(on)
  await start($)
  await shift($, 'add Write tests for the cart')
  await shift($, 'add Update the README')
  expect(await shift($, 'at 02:00')).toContain('Scheduled for 02:00 (in 10m)')
  expect(seen.statuses.at(-1)).toBe('🌙 night shift at 02:00 · 2 tasks')

  await seen.clock.advance(9 * MINUTE)
  expect(seen.submitted).toEqual([])
  await seen.clock.advance(MINUTE + 1_000)
  expect(seen.submitted.map(one => one.text)).toEqual(['Write tests for the cart'])
  expect(seen.submitted[0]?.full).toContain('(night-shift: this task runs unattended')
  expect(seen.files.get(REPORT)).toContain('## Not run')

  await $.turn.start({ text: 'Write tests for the cart', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/test/cart.test.ts`, old_string: 'a', new_string: 'b' })
  seen.git.numstat = '30\t0\ttest/cart.test.ts\0'
  await seen.clock.advance(12 * MINUTE)
  expect(seen.submitted).toHaveLength(1) // never while a turn runs
  await $.turn.complete(ended('t1', 'answer', 'Added 6 cart tests; all pass with `npm test`.'))
  await seen.clock.advance(4_000)
  expect(seen.submitted.map(one => one.text)).toEqual(['Write tests for the cart', 'Update the README'])

  await $.turn.start({ text: 'Update the README', turnId: 't2' })
  seen.git.numstat = '30\t0\ttest/cart.test.ts\x005\t2\tREADME.md\0'
  seen.git.stat = ' README.md          |  7 +++++--\n test/cart.test.ts  | 30 ++++++++\n 2 files changed, 35 insertions(+), 2 deletions(-)\n'
  await $.turn.complete(ended('t2', 'answer'))
  await seen.clock.advance(4_000)

  const report = seen.files.get(REPORT) ?? ''
  expect(report).toContain('# Night shift — 2026-10-08')
  expect(report).toContain('- Tasks: 2 done (of 2)')
  expect(report).toContain('## 1. ✓ Write tests for the cart')
  expect(report).toContain('Files changed: `test/cart.test.ts`')
  expect(report).toContain('> Added 6 cart tests; all pass with `npm test`.')
  expect(report).toContain('## 2. ✓ Update the README\n\n- done after 12m\n- Files changed: `README.md`')
  expect(report).toContain('2 files changed, 35 insertions(+), 2 deletions(-)')
  expect(report).toContain(`git diff ${BASE.slice(0, 12)}`)
  expect(seen.toasts.at(-1)).toContain('night shift over: 2/2 done')

  await $.prompt.submit({ text: 'good morning', wait: false, origin: { kind: 'composer' } })
  expect(seen.toasts.at(-1)).toBe('🌙 night shift: 2/2 done · .claude/night-shift/2026-10-08.md')
  expect(seen.submitted).toHaveLength(2)
})

test('refuses to start on a dirty working tree; the tasks stay queued', async ($, on) => {
  const seen = world(on)
  seen.git.status = ' M src/cart.ts\n'
  await start($)
  await shift($, 'add Refactor the cart')
  expect(await shift($, 'now')).toContain('uncommitted changes')
  await seen.clock.advance(5 * MINUTE)
  expect(seen.submitted).toEqual([])
  expect(seen.toasts.at(-1)).toContain('did not start: the working tree has uncommitted changes')
  expect(await shift($, 'list')).toContain('1. Refactor the cart')
})

test('allowDirty starts anyway', { options: { allowDirty: true } }, async ($, on) => {
  const seen = world(on)
  seen.git.status = ' M src/cart.ts\n'
  await start($)
  await shift($, 'add Refactor the cart')
  expect(await shift($, 'now')).toContain('Started: 1 task')
  await seen.clock.advance(1_000)
  expect(seen.submitted.map(one => one.text)).toEqual(['Refactor the cart'])
})

test('stops an overlong task, and ends the shift after two failures in a row', { options: { taskMinutes: 5 } }, async ($, on) => {
  const seen = world(on)
  await start($)
  for (const task of ['one', 'two', 'three']) await shift($, `add ${task}`)
  await shift($, 'now')
  await seen.clock.advance(1_000)
  await $.turn.start({ text: 'one', turnId: 't1' })
  await seen.clock.advance(7 * MINUTE)
  expect(seen.aborted).toEqual(['t1'])
  await $.turn.complete(ended('t1', 'aborted'))
  await seen.clock.advance(4_000)
  expect(seen.submitted.map(one => one.text)).toEqual(['one', 'two'])

  await $.turn.start({ text: 'two', turnId: 't2' })
  await $.turn.complete(ended('t2', 'error'))
  await seen.clock.advance(10 * MINUTE)
  expect(seen.submitted).toHaveLength(2)
  const report = seen.files.get(REPORT) ?? ''
  expect(report).toContain('## 1. ⌛ one')
  expect(report).toContain('## 2. ✗ two')
  expect(report).toContain('Ended: 2 tasks in a row did not finish')
  expect(report).toContain('## Not run\n\n- three')
  expect(await shift($, 'list')).toContain('1. three')
})

test('waits for a running turn, and stops after the current task when you type', async ($, on) => {
  const seen = world(on)
  await start($)
  for (const task of ['one', 'two']) await shift($, `add ${task}`)
  await shift($, 'at 01:55')
  await $.turn.start({ text: 'what is left to do?', turnId: 'mine' })
  await seen.clock.advance(10 * MINUTE)
  expect(seen.submitted).toEqual([])
  await $.turn.complete(ended('mine', 'answer'))
  await seen.clock.advance(4_000)
  expect(seen.submitted.map(one => one.text)).toEqual(['one'])

  await $.turn.start({ text: 'one', turnId: 't1' })
  await $.prompt.submit({ text: 'actually, wait', wait: false, origin: { kind: 'composer' }, turnId: 't1' })
  await $.turn.complete(ended('t1', 'answer'))
  await seen.clock.advance(10 * MINUTE)
  expect(seen.submitted).toHaveLength(1)
  expect(seen.files.get(REPORT)).toContain('Ended: you took over')
  expect(await shift($, 'list')).toContain('1. two')
})

test('the pane lists tasks and schedules on terminal and desktop', async ($, on) => {
  const seen = world(on)
  await start($)
  await shift($, 'add Bump dependencies')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'night-shift', surface, component: 'Pane', requestId: 'night-shift', props: PANE })
    expect((await ui.find({ key: 'headline' }))?.text).toContain('Not scheduled')
    expect(await ui.find({ type: 'Text', text: 'Bump dependencies' })).toBeDefined()
    await ui.input({ key: 'at', text: '03:30' })
    expect((await ui.find({ key: 'headline' }))?.text).toContain('Starts at 03:30')
    await ui.press({ key: 'cancel' })
    await ui.unmount()
  }
  expect(seen.statuses.at(-1)).toBeUndefined()
  const ui = await $.ui.mount({ plugin: 'night-shift', surface: 'desktop', component: 'Pane', requestId: 'night-shift', props: PANE })
  await ui.press({ key: 'now' })
  await seen.clock.advance(1_000)
  expect(seen.submitted.map(one => one.text)).toEqual(['Bump dependencies'])
  expect((await ui.find({ key: 'headline' }))?.text).toContain('Running task 1 of 1')
  await ui.unmount()
})

test('with mods-hub: /night-shift away starts the shift once you leave, publishes its tasks, and the end reaches your channels', async ($, on) => {
  const seen = world(on)
  const hub = fakeHub(on, {}, seen.clock)
  await start($)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['task.started', 'task.finished'], consumes: ['session.away', 'control.stop', 'control.pause'] }])
  await shift($, 'add Write tests for the cart')
  expect(await shift($, 'away')).toContain('The shift starts once you are away')
  expect(seen.statuses.at(-1)).toBe('🌙 night shift when you are away · 1 task')

  await seen.clock.advance(3 * MINUTE)
  expect(seen.submitted).toEqual([])

  hub.mode = { ...hub.mode, presence: 'away' }
  await seen.clock.advance(MINUTE + 1_000)
  expect(seen.submitted.map(one => one.text)).toEqual(['Write tests for the cart'])
  expect(hub.notified[0]?.title).toContain('night shift started: 1 task')
  const [started] = hub.published
  expect(started?.topic).toBe('task.started')
  expect((started?.data as { title: string }).title).toBe('Write tests for the cart')

  await $.turn.start({ text: 'Write tests for the cart', turnId: 't1' })
  await $.turn.complete(ended('t1', 'answer'))
  await seen.clock.advance(4_000)
  expect(hub.published.at(-1)).toEqual({ topic: 'task.finished', data: { id: (started?.data as { id: string }).id, title: 'Write tests for the cart', outcome: 'ok' } })
  expect(hub.notified.at(-1)).toEqual({ level: 'success', title: '🌙 night shift over: 1/1 done · .claude/night-shift/2026-10-08.md', topic: 'task.finished' })
})

test('with mods-hub: a stop raised through the hub ends the shift after the current task', async ($, on) => {
  const seen = world(on)
  const hub = fakeHub(on, {}, seen.clock)
  await start($)
  await shift($, 'add Write tests for the cart')
  await shift($, 'add Update the README')
  await shift($, 'now')
  await seen.clock.advance(1_000)
  expect(seen.submitted).toHaveLength(1)
  await $.turn.start({ text: 'Write tests for the cart', turnId: 't1' })
  hub.events.push({ topic: 'control.stop', source: 'telegram-bridge', at: seen.clock.now() + 1, data: { id: 'c1', scope: 'all', reason: 'enough', by: 'owner via telegram', session: 's1' } })
  await seen.clock.advance(MINUTE)
  await $.turn.complete(ended('t1', 'answer'))
  await seen.clock.advance(4_000)
  expect(seen.submitted).toHaveLength(1)
  expect(hub.notified.at(-1)?.level).toBe('error')
  expect(seen.files.get(REPORT)).toContain('stopped by owner via telegram')
})

test('without mods-hub, /night-shift away says it needs the hub', async ($, on) => {
  world(on)
  await start($)
  expect(await shift($, 'away')).toContain('needs mods-hub')
})
