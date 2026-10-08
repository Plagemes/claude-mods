import { expect, test } from 'claude-code/testing'

import { fakeHub } from './hub'

test('with mods-hub: says hello, publishes lint.result and sends the notice through notify instead of a toast', async ($, on) => {
  const hub = fakeHub(on)
  const toasts: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  const files: Record<string, string> = { '/repo/.env.example': 'PORT=3000\n' }
  on('session.root', () => ({ value: '/repo' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('fs.exists', (_$, e) => ({ value: e.path in files }))
  on('fs.read', (_$, e) => (files[e.path] === undefined ? { deny: 'ENOENT' } : { value: files[e.path] ?? '' }))
  on('fs.write', (_$, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve() // the hello waits for session.start to return (afterStart)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['lint.result'], consumes: [] }])

  const result = await $.tool.call({ tool: 'Edit', file_path: '/repo/src/stripe.ts', old_string: 'const key = ""', new_string: 'const key = process.env.STRIPE_SECRET_KEY\nconst hook = process.env["STRIPE_WEBHOOK_SECRET"]' })

  expect(result.context?.[0]).toContain('added STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET')
  expect(hub.published).toEqual([{ topic: 'lint.result', data: { tool: 'env-example-sync', errors: 0, warnings: 2, files: ['/repo/.env.example'] } }])
  expect(hub.notified).toEqual([{ level: 'info', title: '.env.example: added STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET' }])
  expect(toasts).toEqual([])
})
