import { expect, mock, test } from 'claude-code/testing'

import { fakeHub } from './hub'

const PLUGIN = 'error-feed'
const PANE = 'error-feed'
const SURFACES = ['terminal', 'desktop'] as const

const paneProps = {
  title: 'Errors',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

const NPM_FAILURE = 'Exit code 1\nnpm ERR! Missing script: "tset"\nnpm ERR! Did you mean "test"?'

test('collects failed calls, skips successes and refusals, and counts them in the status line', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  const statuses: (string | undefined)[] = []
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('tool.call', ($, e) => {
    if (e.tool === 'Bash' && e.command === 'npm run tset') return { isError: true, result: NPM_FAILURE, text: NPM_FAILURE }
    if (e.tool === 'Read') return { isError: true, result: 'File does not exist.', text: 'File does not exist.' }
    if (e.tool === 'Write') {
      const refusal = "The user doesn't want to proceed with this tool use."
      return { isError: true, result: refusal, text: refusal }
    }
    return { result: 'ok' }
  })

  await $.tool.call({ tool: 'Bash', command: 'npm run tset' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Write', file_path: 'a.txt', content: 'x' })
  await $.tool.call({ tool: 'Read', file_path: 'missing.md' })

  expect(statuses.at(-1)).toBe('⚠ 2 errors · /errors')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: paneProps })
    const text = (await ui.find({ type: 'Box' }))?.text
    expect(text).toContain('npm run tset')
    expect(text).toContain('exit 1')
    expect(text).toContain('Missing script')
    expect(text).toContain('missing.md')
    expect(text).not.toContain('a.txt')
    const fixButtons = (await ui.findAll({ type: 'Button' })).filter(button => button.key?.startsWith('fix:'))
    expect(fixButtons).toHaveLength(2)
    await ui.unmount()
  }
})

test('"Ask Claude to fix" submits the failure as a prompt, and Clear all empties the feed', async ($, on) => {
  mock.clock(on)
  const submitted: string[] = []
  const statuses: (string | undefined)[] = []
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('tool.call', () => ({ isError: true, result: NPM_FAILURE, text: NPM_FAILURE }))

  const call = await $.tool.call({ tool: 'Bash', command: 'npm run tset', tool_use_id: 'toolu_fail' } as never)
  expect(call.isError).toBe(true)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: paneProps })
    const fix = (await ui.findAll({ type: 'Button' })).find(button => button.key?.startsWith('fix:'))
    expect(fix?.text).toMatch(/Ask Claude to fix|Ask again/)
    await ui.press({ key: fix?.key ?? '' })
    expect((await ui.find({ type: 'Button', key: fix?.key ?? '' }))?.text).toBe('Ask again')
    await ui.unmount()
  }

  expect(submitted).toHaveLength(2)
  expect(submitted[0]).toContain('Call: npm run tset')
  expect(submitted[0]).toContain('Exit code: 1')
  expect(submitted[0]).toContain('Missing script')

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: paneProps })
  await ui.press({ key: 'clear' })
  expect(await ui.find({ type: 'Text', text: /No failed commands/ })).toBeDefined()
  expect(statuses.at(-1)).toBeUndefined()
})

test('with mods-hub: failures are published as tool.failed, repeats are flagged, and /errors opens the Errors tab', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  const hub = fakeHub(on)
  const opened: string[] = []
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('state.get', { plugin: 'mods-hub', key: 'latest', id: 'error.repeated' }, () => ({
    value: { value: { id: 'e1', topic: 'error.repeated', source: 'mods-hub', at: 1, session: 's1', scope: 'session', data: { signature: 'npm run', count: 3, tool: 'Bash', command: 'npm run tset' } }, version: 1 },
  }))
  on('tool.call', ($, e) => (e.tool === 'Bash' ? { isError: true, result: NPM_FAILURE, text: NPM_FAILURE } : { result: 'ok' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['HUB STRIP'] }) as never)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['tool.failed'], consumes: ['error.repeated'] }])
  expect(hub.tabs).toEqual([{ id: 'errors', title: 'Errors', order: 210, command: 'errors' }])

  await $.tool.call({ tool: 'Bash', command: 'npm run tset' })
  expect(hub.published).toEqual([{ topic: 'tool.failed', data: { tool: 'Bash', summary: 'npm ERR! Missing script: "tset"', command: 'npm run tset' } }])

  const ran = await $.command.run({ command: 'errors', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(ran.text).toBe('1 error collected: the Errors tab of the Claude Mods panel.')
  expect(hub.shown).toEqual(['errors'])
  expect(opened).toEqual([])

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'claude-mods', props: { ...paneProps, title: 'Claude Mods' } })
    expect(await ui.find({ type: 'Text', text: 'HUB STRIP' })).toBeDefined()
    const text = (await ui.find({ type: 'Box' }))?.text
    expect(text).toContain('npm run tset')
    expect(text).toContain('↻ 3× in a row')
    expect(await ui.find({ key: 'close' })).toBeUndefined()
    expect(await ui.find({ key: 'clear' })).toBeDefined()
    await ui.unmount()
  }
})
