import { expect, mock, test } from 'claude-code/testing'

import { fakeHub } from './hub'

const PLUGIN = 'subagent-monitor'
const PANE = 'subagent-monitor'
const SURFACES = ['terminal', 'desktop'] as const

const paneProps = {
  title: 'Subagents',
  isFocused: false,
  bodyColumns: 72,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

test('lists a spawned subagent with its type, task, activity and outcome', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const statuses: unknown[] = []
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1' }))
  on('agent.list', () => ({ value: [] }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', ($, e) => {
    statuses.push(e)
    return { value: undefined }
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', () => ({ text: '' }))

  await $.agent.spawn({
    tool_use_id: 'toolu_1',
    prompt: 'Find the auth code',
    description: 'Find auth handlers',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'opus',
    background: true,
    fork: false,
  })
  expect(JSON.stringify(statuses)).toContain('1 subagent running')

  await $.tool.call({ tool: 'Grep', pattern: 'authenticate', agentId: 'agent-1' } as never)
  await $.turn.complete({
    answer: 'Found them.',
    durationMs: 4000,
    isAborted: false,
    turnId: 'turn-1',
    agentId: 'agent-1',
    reason: 'answer',
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'haiku' },
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: paneProps })
    const agent = await ui.find({ type: 'Box', key: 'agent:agent-1' })
    expect(agent?.text).toContain('Explore')
    expect(agent?.text).toContain('Find auth handlers')
    expect(agent?.text).toContain('Grep authenticate')
    expect(agent?.text).toContain('completed')
    expect(agent?.text).toContain('1.2k tok')
    expect(await ui.find({ type: 'Button', key: 'clear' })).toBeDefined()
    await ui.unmount()
  }
})

test('polls the agent list every two seconds while the pane is open', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000_000 })
  let status: 'running' | 'failed' = 'running'
  let isOpen = false
  on('command.register', () => ({ value: { command: 'agents-live' } }))
  on('ui.open', () => {
    isOpen = true
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({
    value: isOpen ? [{ id: PANE, title: 'Subagents', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
  on('ui.status', () => ({ value: undefined }))
  on('agent.list', () => ({
    value: [{ id: 'agent-9', description: 'Run the test suite', type: 'general-purpose', status }],
  }))

  const ran = await $.command.run({
    command: 'agents-live',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  expect(ran.text).toContain('Watching')
  await clock.settle()

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: paneProps })
  expect((await ui.find({ type: 'Box', key: 'agent:agent-9' }))?.text).toContain('running')

  status = 'failed'
  await clock.advance(2000)
  const row = await ui.find({ type: 'Box', key: 'agent:agent-9' })
  expect(row?.text).toContain('failed')
  expect(row?.text).toContain('2s')
  await ui.unmount()
})

test('shows an empty state before any subagent runs', async ($, on) => {
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: paneProps })
    expect(await ui.find({ type: 'Text', text: /No subagents yet/ })).toBeDefined()
    await ui.unmount()
  }
})

test('with mods-hub: shows the tier smart-router routed an agent to, and publishes agent.finished for the agents it did not route', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const hub = fakeHub(on, {}, clock)
  let next = 0
  on('agent.spawn', () => ({ model: 'haiku', agentId: `agent-${(next += 1)}` }))
  on('agent.list', () => ({ value: [] }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['agent.finished'], consumes: ['agent.routed'] }])

  const spawn = (description: string) =>
    $.agent.spawn({ tool_use_id: 'toolu', prompt: description, description, subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'opus', background: true, fork: false })
  const finish = (agentId: string) =>
    $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't', agentId, reason: 'answer', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'haiku' } })

  await spawn('Find auth handlers')
  await spawn('Plan the refactor')
  hub.events.push({ topic: 'agent.routed', source: 'smart-router', at: clock.now(), data: { agentType: 'Explore', tier: 'deep', model: 'opus', reason: 'architecture', agentId: 'agent-2' } })
  await clock.advance(3_000)
  await finish('agent-1')
  await finish('agent-2')
  await clock.advance(0)

  expect(hub.published).toEqual([{ topic: 'agent.finished', data: { agentType: 'Explore', outcome: 'ok', durationMs: 3_000, agentId: 'agent-1' } }])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: paneProps })
    expect((await ui.find({ type: 'Box', key: 'agent:agent-2' }))?.text).toContain('deep · 0 tools')
    expect((await ui.find({ type: 'Box', key: 'agent:agent-1' }))?.text).not.toContain('deep')
    await ui.unmount()
  }
})
