import { expect, test } from 'claude-code/testing'

import { fakeHub } from './hub'

const FILE = '/repo/Dockerfile'
const SMELLY = ['FROM node:latest', 'ENV DB_PASSWORD=hunter2', 'RUN apt-get update', 'ADD ./src /app/src', 'CMD ["node", "server.js"]'].join('\n')
const ISSUES = 5

test('with mods-hub: says hello, publishes lint.result and sends the notice through notify instead of a toast', async ($, on) => {
  const hub = fakeHub(on)
  const toasts: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: 'ok' }))
  on('fs.read', (_$, e) => (e.path === FILE ? { value: SMELLY } : { deny: 'ENOENT' }))
  on('process.run', () => ({ deny: 'failed to start: ENOENT' }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve() // the hello waits for session.start to return (afterStart)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['lint.result'], consumes: [] }])

  const result = await $.tool.call({ tool: 'Write', file_path: FILE, content: SMELLY })

  expect(result.context?.[0]).toContain('issues in /repo/Dockerfile')
  expect(hub.published).toEqual([{ topic: 'lint.result', data: { tool: 'docker-lint', errors: 0, warnings: ISSUES, files: [FILE] } }])
  expect(hub.notified).toEqual([{ level: 'warning', title: `${ISSUES} Dockerfile issues in Dockerfile` }])
  expect(toasts).toEqual([])
})
