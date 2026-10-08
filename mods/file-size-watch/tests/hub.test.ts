import { expect, test } from 'claude-code/testing'

import { fakeHub } from './hub'

const FILE = '/repo/src/big.ts'
const BIG = `${Array.from({ length: 520 }, (_, i) => `line ${i}`).join('\n')}\n`

test('with mods-hub: says hello, publishes lint.result and sends the notice through notify instead of a toast', async ($, on) => {
  const hub = fakeHub(on)
  const toasts: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: 'ok' }))
  on('fs.read', (_$, e) => (e.path === FILE ? { value: BIG } : { deny: 'ENOENT' }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve() // the hello waits for session.start to return (afterStart)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['lint.result'], consumes: [] }])

  const result = await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'line 1', new_string: 'line 1\nextra' })

  expect(result.context?.[0]).toContain('is now 520 lines')
  expect(hub.published).toEqual([{ topic: 'lint.result', data: { tool: 'file-size-watch', errors: 0, warnings: 1, files: [FILE] } }])
  expect(hub.notified).toEqual([{ level: 'info', title: 'big.ts is 520 lines. Consider splitting it.' }])
  expect(toasts).toEqual([])
})
