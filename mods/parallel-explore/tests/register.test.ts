import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelCompleteResult, On } from 'claude-code'

import { FIXED_ANGLES, mergePrompt, parseAngles, whyNotReadOnly } from '../hooks/explore'

const USAGE = { input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const QUESTION = 'How does the session token get refreshed?'
const ANGLES = [
  { title: 'Refresh logic', focus: 'Find where tokens are refreshed and how expiry is detected.' },
  { title: 'Callers & tests', focus: 'Find who triggers a refresh and which tests cover it.' },
  { title: 'Config', focus: 'Find token lifetimes, env vars and auth settings.' },
]
const ANSWER = 'Tokens are refreshed by `refreshSession` in src/auth/session.ts:42 when a request gets a 401.'
const PANE = {
  plugin: 'parallel-explore',
  component: 'Pane',
  requestId: 'explore',
  props: { title: 'Explore', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const
const explore = (args: string) => ({ command: 'explore', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const
const complete = (agentId: string, answer: string, reason: 'answer' | 'error' = 'answer') =>
  ({ answer, durationMs: 30_000, isAborted: false, turnId: `t-${agentId}`, agentId, reason }) as const

type Spawn = { subagentType: string; prompt: string; description: string }
type Asked = { model: string; system: string; prompt: string }
type World = { spawns: Spawn[]; asked: Asked[]; prompts: string[]; copied: string[]; toasts: string[]; registered: { name: string; tools?: readonly string[] }[]; ran: string[] }

const world = (on: On, options: { exploreMissing?: boolean; plan?: () => ModelCompleteResult; merge?: () => ModelCompleteResult } = {}) => {
  const state: World = { spawns: [], asked: [], prompts: [], copied: [], toasts: [], registered: [], ran: [] }
  const clock = mock.clock(on, { now: 100_000 })
  let nextId = 0
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.list', () => ({ value: ['Read', 'Bash', 'Edit'].map(name => ({ name, description: name, isReadOnly: false })) }) as never)
  on('agent.register', ($, e) => {
    state.registered.push({ name: e.name, ...(e.tools === undefined ? {} : { tools: e.tools }) })
    return { value: { agent: `parallel-explore:${e.name}` } }
  })
  on('agent.spawn', ($, e) => {
    // The test kit hands a plugin's spawn on in the Agent tool's spelling (subagent_type).
    const subagentType = e.subagentType ?? String((e as unknown as Record<string, unknown>).subagent_type)
    state.spawns.push({ subagentType, prompt: e.prompt, description: e.description })
    if (options.exploreMissing === true && subagentType === 'Explore') return { deny: 'Agent type "Explore" not found' }
    nextId += 1
    return { model: 'claude', agentId: `agent-${nextId}` }
  })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('model.complete', ($, e) => {
    state.asked.push({ model: e.model, system: e.system ?? '', prompt: e.prompt })
    if (e.model === 'haiku') return { value: options.plan?.() ?? { isAnswered: true, text: JSON.stringify(ANGLES), usage: USAGE } }
    return { value: options.merge?.() ?? { isAnswered: true, text: ANSWER, usage: USAGE } }
  })
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', ($, e) => {
    state.ran.push(String(e.tool) === 'Bash' && 'command' in e ? String(e.command) : String(e.tool))
    return { result: 'ok' }
  })
  on('prompt.submit', ($, e) => {
    state.prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    state.copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('ui.log', () => ({ value: undefined }))
  return { state, clock }
}

const start = async ($: Engine) => {
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
}

test('plans angles from JSON, writes the merge prompt, and holds explorer shell commands to reading', () => {
  expect(parseAngles(`Sure:\n\`\`\`json\n${JSON.stringify(ANGLES)}\n\`\`\``)).toEqual(ANGLES)
  expect(parseAngles('[{"title":"only one","focus":"x"}]')).toBeUndefined()
  const prompt = mergePrompt(QUESTION, [
    { ...ANGLES[0]!, status: 'done', report: 'src/auth/session.ts:42 refreshes.' },
    { ...ANGLES[1]!, status: 'failed', error: 'no report within 10 min' },
  ])
  expect(prompt).toContain('## Explorer 1: Refresh logic')
  expect(prompt).toContain('(no report: no report within 10 min)')
  expect(prompt).toContain('Never invent a path or a line number.')

  expect(whyNotReadOnly('rg -n "refresh|renew" src | head -50')).toBeUndefined()
  expect(whyNotReadOnly('cd src && git log --oneline -5 -- auth 2>/dev/null')).toBeUndefined()
  expect(whyNotReadOnly('find . -name "*.ts" -exec rm {} +')).toBe('no find -delete/-exec')
  expect(whyNotReadOnly('cat a > b')).toBe('no output redirection')
  expect(whyNotReadOnly('npm install')).toBe('npm is not a read command')
  expect(whyNotReadOnly('git checkout main')).toBe('git checkout is not a read command')
  expect(whyNotReadOnly('sed -i s/a/b/ x.ts')).toBe('no sed -i')
})

test('/explore sends three Explore agents, shows progress, merges their reports and hands them to Claude', async ($, on) => {
  const { state, clock } = world(on)
  await start($)
  const started = await $.command.run(explore(QUESTION))
  expect(started.text).toBe('Exploring with 3 agents in parallel: Refresh logic · Callers & tests · Config. The merged findings land in the Explore pane.')
  await clock.settle()
  expect(state.asked[0]?.model).toBe('haiku')
  expect(state.spawns.map(spawn => spawn.subagentType)).toEqual(['Explore', 'Explore', 'Explore'])
  expect(state.spawns[1]?.description).toBe('Explore: Callers & tests')
  expect(state.spawns[1]?.prompt).toContain('Your angle: Callers & tests. Find who triggers a refresh')
  expect(state.spawns[1]?.prompt).toContain(`The question: ${QUESTION}`)

  const busy = await $.command.run(explore('something else'))
  expect(busy.text).toContain('An exploration is still running')

  await clock.advance(5_000)
  await $.turn.complete(complete('agent-1', 'Findings: src/auth/session.ts:42 refreshSession() renews on 401.'))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'Exploring · 1 of 3 reported · 0:05' })).toBeDefined()
    expect((await ui.find({ key: 'angles' }))?.text).toContain('✓Refresh logic0:05')
    expect(await ui.find({ key: 'send' })).toBeUndefined()
    await ui.unmount()
  }

  await $.turn.complete(complete('agent-2', 'Called from src/api/client.ts:88; tested in tests/auth.test.ts:12.'))
  await $.turn.complete(complete('agent-3', 'TOKEN_TTL in .env.example:3.'))
  await clock.settle()
  const merge = state.asked[1]
  expect(merge?.model).toBe('claude-opus-5-5')
  expect(merge?.prompt).toContain('## Explorer 2: Callers & tests')
  expect(merge?.prompt).toContain('TOKEN_TTL in .env.example:3.')
  expect(state.toasts.at(-1)).toBe('Explore: findings merged')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'Done in 0:05' })).toBeDefined()
    expect((await ui.find({ key: 'answer' }))?.text).toContain('refreshSession')
    await ui.press({ key: 'reports' })
    expect((await ui.find({ key: 'reports' }))?.text).toContain('TOKEN_TTL in .env.example:3.')
    await ui.press({ key: 'reports' })
    await ui.press({ key: 'copy' })
    await ui.unmount()
  }
  expect(state.copied[0]).toBe(ANSWER)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'send' })
  expect(state.prompts[0]).toContain(`I had three agents explore the codebase in parallel for: ${QUESTION}`)
  expect(state.prompts[0]).toContain(ANSWER)
})

test('explorers are read-only; other agents and the main loop are untouched; their notices do not wake Claude', async ($, on) => {
  const { state, clock } = world(on)
  await start($)
  await $.command.run(explore(QUESTION))
  await clock.settle()
  const asExplorer = (input: Record<string, unknown>) => $.tool.call({ ...input, agentId: 'agent-2' } as never)
  const denied = await asExplorer({ tool: 'Bash', command: 'rm -rf src' })
  expect(String(denied.deny ?? denied.text)).toContain('explorers are read-only (rm is not a read command)')
  const edit = await asExplorer({ tool: 'Edit', file_path: '/work/app/a.ts', old_string: 'a', new_string: 'b' })
  expect(String(edit.deny ?? edit.text)).toContain('explorers are read-only (Edit refused)')
  await asExplorer({ tool: 'Bash', command: 'rg -n refreshSession src' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'someone-else' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm run build' })
  expect(state.ran).toEqual(['rg -n refreshSession src', 'npm test', 'npm run build'])

  const notice = await $.prompt.submit({ text: '<task-notification><task-id>agent-1</task-id><status>completed</status></task-notification>', wait: false, origin: { kind: 'task-notification' } })
  expect(notice.drop).toContain('its findings are in the Explore pane')
  const other = await $.prompt.submit({ text: '<task-notification><task-id>bash-7</task-id></task-notification>', wait: false, origin: { kind: 'task-notification' } })
  expect(other.drop).toBeUndefined()
})

test('without the built-in Explore agent the read-only scout steps in', async ($, on) => {
  const { state, clock } = world(on, { exploreMissing: true })
  await start($)
  expect(state.registered).toEqual([{ name: 'scout', tools: ['Read', 'Bash'] }])
  await $.command.run(explore(QUESTION))
  await clock.settle()
  expect(state.spawns.filter(spawn => spawn.subagentType === 'Explore')).toHaveLength(3)
  expect(state.spawns.filter(spawn => spawn.subagentType === 'parallel-explore:scout')).toHaveLength(3)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '(scout)' })).toBeDefined()
})

test('fixed angles when planning is off; a failed explorer and the deadline still lead to an answer', { options: { planAngles: false, timeoutMinutes: 2 } }, async ($, on) => {
  const { state, clock } = world(on, { merge: () => ({ isAnswered: false, reason: 'api-error', status: 500, error: 'server_error', usage: USAGE }) })
  await start($)
  await $.command.run(explore(QUESTION))
  await clock.settle()
  expect(state.asked).toHaveLength(0)
  expect(state.spawns[2]?.description).toBe(`Explore: ${FIXED_ANGLES[2]?.title}`)

  await $.turn.complete(complete('agent-1', 'Implementation lives in src/auth/session.ts:42.'))
  await $.turn.complete(complete('agent-2', '', 'error'))
  await clock.settle()
  expect(state.asked).toHaveLength(0)
  await clock.advance(120_000)
  expect(state.toasts.at(-1)).toBe('Explore: merging failed, the reports are shown side by side')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Done in 2:00 · reports not merged' })).toBeDefined()
  const answer = (await ui.find({ key: 'answer' }))?.text ?? ''
  expect(answer).toContain('Implementation lives in src/auth/session.ts:42.')
  expect(answer).toContain('No report: it stopped (error) without a report.')
  expect(answer).toContain('No report: no report within 2 min.')
})
