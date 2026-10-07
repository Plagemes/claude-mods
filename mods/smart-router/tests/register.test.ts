import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { AgentSpawnInput, ModelCompleteResult, On, TurnUsage } from 'claude-code'

import { fakeHub } from './hub'

const SURFACES = ['terminal', 'desktop'] as const
const MAIN = 'claude-opus-5-5'
const PANE = {
  plugin: 'smart-router',
  component: 'Pane',
  requestId: 'smart-router',
  props: { title: 'Router', isFocused: false, bodyColumns: 52, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const
const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type World = {
  spawned: { model: string | undefined; description: string; prompt: string }[]
  prompts: string[]
  statuses: (string | undefined)[]
  toasts: string[]
  writes: Map<string, string>
  store: Map<string, unknown>
  efforts: (string | undefined)[]
  commands: string[]
  bash: { failing: boolean }
  clock: MockClock
}

const world = (on: On, options: { planner?: () => ModelCompleteResult } = {}): World => {
  const state: World = { spawned: [], prompts: [], statuses: [], toasts: [], writes: new Map(), store: new Map(), efforts: [], commands: [], bash: { failing: false }, clock: mock.clock(on, { now: Date.UTC(2026, 9, 7, 12) }) }
  let ids = 0
  mock.env(on, { HOME: '/home/tester' })
  on('store.get', ($, e) => ({ value: state.store.get(e.key) }) as never)
  on('store.set', ($, e) => {
    state.store.set(e.key, e.value)
    return { value: undefined } as never
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.run', ($, e) => {
    state.commands.push(`${e.command} ${e.args}`)
    return { text: '' }
  })
  on('session.model', () => ({ value: MAIN }))
  on('session.root', () => ({ value: '/work/app' }))
  on('ui.status', ($, e) => {
    state.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.copy', () => ({ value: { isCopied: true } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'smart-router', title: 'Router', isShown: true, isFocused: false, isPlaced: true }] }))
  on('agent.list', () => ({ value: [] }))
  on('agent.spawn', ($, e) => {
    state.spawned.push({ model: e.model, description: e.description, prompt: e.prompt })
    ids += 1
    return { model: e.model ?? e.parentModel, agentId: `agent-${ids}` }
  })
  on('model.complete', () => ({ value: options.planner?.() ?? { isAnswered: false, reason: 'empty-reply', usage: ZERO } }))
  on('prompt.submit', ($, e) => {
    state.prompts.push(e.text)
    return { text: e.text }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', ($, e) => {
    if (String(e.tool) === 'Agent') state.efforts.push((e as unknown as { effort?: string }).effort)
    const isFailingTest = String(e.tool) === 'Bash' && state.bash.failing
    return isFailingTest ? { result: 'FAIL tests/a.test.ts', isError: true } : { result: 'ok' }
  })
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('fs.write', ($, e) => {
    state.writes.set(e.path, e.text)
    return { value: undefined } as never
  })
  return state
}

const start = ($: Engine) => $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })

const spawn = ($: Engine, prompt: string, over: Partial<AgentSpawnInput> = {}) =>
  $.agent.spawn({
    tool_use_id: 'tu-1',
    prompt,
    description: prompt.slice(0, 40),
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: MAIN,
    background: true,
    fork: false,
    ...over,
  })

const usage = (model: string, input: number, cached = 0): TurnUsage => ({ input_tokens: input, output_tokens: input / 10, cache_read_input_tokens: cached, cache_creation_input_tokens: 0, model })
const finish = ($: Engine, agentId: string, answer: string, turnUsage?: TurnUsage, reason: 'answer' | 'error' = 'answer') =>
  $.turn.complete({ answer, durationMs: 1_000, isAborted: false, turnId: `t-${agentId}`, agentId, reason, ...(turnUsage === undefined ? {} : { usage: turnUsage }) })
const run = (command: string, args = '') => ({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const

const EIGHT_STEPS = JSON.stringify([
  { title: 'Map the API', tier: 'light', prompt: 'List the API endpoints and their handlers.', dependsOn: [], writes: [] },
  { title: 'Map the UI', tier: 'light', prompt: 'List the screens that call the API.', dependsOn: [], writes: [] },
  { title: 'Design the schema', tier: 'deep', prompt: 'Design the new schema.', dependsOn: [1, 2], writes: ['docs/schema.md'] },
  { title: 'Migrate the server', tier: 'standard', prompt: 'Move the server to the schema.', dependsOn: [3], writes: ['server/'] },
  { title: 'Migrate the client', tier: 'standard', prompt: 'Move the client to the schema.', dependsOn: [3], writes: ['client/'] },
  { title: 'Update the tests', tier: 'standard', prompt: 'Update the tests.', dependsOn: [4, 5], writes: ['tests/'] },
  { title: 'Run the suite', tier: 'light', prompt: 'Run npm test and report failures.', dependsOn: [6], writes: [] },
  { title: 'Merge the results', tier: 'deep', prompt: 'Merge the findings of the agents.', dependsOn: [7], writes: [] },
])
const FOUR_FORMS = JSON.stringify(['Signup', 'Login', 'Profile', 'Billing'].map(name => ({ title: `Validate ${name}`, tier: 'standard', prompt: `Add zod validation to src/forms/${name}.tsx.`, dependsOn: [], writes: [`src/forms/${name}.tsx`] })))

test('routes subagents: Explore to haiku, an explicit model kept, deep on opus, a workflow agent only suggested', async ($, on) => {
  const w = world(on)
  await start($)
  await spawn($, 'Find where the session cookie is set', { subagentType: 'Explore' })
  await spawn($, 'List the TODO comments in src/', { model: 'opus' })
  await spawn($, 'Do a security review of the upload endpoint')
  await spawn($, 'List the TODO comments in lib/', { workflow: { runId: 'wf_1', agentIndex: 1 } })
  expect(w.spawned.map(one => one.model)).toEqual(['haiku', 'opus', 'opus', undefined])
  expect(w.statuses.at(-1)).toBe('⇄ router: 1 haiku · 3 opus')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Button', text: /Find where the session cookie/ }))?.key).toMatch(/^pick-/)
    expect(await ui.find({ type: 'Text', text: 'explicit' })).toBeDefined()
    const workflow = await ui.find({ type: 'Button', text: /List the TODO comments in lib/ })
    await ui.press({ key: workflow?.key ?? '' })
    expect((await ui.find({ key: `detail-${(workflow?.key ?? '').slice(5)}` }))?.text).toContain('opts.model')
    await ui.press({ key: 'detail-close' })
    await ui.unmount()
  }
})

test('suggest mode logs without changing the model; off does nothing', { options: { mode: 'suggest' } }, async ($, on) => {
  const w = world(on)
  await start($)
  await spawn($, 'Find where the session cookie is set', { subagentType: 'Explore' })
  expect(w.spawned[0]?.model).toBeUndefined()
  expect(w.statuses.at(-1)).toBe('⇄ router (suggest): 1 opus')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'suggestions only' })).toBeDefined()
  await ui.press({ key: 'mode-off' })
  await spawn($, 'List the TODO comments')
  expect(w.spawned[1]?.model).toBeUndefined()
  expect(w.statuses.at(-1)).toBeUndefined()
  await ui.press({ key: 'mode-auto' })
  await spawn($, 'List the TODO comments')
  expect(w.spawned[2]?.model).toBe('haiku')
})

test('a failed agent is retried one tier up; twice failed goes deep', async ($, on) => {
  const w = world(on)
  await start($)
  await spawn($, 'List the TODO comments in src/', { description: 'List TODOs' })
  await finish($, 'agent-1', '', usage('claude-haiku-4-5', 1000), 'error')
  await spawn($, 'List the TODO comments in src/', { description: 'List TODOs' })
  await finish($, 'agent-2', '')
  await spawn($, 'List the TODO comments in src/', { description: 'List TODOs' })
  expect(w.spawned.map(one => one.model)).toEqual(['haiku', 'sonnet', 'opus'])
})

test('counts per-model tokens and savings from turn.complete, and writes daily.json and stats.json', async ($, on) => {
  const w = world(on)
  await start($)
  await spawn($, 'Find where the session cookie is set', { subagentType: 'Explore' })
  await finish($, 'agent-1', 'src/auth/cookie.ts:12', usage('claude-haiku-4-5', 100_000, 300_000))
  await $.turn.complete({ answer: 'done', durationMs: 5_000, isAborted: false, turnId: 'main-1', reason: 'answer', usage: usage(MAIN, 10_000) })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'savings' }))?.text).toMatch(/^Saved \$0\.\d\d \(-7\d%\)$/)
    expect((await ui.find({ key: 'family-haiku' }))?.text).toContain('haiku 1 · 110k tok')
    expect((await ui.find({ key: 'cache-reuse' }))?.text).toBe('cache reuse 75% of subagent input')
    expect(await ui.find({ key: surface === 'terminal' ? 'calls-bar' : 'calls-bar' })).toBeDefined()
    await ui.unmount()
  }
  await w.clock.advance(5_000)
  const daily = JSON.parse(w.writes.get('/home/tester/.claude/claude-mods/smart-router/daily.json') ?? '{}') as { date: string; saved: number; byModel: Record<string, { calls: number }> }
  expect(daily.date).toBe('2026-10-07')
  expect(daily.saved).toBeGreaterThan(0)
  expect(daily.byModel.haiku?.calls).toBe(1)
  const stats = JSON.parse(w.writes.get('/home/tester/.claude/claude-mods/smart-router/stats.json') ?? '{}') as { agents: number; profile: string; cacheReuse: number }
  expect(stats).toEqual(expect.objectContaining({ agents: 1, profile: 'balanced', cacheReuse: 0.75 }))
})

test('prompt.compose adds one stable session section, none when routing is off', async ($, on) => {
  world(on)
  await start($)
  const compose = () => $.prompt.compose({ model: MAIN, promptModel: MAIN, surfaces: ['terminal'], tools: ['Agent', 'Bash', 'Workflow'], outputStyle: null, traits: [] })
  const first = await compose()
  const second = await compose()
  const section = first.sections.find(one => one.id === 'smart-router:routing')
  expect(section?.scope).toBe('session')
  expect(section?.text).toContain('send all their Agent calls in ONE message')
  expect(section?.text).toContain('never start one on your own')
  expect(second.sections).toEqual(first.sections)
  expect((await $.prompt.compose({ model: MAIN, promptModel: MAIN, surfaces: [], tools: ['Bash'], outputStyle: null, traits: [] })).sections).toHaveLength(1)
  await $.command.run(run('router', 'off'))
  expect((await compose()).sections).toHaveLength(1)
})

test('/route plans with the small model; Run as workflow appears only when rule B4 holds, and is the opt-in', async ($, on) => {
  let reply = EIGHT_STEPS
  const w = world(on, { planner: () => ({ isAnswered: true, text: reply, usage: ZERO }) })
  await start($)
  const routed = await $.command.run(run('route', 'Move the app to the new schema'))
  expect(routed.text).toContain('Plan: 8 subtasks in 6 stages · Workflow (needs your OK).')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'plan-workflow' })).toBeDefined()
    expect((await ui.find({ key: 'plan-forecast' }))?.text).toMatch(/≈ inline \$\d+\.\d\d · subagents \$\d+\.\d\d · workflow \$\d+\.\d\d/)
    await ui.unmount()
  }
  expect(w.prompts).toHaveLength(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'plan-workflow' })
  expect(w.prompts[0]).toMatch(/^I explicitly opt in: run this plan as a workflow with the Workflow tool/)
  await ui.unmount()

  reply = FOUR_FORMS
  await $.command.run(run('route', 'Validate the four forms'))
  for (const surface of SURFACES) {
    const mounted = await $.ui.mount({ ...PANE, surface })
    expect(await mounted.find({ key: 'plan-workflow' })).toBeUndefined()
    expect((await mounted.find({ key: 'plan-workflow-off' }))?.text).toContain('Workflow: for 6+ subtasks')
    await mounted.unmount()
  }
  const four = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await four.press({ key: 'plan-run' })
  expect(w.prompts[1]).toContain('Stage 1 — 4 in parallel:')
  expect(w.prompts[1]).toContain('model: sonnet')
  await four.press({ key: 'plan-discard' })
  expect(await four.find({ key: 'plan-run' })).toBeUndefined()
})

test('/route falls back to a one-step plan and offers the main-model switch only on a button', async ($, on) => {
  const w = world(on)
  await start($)
  await $.command.run(run('route', 'Fix the typo "Recieve" in src/Footer.tsx'))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'plan-mode' }))?.text).toContain('Inline: One step')
  expect(w.commands).toEqual([])
  await ui.press({ key: 'plan-main' })
  expect(w.commands).toEqual(['model haiku'])
})

test('a correction learns a rule for this project that changes the next classification', async ($, on) => {
  const w = world(on)
  await start($)
  await spawn($, 'Add a migration that adds a nullable archived_at column to the projects table', { description: 'Add archived column migration' })
  expect(w.spawned[0]?.model).toBe('sonnet')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const row = await ui.find({ type: 'Button', text: /Add archived column migration/ })
    await ui.press({ key: row?.key ?? '' })
    expect(await ui.find({ key: 'fix-light' })).toBeDefined()
    await ui.press({ key: 'detail-close' })
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: (await ui.find({ type: 'Button', text: /Add archived column migration/ }))?.key ?? '' })
  await ui.press({ key: 'fix-light' })
  expect(w.toasts.at(-1)).toBe('Learned: column + migration + archived → light')
  expect(w.store.get('rules:/work/app')).toEqual([expect.objectContaining({ keywords: ['column', 'migration', 'archived'], tier: 'light' })])
  await spawn($, 'Add a migration for the archived column on users', { description: 'Archived column migration' })
  expect(w.spawned[1]?.model).toBe('haiku')
  await ui.press({ key: 'section-rules' })
  const rule = await ui.find({ type: 'Text', text: 'column + migration + archived → light' })
  expect(rule).toBeDefined()
})

test('the live list follows spawns and completions; a failing test run after an agent\'s edits is learned and escalates the next change', async ($, on) => {
  const w = world(on)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '  Idle' })).toBeDefined()
  await spawn($, 'Write unit tests for the slugify helper', { description: 'Slugify tests' })
  expect((await ui.find({ key: 'live-agent-1' }))?.text).toContain('Slugify tests')
  await $.tool.call({ tool: 'Edit', file_path: '/work/app/src/slugify.test.ts', old_string: 'a', new_string: 'b', agentId: 'agent-1' } as never)
  await w.clock.advance(2_000)
  expect((await ui.find({ key: 'live-agent-1' }))?.text).toContain('1 tool call')
  await finish($, 'agent-1', 'Added 4 tests.', usage('claude-sonnet-5', 20_000))
  expect(await ui.find({ key: 'live-agent-1' })).toBeUndefined()

  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  w.bash.failing = true
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await ui.press({ key: 'section-rules' })
  expect(await ui.find({ type: 'Text', text: /^tests on standard: 65% · 2 runs$/ })).toBeDefined()
  await spawn($, 'Fix the failing slugify test', { description: 'Fix slugify' })
  expect(w.spawned[1]?.model).toBe('opus')
  expect(await ui.find({ type: 'Text', text: 'regression↑' })).toBeDefined()
})

test('quality checks: an edited light/standard agent is offered a review one tier up whose verdict is learned', { options: { auditRate: 100 } }, async ($, on) => {
  const w = world(on)
  await start($)
  await spawn($, 'Add a --json flag to the status command', { description: 'Status json flag' })
  await $.tool.call({ tool: 'Write', file_path: '/work/app/src/status.ts', content: 'x', agentId: 'agent-1' } as never)
  await finish($, 'agent-1', 'Done.', usage('claude-sonnet-5', 1_000))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const review = await ui.find({ type: 'Button', text: 'Review with opus' })
  await ui.press({ key: review?.key ?? '' })
  const asked = w.prompts[0] ?? ''
  expect(asked).toContain('model: opus')
  const marker = /\[smart-router audit [\w-]+\]/.exec(asked)?.[0] ?? ''
  await spawn($, `Review the changes. ${marker}`, { description: 'Audit: Status json flag', model: 'opus' })
  await finish($, 'agent-2', 'Missing tests.\nAUDIT: FAIL no tests', usage(MAIN, 1_000))
  expect(w.toasts.at(-1)).toBe('Quality check of “Status json flag”: issues found')
  expect(await ui.find({ type: 'Button', text: 'Review with opus' })).toBeUndefined()
  expect(w.store.get('project:/work/app')).toEqual(expect.objectContaining({ reliability: expect.objectContaining({ 'feature|standard': expect.objectContaining({ runs: 2 }) }) }))
})

test('the effort lever (useEffort) runs a well-scoped deep task on sonnet at effort high', { options: { useEffort: true } }, async ($, on) => {
  const w = world(on)
  await start($)
  const prompt = 'Fix the race condition in src/queue/worker.ts where two workers claim the same job.'
  await $.tool.call({ tool: 'Agent', tool_use_id: 'tu-9', prompt, description: 'Fix worker race' })
  await $.tool.call({ tool: 'Agent', tool_use_id: 'tu-10', prompt: 'Design the architecture of the sync engine', description: 'Design sync' })
  expect(w.efforts).toEqual(['high', undefined])
  await spawn($, prompt, { tool_use_id: 'tu-9', description: 'Fix worker race' })
  await spawn($, 'Design the architecture of the sync engine', { tool_use_id: 'tu-10', description: 'Design sync' })
  expect(w.spawned.map(one => one.model)).toEqual(['sonnet', 'opus'])
})

test('without useEffort, effort is never set', async ($, on) => {
  const w = world(on)
  await start($)
  await $.tool.call({ tool: 'Agent', tool_use_id: 'tu-9', prompt: 'Fix the race condition in src/queue/worker.ts', description: 'Fix worker race' })
  expect(w.efforts).toEqual([undefined])
})

test('profile chips, protect-deep and max-parallel controls change routing for the session', async ($, on) => {
  const w = world(on)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'profile-max' })
  await spawn($, 'List the TODO comments')

  expect(w.spawned[0]?.model).toBe('sonnet')
  await ui.press({ key: 'profile-fast' })
  await spawn($, 'Design the architecture of the sync engine')
  expect(w.spawned[1]?.model).toBe('sonnet')
  await ui.press({ key: 'section-rules' })
  expect((await ui.find({ key: 'toggle-protect' }))?.text).toContain('Protect deep: off')
  await ui.press({ key: 'toggle-protect' })
  await spawn($, 'Design the architecture of the cache layer', { parentModel: 'claude-fable-5' })
  expect(w.spawned[2]?.model).toBeUndefined()
  await ui.press({ key: 'parallel-down' })
  expect((await ui.find({ key: 'max-parallel' }))?.text).toContain('7')
  await ui.press({ key: 'profile-balanced' })
  expect((await ui.find({ key: 'max-parallel' }))?.text).toContain('5')
  await spawn($, 'List the TODO comments')
  expect(w.spawned[3]?.model).toBe('haiku')
})

test('mobile and vscode draw the pane without Raster, Input or Select', async ($, on) => {
  world(on)
  await start($)
  await spawn($, 'Find where the session cookie is set', { subagentType: 'Explore' })
  await finish($, 'agent-1', 'found', usage('claude-haiku-4-5', 1_000))
  for (const surface of ['mobile', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Raster' })).toBeUndefined()
    expect((await ui.find({ key: 'calls-bar' }))?.text).toContain('█')
    await ui.unmount()
  }
})

const HUB_PANE = { ...PANE, requestId: 'claude-mods', props: { ...PANE.props, title: 'Claude Mods' } } as const

test('with mods-hub: the Router tab, its policy fact, and agent.routed / agent.finished / cost.update on the bus', async ($, on) => {
  const w = world(on)
  const hub = fakeHub(on, {}, w.clock)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['HUB STRIP'] }) as never)
  await start($)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['agent.routed', 'agent.finished', 'cost.update'], consumes: ['budget.threshold', 'test.result'] }])
  expect(hub.tabs).toEqual([{ id: 'router', title: 'Router', order: 20, command: 'router' }])
  expect(hub.facts.get('policy')).toEqual({
    mode: 'auto',
    profile: 'balanced',
    models: { light: 'haiku', standard: 'sonnet', deep: 'opus' },
    maxParallel: 5,
    protectDeep: true,
    budgetBias: 5,
    opusShare: 0,
  })

  await spawn($, 'Find where the session cookie is set', { subagentType: 'Explore' })
  await w.clock.advance(1_000)
  await finish($, 'agent-1', 'In src/session.ts', usage('claude-haiku-4-5', 100_000))
  const [routed, finished, cost] = hub.published
  expect(routed).toMatchObject({ topic: 'agent.routed', data: { agentType: 'Explore', tier: 'light', model: 'haiku', agentId: 'agent-1' } })
  expect(finished).toEqual({ topic: 'agent.finished', data: { agentType: 'Explore', outcome: 'ok', durationMs: 1_000, agentId: 'agent-1', usd: 0.15 } })
  expect(cost).toEqual({ topic: 'cost.update', data: { turnUsd: 0.15, sessionUsd: 0.15, model: 'claude-haiku-4-5', tokens: 110_000, isEstimate: false } })

  expect(String((await $.command.run(run('router', 'suggest'))).text)).toContain('Router: suggest')
  expect(hub.shown).toEqual(['router'])
  expect((hub.facts.get('policy') as { mode: string }).mode).toBe('suggest')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...HUB_PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'HUB STRIP' })).toBeDefined()
    // The hub's tab strip owns the digit hotkeys: the sections keep theirs only in the Router's own pane.
    expect((await ui.find({ key: 'section-live' }))?.props.hotkey).toBeUndefined()
    expect((await ui.find({ key: 'section-mix' }))).toBeDefined()
    await ui.unmount()
  }
  const own = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await own.find({ key: 'section-live' }))?.props.hotkey).toBe('1')
})

test('with mods-hub: a budget alert on the bus moves borderline work down; test-watch\'s failing run counts as a regression', async ($, on) => {
  const w = world(on)
  const hub = fakeHub(on, {}, w.clock)
  await start($)
  const at = w.clock.now()
  hub.events.push({ topic: 'budget.threshold', data: { kind: 'usd', scope: 'session', used: 8.5, limit: 10, percent: 85 }, at: at + 1, source: 'token-budget' })
  await spawn($, 'Update the config')
  expect(w.spawned[0]?.model).toBe('haiku')
  expect(hub.published[0]).toMatchObject({ topic: 'agent.routed', data: { tier: 'light', reason: expect.stringContaining('the session dollar budget is 85% used') } })

  hub.events.length = 0
  hub.events.push({ topic: 'test.result', data: { runner: 'vitest', outcome: 'passed', passed: 4, failed: 0 }, at: at + 2, source: 'test-watch' })
  hub.events.push({ topic: 'test.result', data: { runner: 'vitest', outcome: 'failed', passed: 3, failed: 1 }, at: at + 3, source: 'test-watch' })
  // The hub's own sensor mirrors Bash test runs the Router already counts: ignored.
  hub.events.push({ topic: 'test.result', data: { runner: 'vitest', outcome: 'passed', passed: 4, failed: 0 }, at: at + 4, source: 'mods-hub' })
  await spawn($, 'Fix the failing slugify test', { description: 'Fix slugify' })
  expect(w.spawned[1]?.model).toBe('opus')
  expect(hub.published[1]).toMatchObject({ topic: 'agent.routed', data: { reason: expect.stringContaining('the tests regressed') } })
})
