import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, RenderPropsOf, TurnCompleteInput } from 'claude-code'

import { fromStore, moveItem, parseQueueArgs, statusText } from '../hooks/queue'
import { fakeHub } from './hub'

const ROOT = '/work/shop'
const STORE_KEY = `queue:${ROOT}`
/** The pause after a turn ends before the next queued prompt goes, plus a little. */
const SETTLE = 1_600
const PANE: RenderPropsOf['Pane'] = {
  title: 'Queue',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

type World = { clock: MockClock; submitted: string[]; statuses: (string | undefined)[]; toasts: string[]; draft: { text: string } }

/** An engine beneath the plugin: it records what the queue submits and shows; the test drives the turns. */
function world(on: On, stored: Record<string, unknown> = {}): World {
  const seen: World = { clock: mock.clock(on, { now: 1_000_000 }), submitted: [], statuses: [], toasts: [], draft: { text: '' } }
  mock.store(on, stored)
  on('session.root', () => ({ value: ROOT }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('prompt.submit', ($, e) => {
    if (e.origin.kind === 'plugin') seen.submitted.push(e.text)
    return { text: e.text }
  })
  on('prompt.read', () => ({ value: { text: seen.draft.text, cursor: 0 } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.status', ($, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  return seen
}

const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

const queue = async ($: Engine, args: string): Promise<string> =>
  (await $.command.run({ command: 'queue', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })).text ?? ''

const ended = (turnId: string, reason: TurnCompleteInput['reason'] = 'answer'): TurnCompleteInput =>
  reason === 'refusal'
    ? { answer: '', durationMs: 4_000, isAborted: false, turnId, reason, refusal: { category: null, explanation: null } }
    : { answer: 'ok', durationMs: 4_000, isAborted: reason === 'aborted', turnId, reason }

/** The engine running a turn for the prompt just submitted. */
async function runTurn($: Engine, seen: World, turnId: string, reason: TurnCompleteInput['reason'] = 'answer'): Promise<void> {
  await $.turn.start({ text: seen.submitted.at(-1) ?? '', turnId })
  await seen.clock.advance(30_000)
  await $.turn.complete(ended(turnId, reason))
  await seen.clock.advance(SETTLE)
}

test('reads /queue arguments, reorders and reads back a stored queue', async () => {
  expect(parseQueueArgs('')).toEqual({ kind: 'open' })
  expect(parseQueueArgs('list')).toEqual({ kind: 'list' })
  expect(parseQueueArgs('add fix the build')).toEqual({ kind: 'add', text: 'fix the build' })
  expect(parseQueueArgs('fix the build')).toEqual({ kind: 'add', text: 'fix the build' })
  expect(parseQueueArgs('clear the cache, then rebuild')).toEqual({ kind: 'add', text: 'clear the cache, then rebuild' })
  expect(parseQueueArgs('remove 2')).toEqual({ kind: 'remove', position: 2 })
  expect(parseQueueArgs('rm x').kind).toBe('usage')
  expect(parseQueueArgs('PAUSE')).toEqual({ kind: 'pause' })

  const items = ['a', 'b', 'c'].map(text => ({ id: text, text, addedAt: 0 }))
  expect(moveItem(items, 2, -1).map(item => item.text)).toEqual(['a', 'c', 'b'])
  expect(moveItem(items, 0, -1).map(item => item.text)).toEqual(['a', 'b', 'c'])

  const view = { items, isPaused: true, pauseReason: '', running: null, recent: [], streak: 0 }
  expect(statusText(view)).toBe('⏸ queue 3 paused')
  expect(statusText({ ...view, isPaused: false })).toBe('⏭ queue 3')
  expect(fromStore({ items: [{ id: 'x', text: 'ok' }, { text: 42 }, null], isPaused: 'yes' }, { items: 50, recent: 5 })).toEqual({
    items: [{ id: 'x', text: 'ok', addedAt: 0 }],
    isPaused: false,
    pauseReason: '',
    recent: [],
  })
})

test('runs queued prompts one after another as your words, never while a turn is running', async ($, on) => {
  const seen = world(on)
  await start($)

  await $.turn.start({ text: 'refactor the cart', turnId: 'person-1' })
  expect(await queue($, 'add write tests for the cart')).toContain('runs when Claude is free')
  expect(await queue($, 'update the README')).toContain('Queued #2')
  expect(seen.statuses.at(-1)).toBe('⏭ queue 2')
  await seen.clock.advance(60_000)
  expect(seen.submitted).toEqual([])

  await $.turn.complete(ended('person-1'))
  await seen.clock.advance(1_000)
  expect(seen.submitted).toEqual([]) // a prompt you typed meanwhile would go first
  await seen.clock.advance(SETTLE)
  expect(seen.submitted).toEqual(['write tests for the cart'])
  expect(seen.statuses.at(-1)).toBe('▶ queue · 1 waiting')

  await runTurn($, seen, 'queued-1')
  expect(seen.submitted).toEqual(['write tests for the cart', 'update the README'])
  await runTurn($, seen, 'queued-2')
  expect(seen.submitted).toHaveLength(2)
  expect(seen.statuses.at(-1)).toBeUndefined()
  expect(await queue($, 'list')).toContain('The queue is empty')
})

test('a prompt queued while idle starts at once; one you are typing holds it back', async ($, on) => {
  const seen = world(on)
  await start($)
  seen.draft.text = 'half-typed thought'
  expect(await queue($, 'run the linter')).toContain('starting now')
  await seen.clock.advance(20_000)
  expect(seen.submitted).toEqual([])

  seen.draft.text = ''
  await seen.clock.advance(5_000)
  expect(seen.submitted).toEqual(['run the linter'])
})

test('an interruption or an error pauses the queue until /queue resume', async ($, on) => {
  const seen = world(on)
  await start($)
  await queue($, 'first')
  await queue($, 'second')
  await queue($, 'third')
  await seen.clock.advance(SETTLE)
  expect(seen.submitted).toEqual(['first'])

  await runTurn($, seen, 'q1', 'aborted')
  await seen.clock.advance(60_000)
  expect(seen.submitted).toEqual(['first'])
  expect(seen.toasts.at(-1)).toContain('queue paused: you interrupted a turn')
  expect(await queue($, 'list')).toContain('⏸ paused: you interrupted a turn')

  expect(await queue($, 'resume')).toContain('starting second')
  await seen.clock.advance(SETTLE)
  expect(seen.submitted).toEqual(['first', 'second'])
  await runTurn($, seen, 'q2', 'error')
  await seen.clock.advance(60_000)
  expect(seen.submitted).toEqual(['first', 'second'])
  expect(seen.statuses.at(-1)).toBe('⏸ queue 1 paused')
})

test('stops after maxRuns prompts in a row without you; a prompt you type resets the count', { options: { maxRuns: 2 } }, async ($, on) => {
  const seen = world(on)
  await start($)
  for (const text of ['one', 'two', 'three', 'four']) await queue($, text)
  await seen.clock.advance(SETTLE)
  await $.turn.start({ text: 'one', turnId: 'q1' })
  // Typed while "one" runs: you are around, so the count starts again.
  await $.prompt.submit({ text: 'also bump the version', wait: false, origin: { kind: 'composer' }, turnId: 'q1' })
  await $.turn.complete(ended('q1'))
  await seen.clock.advance(SETTLE)
  await runTurn($, seen, 'q2')
  await runTurn($, seen, 'q3')
  await seen.clock.advance(60_000)
  expect(seen.submitted).toEqual(['one', 'two', 'three'])
  expect(seen.toasts.at(-1)).toContain('2 prompts ran in a row without you')
  expect(seen.statuses.at(-1)).toBe('⏸ queue 1 paused')

  await queue($, 'resume')
  await seen.clock.advance(SETTLE)
  expect(seen.submitted).toEqual(['one', 'two', 'three', 'four'])
})

test('prompts left from an earlier session wait paused', async ($, on) => {
  const seen = world(on, { [STORE_KEY]: { items: [{ id: 'old', text: 'migrate the db', addedAt: 1 }], isPaused: false } })
  await start($)
  await seen.clock.advance(60_000)
  expect(seen.submitted).toEqual([])
  expect(seen.toasts[0]).toContain('1 queued prompt from last time')
  expect(seen.statuses.at(-1)).toBe('⏸ queue 1 paused')

  await queue($, 'resume')
  await seen.clock.advance(SETTLE)
  expect(seen.submitted).toEqual(['migrate the db'])
})

test('the pane reorders, removes, adds and pauses on terminal and desktop', async ($, on) => {
  const seen = world(on)
  await start($)
  await queue($, 'pause')
  for (const text of ['alpha', 'beta', 'gamma']) await queue($, text)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'task-queue', surface, component: 'Pane', requestId: 'queue', props: PANE })
    expect((await ui.find({ key: 'headline' }))?.text).toContain('Paused: paused by you')
    const down = String((await ui.findAll({ type: 'Button', text: '↓' }))[0]?.key)
    expect(down).toMatch(/^down:/)
    await ui.press({ key: down })
    const rows = (await ui.findAll({ type: 'Text', text: /^(alpha|beta|gamma)$/ })).map(row => row.text)
    expect(rows).toEqual(['beta', 'alpha', 'gamma'])
    await ui.press({ key: down.replace('down:', 'up:') })
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'task-queue', surface: 'desktop', component: 'Pane', requestId: 'queue', props: PANE })
  const remove = (await ui.findAll({ type: 'Button', text: '✕' }))[0]
  await ui.press({ key: String(remove?.key) })
  await ui.input({ key: 'add', text: 'delta' })
  expect(await queue($, 'list')).toContain('1. beta\n2. gamma\n3. delta')
  await ui.press({ key: 'resume' })
  await seen.clock.advance(SETTLE)
  expect(seen.submitted).toEqual(['beta'])
  await ui.unmount()
})

test('with mods-hub: tasks are published, a hub pause holds the queue until its resume, and the end reaches you when away', async ($, on) => {
  const seen = world(on)
  const hub = fakeHub(on, { presence: 'away' }, seen.clock)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['HUB STRIP'] }) as never)
  await start($)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['task.queued', 'task.started', 'task.finished'], consumes: ['session.idle', 'control.stop', 'control.pause', 'control.resume'] }])
  expect(hub.tabs).toEqual([{ id: 'queue', title: 'Queue', order: 220, command: 'queue' }])

  await queue($, 'write tests for the cart')
  await seen.clock.advance(500)
  const [queued, started] = hub.published
  expect(queued).toEqual({ topic: 'task.queued', data: { id: expect.any(String), title: 'write tests for the cart' } })
  expect(started).toEqual({ topic: 'task.started', data: { id: (queued?.data as { id: string }).id, title: 'write tests for the cart' } })
  await runTurn($, seen, 'queued-1')
  expect(hub.published.at(-1)).toEqual({ topic: 'task.finished', data: { id: (queued?.data as { id: string }).id, title: 'write tests for the cart', outcome: 'ok' } })
  expect(hub.notified).toEqual([{ level: 'success', title: '✓ Queue done: 1 prompt ran', body: 'write tests for the cart', topic: 'task.finished' }])

  // A STOP from the phone, through the hub: the queue holds.
  hub.events.push({ topic: 'control.pause', source: 'telegram-bridge', at: seen.clock.now() + 1, data: { id: 'c1', scope: 'all', reason: 'lunch', by: 'owner via telegram', session: 's1' } })
  await seen.clock.advance(5_000)
  expect(await queue($, 'update the README')).toContain('the queue is paused')
  expect(await queue($, 'list')).toContain('paused by owner via telegram (lunch)')
  await seen.clock.advance(10_000)
  expect(seen.submitted).toEqual(['write tests for the cart'])

  hub.events.push({ topic: 'control.resume', source: 'telegram-bridge', at: seen.clock.now() + 1, data: { id: 'c2', scope: 'all', reason: '', by: 'owner via telegram', session: 's1' } })
  await seen.clock.advance(5_500)
  expect(seen.submitted).toEqual(['write tests for the cart', 'update the README'])

  // /queue opens the Queue tab of the shared panel instead of its own pane.
  await queue($, '')
  expect(hub.shown).toEqual(['queue'])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'task-queue', surface, component: 'Pane', requestId: 'claude-mods', props: { ...PANE, title: 'Claude Mods' } })
    expect(await ui.find({ type: 'Text', text: 'HUB STRIP' })).toBeDefined()
    expect(await ui.find({ key: 'headline' })).toBeDefined()
    expect(await ui.find({ key: 'close' })).toBeUndefined()
    await ui.unmount()
  }
})
