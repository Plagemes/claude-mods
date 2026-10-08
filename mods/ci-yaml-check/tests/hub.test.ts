import { expect, test } from 'claude-code/testing'

import { fakeHub } from './hub'

const FILE = '/repo/.github/workflows/ci.yml'
const SLOPPY = [
  'name: CI',
  'on: [push, pull_request]',
  'jobs:',
  '  build:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout',
  '      - uses: actions/setup-node@main',
  '      - run: echo "token ${{ secrets.NPM_TOKEN }}"',
].join('\n')

test('with mods-hub: says hello, publishes lint.result and sends the notice through notify instead of a toast', async ($, on) => {
  const hub = fakeHub(on)
  const toasts: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: 'ok' }))
  on('fs.read', (_$, e) => (e.path === FILE ? { value: SLOPPY } : { deny: 'ENOENT' }))
  on('process.run', () => ({ deny: 'failed to start: ENOENT' }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve() // the hello waits for session.start to return (afterStart)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['lint.result'], consumes: [] }])

  const result = await $.tool.call({ tool: 'Write', file_path: FILE, content: SLOPPY })

  expect(result.context?.[0]).toContain('4 issues in /repo/.github/workflows/ci.yml')
  expect(hub.published).toEqual([{ topic: 'lint.result', data: { tool: 'ci-yaml-check', errors: 1, warnings: 3, files: [FILE] } }])
  expect(hub.notified).toEqual([{ level: 'warning', title: '4 workflow issues in ci.yml' }])
  expect(toasts).toEqual([])
})
