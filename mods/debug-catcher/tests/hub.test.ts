import { expect, test } from 'claude-code/testing'

import { fakeHub } from './hub'

test('with mods-hub: says hello and publishes lint.result for the debug statements an edit adds', async ($, on) => {
  const hub = fakeHub(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: 'ok' }))
  on('ui.status', () => ({ value: undefined }))
  on('fs.read', () => ({ deny: 'ENOENT' }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['lint.result'], consumes: [] }])

  const result = await $.tool.call({
    tool: 'Edit',
    file_path: '/repo/src/app.ts',
    old_string: 'const a = 1',
    new_string: 'const a = 1\nconsole.log("a is", a)\ndebugger',
  })

  expect(result.context?.[0]).toContain('added 2 debug statements')
  expect(hub.published).toEqual([{ topic: 'lint.result', data: { tool: 'debug-catcher', errors: 0, warnings: 2, files: ['/repo/src/app.ts'] } }])
  expect(hub.notified).toEqual([])
})

test('with mods-hub: an edit that adds nothing publishes nothing', async ($, on) => {
  const hub = fakeHub(on)
  on('tool.call', () => ({ result: 'ok' }))
  on('ui.status', () => ({ value: undefined }))
  on('fs.read', () => ({ deny: 'ENOENT' }))

  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' })

  expect(hub.published).toEqual([])
})
