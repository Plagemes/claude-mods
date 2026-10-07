import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, On } from 'claude-code'

type Agents = AgentInfo[]

const agent = (id: string, status: AgentInfo['status']): AgentInfo => ({ id, status, type: 'general-purpose', description: id })

/** The engine beneath the plugin: a mutable list of agents, the status line and toasts recorded, and an Agent tool that always runs. */
const world = (on: On, agents: Agents = []) => {
  const clock = mock.clock(on)
  const seen = { statuses: [] as (string | undefined)[], toasts: [] as string[], reached: 0, agents, advance: clock.advance }
  on('agent.list', () => ({ value: [...seen.agents] }))
  on('ui.status', (_$, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', () => {
    seen.reached += 1
    return { result: 'started' }
  })
  on('turn.complete', () => ({ text: '' }))
  return seen
}

const spawn = ($: Engine, description = 'look around') => $.tool.call({ tool: 'Agent', description, prompt: 'Read the code.' })

test('lets a subagent start while fewer than the maximum are running', async ($, on) => {
  const seen = world(on, [agent('a1', 'running'), agent('a2', 'running')])

  const result = await spawn($)

  expect(result.deny).toBeUndefined()
  expect(seen.reached).toBe(1)
})

test('refuses the next one at the maximum, tells Claude why and toasts the user', async ($, on) => {
  const seen = world(on, [agent('a1', 'running'), agent('a2', 'waiting'), agent('a3', 'pending')])

  const result = await spawn($)

  expect(result.deny).toContain('subagent-cap: 3 of 3 subagents are already running')
  expect(result.deny).toContain('Wait for one to finish')
  expect(seen.reached).toBe(0)
  expect(seen.toasts).toEqual(['held back a subagent: 3/3 already running'])
})

test('finished and idle agents do not take a slot', async ($, on) => {
  const seen = world(on, [
    agent('a1', 'completed'),
    agent('a2', 'failed'),
    agent('a3', 'killed'),
    agent('a4', 'idle'),
    agent('a5', 'running'),
  ])

  const result = await spawn($)

  expect(result.deny).toBeUndefined()
  expect(seen.reached).toBe(1)
})

test('the maximum is configurable', { options: { max: 1 } }, async ($, on) => {
  const seen = world(on, [agent('a1', 'running')])

  expect((await spawn($)).deny).toContain('1 of 1 subagents')
  seen.agents.length = 0
  expect((await spawn($)).deny).toBeUndefined()
})

test('other tools are not touched', async ($, on) => {
  const seen = world(on, [agent('a1', 'running'), agent('a2', 'running'), agent('a3', 'running')])

  const result = await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(result.deny).toBeUndefined()
  expect(seen.reached).toBe(1)
})

test('parallel Agent calls in one message cannot share a slot', { options: { max: 2 } }, async ($, on) => {
  const seen = world(on)

  const results = await Promise.all([spawn($, 'one'), spawn($, 'two'), spawn($, 'three')])

  expect(results.filter(result => result.deny === undefined)).toHaveLength(2)
  expect(results.filter(result => result.deny !== undefined)).toHaveLength(1)
  expect(seen.reached).toBe(2)
})

test('shows agents n/max in the status line and clears it when the last one ends', async ($, on) => {
  const seen = world(on)
  await spawn($)
  expect(seen.statuses.at(-1)).toBeUndefined()

  seen.agents.push(agent('a1', 'running'), agent('a2', 'running'))
  await spawn($)
  expect(seen.statuses.at(-1)).toBe('agents 2/3')

  // An agent's own turn.complete ends it, even while the engine still lists it.
  await $.turn.complete({ reason: 'answer', agentId: 'a1' } as never)
  expect(seen.statuses.at(-1)).toBe('agents 1/3')
})

test('notices agents that end without a turn.complete, by polling while any run', async ($, on) => {
  const seen = world(on, [agent('a1', 'running')])
  await spawn($)
  expect(seen.statuses.at(-1)).toBe('agents 1/3')

  seen.agents[0] = agent('a1', 'killed')
  await seen.advance(3000)

  expect(seen.statuses.at(-1)).toBeUndefined()
})
