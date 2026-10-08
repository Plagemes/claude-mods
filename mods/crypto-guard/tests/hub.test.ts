import { expect, test } from 'claude-code/testing'

import { fakeHub } from './hub'

test('with mods-hub: says hello, publishes lint.result and sends the notice through notify instead of a toast', async ($, on) => {
  const hub = fakeHub(on)
  const toasts: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: 'ok' }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve() // the hello waits for session.start to return (afterStart)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['lint.result'], consumes: [] }])

  const result = await $.tool.call({ tool: 'Edit', file_path: '/repo/src/auth.ts', old_string: 'x', new_string: "const hash = crypto.createHash('md5').update(password).digest('hex')" })

  expect(result.context?.[0]).toContain('weak cryptography')
  expect(hub.published).toEqual([{ topic: 'lint.result', data: { tool: 'crypto-guard', errors: 0, warnings: 1, files: ['/repo/src/auth.ts'] } }])
  expect(hub.notified).toEqual([{ level: 'warning', title: 'weak cryptography in auth.ts: MD5 or SHA-1' }])
  expect(toasts).toEqual([])
})

test('with mods-hub in block mode: the refusal is also published, as an error', { options: { mode: 'block' } }, async ($, on) => {
  const hub = fakeHub(on)
  on('tool.call', () => ({ result: 'ok' }))
  on('fs.read', () => ({ deny: 'ENOENT' }))

  const result = await $.tool.call({ tool: 'Edit', file_path: '/repo/src/auth.ts', old_string: 'x', new_string: "crypto.createHash('md5').update(password)" })

  expect(result.deny).toContain('crypto-guard: blocked')
  expect(hub.published).toEqual([{ topic: 'lint.result', data: { tool: 'crypto-guard', errors: 1, warnings: 0, files: ['/repo/src/auth.ts'] } }])
  expect(hub.notified).toEqual([])
})
