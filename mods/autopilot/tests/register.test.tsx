import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, Plugin } from 'claude-code/testing'
import type { EngineInterface, On, RenderPropsOf, TurnCompleteInput } from 'claude-code'

import type { AutopilotRun } from '../types'

const ROOT = '/work/shop'
const HOME = '/home/me'
const NOON = new Date(2026, 9, 7, 12, 0).getTime()
const PANE: RenderPropsOf['Pane'] = { title: 'Autopilot', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }
const PASS = ' Test Files  1 passed (1)\n      Tests  3 passed (3)\n'
const FAIL = ' FAIL src/cart.test.ts > total includes tax\n Test Files  1 failed (1)\n      Tests  1 failed | 2 passed (3)\n'

type World = {
  clock: MockClock
  /** What autopilot submitted, as sent. */
  prompts: string[]
  toasts: string[]
  statuses: (string | undefined)[]
  files: Map<string, string>
  /** Each command's queued outcomes (exit code, output); the last one repeats. */
  outcomes: Map<string, [number, string][]>
  ran: string[]
  /** Called on every save of the run, as the engine stores it. */
  onSave?: ($: EngineInterface, value: unknown) => Promise<void>
}

/** A Node project at noon, and an engine that records what autopilot sends, runs and shows. */
function world(on: On, store: Record<string, unknown> = {}, env: Record<string, string> = {}): World {
  const seen: World = { clock: mock.clock(on, { now: NOON }), prompts: [], toasts: [], statuses: [], files: new Map(), outcomes: new Map(), ran: [] }
  seen.files.set(`${ROOT}/package.json`, JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .' } }))
  const kept = new Map(Object.entries(store))
  on('store.get', ($, e) => ({ value: kept.get(e.key) }))
  on('store.set', async ($, e) => {
    kept.set(e.key, e.value)
    await seen.onSave?.($, e.value)
    return { value: undefined }
  })
  mock.env(on, { HOME, ...env })
  on('session.root', () => ({ value: ROOT }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.list', () => ({ value: [{ name: 'package.json', kind: 'file', size: 10, mtimeMs: 0, isLink: false }] }))
  on('fs.read', ($, e) => (seen.files.has(e.path) ? { value: seen.files.get(e.path) ?? '' } : { deny: `ENOENT: ${e.path}` }))
  on('fs.write', ($, e) => {
    seen.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    const command = e.argv[2] ?? ''
    seen.ran.push(command)
    const queue = seen.outcomes.get(command) ?? [[0, '']]
    const [exitCode, stdout] = (queue.length > 1 ? queue.shift() : queue[0]) ?? [0, '']
    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.submit', ($, e) => {
    if (e.origin.kind === 'plugin') seen.prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  return seen
}

const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

const pilot = async ($: Engine, args: string): Promise<string> =>
  (await $.command.run({ command: 'autopilot', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 } })).text ?? ''

const ended = (turnId: string, answer: string, usd = 0): TurnCompleteInput => ({
  answer,
  durationMs: 30_000,
  isAborted: false,
  turnId,
  reason: 'answer',
  // Sonnet-class pricing: $3 per million input tokens.
  ...(usd > 0 ? { usage: { model: 'claude-sonnet-4-5', input_tokens: Math.round((usd / 3) * 1_000_000), output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } : {}),
})

/** Plays the turn of the last prompt autopilot sent, answering `answer`, then lets autopilot react. */
async function answerLast($: Engine, seen: World, turnId: string, answer: string, usd = 0): Promise<void> {
  const text = seen.prompts.at(-1) ?? ''
  await $.turn.start({ text, turnId })
  await $.turn.complete(ended(turnId, answer, usd))
  await seen.clock.advance(2_500)
  await seen.clock.settle()
}

/**
 * A stand-in for mods-hub: provides `$.mods`, reads its Interaction mode from HUB_INTERACTION, shows what
 * reaches it as toasts (`HUB …`), serves `recent` from /hub/events.json, and switches the panel's tab.
 */
const hub: Plugin = {
  name: 'mods-hub',
  register(on) {
    const MODE = { presence: 'here' as const, isSilent: false, silentUntil: null, isNight: false, quietHours: '22:00-07:00', interaction: 'auto' as const, canAsk: false }
    const INSTALLED = { hello: [], plugins: [], listedAt: null }
    on('engine.create', async ($, e, next) => ({
      ...(await next(e)),
      mods: {
        publish: async () => ({ id: '' }),
        recent: async () => [],
        latest: async () => null,
        notify: async () => ({ id: '', targets: [], held: false }),
        mode: async () => MODE,
        setMode: async () => MODE,
        setPresence: async () => MODE,
        registerTab: async () => ({ tabs: [] }),
        showTab: async () => ({ isPlaced: false }),
        registerChannel: async () => ({ channels: [] }),
        channelStatus: async () => ({ channels: [] }),
        deliver: async () => ({ isDelivered: false }),
        drain: async () => [],
        stop: async input => ({ id: 'c1', action: input.action ?? 'stop', scope: input.scope ?? 'session', reason: input.reason, by: input.by ?? '', session: 's', source: '', at: 0 }),
        hello: async () => ({ installed: INSTALLED }),
        installed: async () => INSTALLED,
        share: async input => ({ key: input.name, owner: '', value: input.value, at: 0 }),
        read: async () => null,
      },
    }))
    on('mods.mode', async $ => {
      const switched = await $.fs.read('/hub/interaction').catch(() => '')
      const interaction = switched === 'off' || (switched === '' && (await $.env.get('HUB_INTERACTION')) === 'off') ? 'off' : 'auto'
      return { value: { ...MODE, interaction, canAsk: interaction !== 'off' } }
    })
    on('mods.publish', ($, e) => {
      $.ui.toast(`HUB publish ${e.topic}`)
      return { value: { id: 'e1' } }
    })
    on('mods.notify', ($, e) => {
      $.ui.toast(`HUB notify ${e.level}${e.kind === 'question' ? ' question' : ''}: ${e.title}`)
      return { value: { id: 'n1', targets: ['toast'], held: false } }
    })
    on('mods.recent', async ($, e) => {
      const raw = await $.fs.read('/hub/events.json').catch(() => '[]')
      const events = JSON.parse(raw) as { at: number }[]
      return { value: events.filter(event => event.at >= (e.since ?? 0)) as never }
    })
    on('mods.hello', () => ({ value: { installed: INSTALLED } }))
    on('mods.registerTab', () => ({ value: { tabs: [] } }))
    on('mods.showTab', async ($, e) => {
      await $.state.set({ plugin: 'mods-hub', key: 'tab' }, e.id)
      return { value: { isPlaced: true } }
    })
  },
}

test('the setup card: criteria from the project, toggles, interaction and Start, on terminal and desktop', async ($, on) => {
  const seen = world(on)
  await start($)
  const text = await pilot($, 'make the cart total include VAT')
  expect(text).toContain('Checks found: Tests pass (npm test), Lint clean (npm run lint)')
  expect(text).toContain('follows the hub (not installed): asks you when blocked')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'autopilot', surface, component: 'Pane', requestId: 'autopilot', props: PANE })
    expect((await ui.find({ key: 'crit-tests' }))?.props.label).toBe('[x] Tests pass')
    await ui.press({ key: 'crit-lint' })
    expect((await ui.find({ key: 'crit-lint' }))?.props.label).toBe('[ ] Lint clean')
    await ui.press({ key: 'crit-lint' })
    await ui.input({ key: 'custom', text: './scripts/smoke.sh' })
    expect(await ui.find({ text: /scripts\/smoke\.sh/ })).toBeDefined()
    await ui.press({ key: 'interaction-never' })
    expect(await ui.find({ text: 'never asks: states assumptions and parks questions' })).toBeDefined()
    await ui.press({ key: 'interaction-hub' })
    await ui.unmount()
  }

  // Surfaces without text fields still draw the card: toggles and Start, the defaults for the rest.
  for (const surface of ['mobile', 'vscode'] as const) {
    const small = await $.ui.mount({ plugin: 'autopilot', surface, component: 'Pane', requestId: 'autopilot', props: PANE })
    expect(await small.find({ key: 'start' })).toBeDefined()
    expect(await small.find({ key: 'crit-tests' })).toBeDefined()
    await small.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'autopilot', surface: 'desktop', component: 'Pane', requestId: 'autopilot', props: PANE })
  await ui.press({ key: 'crit-lint' })
  await ui.press({ key: 'workflow' })
  await ui.press({ key: 'start' })
  await seen.clock.settle()
  expect(seen.prompts).toHaveLength(1)
  expect(seen.prompts[0]).toContain('[Autopilot] Goal: make the cart total include VAT')
  expect(seen.prompts[0]).toContain('- Tests pass: `npm test`')
  expect(seen.prompts[0]).toContain('- Command exits 0: `./scripts/smoke.sh`')
  expect(seen.prompts[0]).not.toContain('npm run lint')
  expect(seen.prompts[0]).toContain('The Workflow tool is allowed in this run')
  expect(await ui.find({ text: /✈ Autopilot · running/ })).toBeDefined()
  expect(await ui.find({ key: 'pause' })).toBeDefined()
  await ui.unmount()
})

test('drives a run to success without the hub: plan, steps, its own checks, toast and the saved plan', async ($, on) => {
  const seen = world(on)
  seen.outcomes.set('npm test', [[1, FAIL], [0, PASS]])
  await start($)
  await pilot($, 'make the cart total include VAT')
  expect(await pilot($, 'go')).toContain('Autopilot started')
  await seen.clock.settle()
  expect(seen.prompts[0]).toContain('reply with a numbered list')

  await answerLast($, seen, 't1', 'Plan:\n1. Find where totals are computed\n2. Add VAT and a test')
  expect(seen.prompts[1]).toContain('[Autopilot] Step 1/2: Find where totals are computed')
  expect(seen.ran).toEqual([])

  await answerLast($, seen, 't2', 'Totals live in src/cart.ts.', 0.4)
  expect(seen.ran).toEqual(['npm test', 'npm run lint'])
  expect(seen.prompts[2]).toContain('Step 2/2: Add VAT and a test')
  expect(seen.statuses.at(-1)).toMatch(/^✈ autopilot · step 2\/2 · \$0\.40/)

  await answerLast($, seen, 't3', 'Added VAT.\nASSUMPTION: VAT is 20%')
  expect(seen.prompts).toHaveLength(3)
  expect(seen.toasts.some(toast => toast.startsWith('Autopilot: goal reached'))).toBe(true)
  expect(seen.statuses.at(-1)).toBeUndefined()
  const saved = JSON.parse(seen.files.get(`${HOME}/.claude/claude-mods/autopilot/last-plan.json`) ?? '{}')
  expect(saved).toMatchObject({ goal: 'make the cart total include VAT', steps: ['Find where totals are computed', 'Add VAT and a test'] })
  expect(saved.checks).toEqual([{ name: 'Tests pass', command: 'npm test' }, { name: 'Lint clean', command: 'npm run lint' }])
  expect(await pilot($, 'status')).toContain('✈ succeeded')
})

test('never submits while a turn runs, and steps back when you type', async ($, on) => {
  const seen = world(on)
  seen.outcomes.set('npm test', [[1, FAIL]])
  await start($)
  await $.turn.start({ text: 'my own question', turnId: 'mine' })
  await pilot($, 'fix the flaky checkout test')
  await pilot($, 'go')
  await seen.clock.advance(20_000)
  expect(seen.prompts).toEqual([])
  await $.turn.complete(ended('mine', 'an answer'))
  await seen.clock.advance(2_500)
  expect(seen.prompts).toHaveLength(1)

  await answerLast($, seen, 't1', '1. Reproduce\n2. Fix')
  expect(seen.prompts).toHaveLength(2)
  await $.prompt.submit({ text: 'wait, use the staging config', wait: false, origin: { kind: 'composer' } })
  expect(await pilot($, 'status')).toContain('✈ paused')
  await answerLast($, seen, 't2', 'Reproduced it.')
  await seen.clock.advance(60_000)
  expect(seen.prompts).toHaveLength(2)
  expect(await pilot($, 'resume')).toBe('Resumed.')
  await seen.clock.advance(2_500)
  expect(seen.prompts[2]).toContain('Step 2/2: Fix')
})

test('loop limits: failed checks are fed back, retried once escalated, then it stops and says so', async ($, on) => {
  const seen = world(on)
  seen.outcomes.set('npm test', [[1, FAIL]])
  await start($)
  await pilot($, 'make the cart total include VAT')
  await pilot($, 'go')
  await seen.clock.settle()
  await answerLast($, seen, 't1', '1. Add VAT')
  await answerLast($, seen, 't2', 'Added VAT.')
  expect(seen.prompts[2]).toContain('The success checks fail (round 1 of 3)')
  expect(seen.prompts[2]).toContain('Tests pass: `npm test` → ✗ 1 failed · 2 passed')
  expect(seen.prompts[2]).toContain('total includes tax')
  await answerLast($, seen, 't3', 'Fixed it.')
  expect(seen.prompts[3]).toContain('stronger model (model: opus)')
  await answerLast($, seen, 't4', 'Fixed it for real.')
  expect(seen.prompts).toHaveLength(4)
  expect(seen.toasts.some(toast => toast.startsWith('Autopilot failed — 3 failed check rounds in a row'))).toBe(true)
  await seen.clock.advance(60_000)
  expect(seen.prompts).toHaveLength(4)
})

test('the budget cap stops the run after the turn that spent it', async ($, on) => {
  const seen = world(on)
  seen.outcomes.set('npm test', [[1, FAIL]])
  await start($)
  await pilot($, 'make the cart total include VAT')
  await pilot($, 'go')
  await seen.clock.settle()
  await answerLast($, seen, 't1', '1. Add VAT\n2. Add a test', 2)
  await answerLast($, seen, 't2', 'Added VAT.', 3.5)
  expect(seen.prompts).toHaveLength(2)
  expect(seen.toasts.some(toast => toast.includes('Autopilot stopped — the budget ($5.00) is spent'))).toBe(true)
})

test('asks when blocked without the hub, and your answer goes out with /autopilot resume', async ($, on) => {
  const seen = world(on)
  await start($)
  await pilot($, 'add a database')
  await pilot($, 'go')
  await seen.clock.settle()
  expect(seen.prompts[0]).toContain('BLOCKED: <your question>')
  await answerLast($, seen, 't1', '1. Pick a database\nBLOCKED: Postgres or SQLite?')
  expect(seen.toasts.some(toast => toast.startsWith('Autopilot needs you — Postgres or SQLite?'))).toBe(true)
  expect(seen.statuses.at(-1)).toBe('✈ autopilot · needs you')
  await seen.clock.advance(60_000)
  expect(seen.prompts).toHaveLength(1)
  await pilot($, 'resume SQLite, it is a small app')
  await seen.clock.advance(2_500)
  expect(seen.prompts[1]).toContain('About your question (“Postgres or SQLite?”): SQLite, it is a small app')
})

test('with the hub and interaction off: never asks, parks questions, notifies and draws in the panel', { plugins: [hub] }, async ($, on) => {
  const seen = world(on, {}, { HUB_INTERACTION: 'off' })
  await start($)
  expect(await pilot($, 'add a database')).toContain('follows the hub (interaction off): never asks, parks questions')
  await pilot($, 'go')
  await seen.clock.settle()
  expect(seen.prompts[0]).toContain('Never ask me anything')
  expect(seen.toasts).toContain('HUB publish task.started')

  await answerLast($, seen, 't1', '1. Pick a database\n2. Write the migration\nBLOCKED: Postgres or SQLite?')
  expect(seen.prompts[1]).toContain('Step 1/2: Pick a database')
  expect(seen.toasts.some(toast => toast.includes('question'))).toBe(false)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'autopilot', surface, component: 'Pane', requestId: 'claude-mods', props: { ...PANE, title: 'Claude Mods' } })
    expect(await ui.find({ text: 'Parked questions (1)' })).toBeDefined()
    expect(await ui.find({ text: /Postgres or SQLite\?/ })).toBeDefined()
    expect(await ui.find({ key: 'stop' })).toBeDefined()
    await ui.unmount()
  }

  // "stop" from your phone reaches the hub as channel.inbound: the run ends at the next look.
  seen.files.set('/hub/events.json', JSON.stringify([{ id: 'x', topic: 'channel.inbound', data: { channel: 'whatsapp', from: 'me', text: 'stop', isOwner: true }, source: 'whatsapp-bridge', at: NOON + 60_000, session: 's', scope: 'session' }]))
  await seen.clock.advance(65_000)
  expect(await pilot($, 'status')).toContain('Reason: stopped from whatsapp')
  expect(seen.toasts).toContain('HUB notify warning: Autopilot stopped')
  expect(seen.toasts).toContain('HUB publish task.finished')
})

test('with the hub: control.pause, control.resume and control.stop ($.mods.stop, from any session) drive the run', { plugins: [hub] }, async ($, on) => {
  const seen = world(on)
  await start($)
  await pilot($, 'add a database')
  await pilot($, 'go')
  await seen.clock.settle()
  const control = (topic: string, at: number, reason: string) => ({ id: `e-${at}`, topic, data: { id: `c-${at}`, scope: 'all', reason, by: 'owner via whatsapp', session: 'other' }, source: 'whatsapp-bridge', at, session: 'other', scope: 'session' })

  seen.files.set('/hub/events.json', JSON.stringify([control('control.pause', NOON + 60_000, 'lunch')]))
  await seen.clock.advance(65_000)
  expect(await pilot($, 'status')).toContain('paused by owner via whatsapp: lunch')

  seen.files.set('/hub/events.json', JSON.stringify([control('control.resume', NOON + 130_000, 'back')]))
  await seen.clock.advance(10_000)
  expect(await pilot($, 'status')).not.toContain('paused')

  seen.files.set('/hub/events.json', JSON.stringify([control('control.stop', NOON + 140_000, 'STOP ALL from WhatsApp')]))
  await seen.clock.advance(10_000)
  expect(await pilot($, 'status')).toContain('Reason: stopped by owner via whatsapp: STOP ALL from WhatsApp')
})

test('resumes a run saved by a session that closed mid-turn', async ($, on) => {
  const inFlight: Partial<AutopilotRun> = {
    id: 'run-saved-0001',
    goal: 'make the cart total include VAT',
    project: ROOT,
    criteria: [{ id: 'tests', kind: 'tests', label: 'Tests pass', command: 'npm test', isOn: true }],
    budgetUsd: 5,
    maxMinutes: 60,
    maxTurns: 30,
    maxFailures: 3,
    neverAsk: false,
    allowWorkflow: false,
    status: 'running',
    phase: 'execute',
    steps: ['Find the total', 'Add VAT'],
    stepIndex: 1,
    turns: 2,
    failuresInRow: 0,
    escalateNext: false,
    spentUsd: 0.8,
    startedAt: NOON - 600_000,
    activeMs: 0,
    runningSince: NOON - 600_000,
    awaiting: { kind: 'step', marker: '[autopilot run-save step 3]', submittedAt: NOON - 60_000, isEscalated: false },
    isChecking: false,
    questions: [],
    assumptions: [],
    blockedQuestion: '',
    approvalId: '',
    pendingAnswer: null,
    stopAfterTurn: '',
    reason: '',
    timeline: [],
    endedAt: null,
  }
  const seen = world(on, { [`run:${ROOT}`]: inFlight })
  await start($)
  await seen.clock.advance(10_000)
  expect(seen.prompts).toEqual([])
  const status = await pilot($, 'status')
  expect(status).toContain('✈ paused')
  expect(status).toContain('restored after a restart')
  expect(await pilot($, 'resume')).toBe('Resumed.')
  await seen.clock.advance(2_500)
  expect(seen.prompts[0]).toContain('[Autopilot] Step 2/2: Add VAT')
  expect(seen.prompts[0]).toContain('Done so far: steps 1–1.')
})

test('typing while autopilot saves its next prompt: the prompt is held back, nothing is sent behind your turn', async ($, on) => {
  let typeNow = false
  const seen = world(on)
  seen.onSave = async (_, value) => {
    const run = value as AutopilotRun | null
    if (typeNow && run !== null && run.awaiting !== null && run.status === 'running') {
      typeNow = false
      await $.prompt.submit({ text: 'actually, wait', wait: false, origin: { kind: 'composer' } })
    }
  }
  const ours = (): string[] => seen.prompts.filter(prompt => prompt.startsWith('[Autopilot]'))
  await start($)
  await pilot($, 'make the cart total include VAT')
  await pilot($, 'go')
  await seen.clock.settle()
  await answerLast($, seen, 't1', '1. Add VAT\n2. Add a test')
  expect(ours()).toHaveLength(2)
  seen.outcomes.set('npm test', [[1, FAIL]])
  await $.turn.start({ text: ours().at(-1) ?? '', turnId: 't2' })
  typeNow = true
  await $.turn.complete(ended('t2', 'Added VAT.'))
  await seen.clock.advance(30_000)
  expect(ours()).toHaveLength(2)
  const status = await pilot($, 'status')
  expect(status).toContain('✈ paused')
  expect(status).toContain('turns 2/30')
  expect(await pilot($, 'resume')).toBe('Resumed.')
  await seen.clock.advance(2_500)
  expect(ours()[2]).toContain('Step 2/2: Add a test')
})

test('with the hub: control.resume lifts a pause but never answers a blocked question', { plugins: [hub] }, async ($, on) => {
  const seen = world(on)
  await start($)
  await pilot($, 'add a database')
  await pilot($, 'go')
  await seen.clock.settle()
  await answerLast($, seen, 't1', '1. Pick a database\nBLOCKED: Postgres or SQLite?')
  seen.files.set('/hub/events.json', JSON.stringify([{ id: 'r1', topic: 'control.resume', data: { id: 'c1', scope: 'all', reason: 'back', by: 'owner', session: 'other' }, source: 'mods-hub', at: NOON + 60_000, session: 'other', scope: 'session' }]))
  await seen.clock.advance(65_000)
  expect(seen.prompts).toHaveLength(1)
  expect(await pilot($, 'status')).toContain('✈ blocked')
})

test('with the hub: the Interaction mode in force when you press Start counts, not the one when the card opened', { plugins: [hub] }, async ($, on) => {
  const seen = world(on)
  await start($)
  expect(await pilot($, 'add a database')).toContain('follows the hub (interaction auto): asks you when blocked')
  seen.files.set('/hub/interaction', 'off')
  await pilot($, 'go')
  await seen.clock.settle()
  expect(seen.prompts[0]).toContain('Never ask me anything')
})
