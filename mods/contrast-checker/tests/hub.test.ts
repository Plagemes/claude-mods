import { expect, test } from 'claude-code/testing'

import { fakeHub } from './hub'

const FILE = '/app/src/theme.css'
const THEME_CSS = `:root {
  --text: #1f2937;
  --muted: #9ca3af;
  --surface: #ffffff;
}
.card { color: var(--text); background: var(--surface); }
.card__meta { color: var(--muted); background-color: var(--surface); }
`

test('with mods-hub: says hello, publishes lint.result and sends the notice through notify instead of a toast', async ($, on) => {
  const hub = fakeHub(on)
  const toasts: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('fs.read', (_$, e) => (e.path === FILE ? { value: THEME_CSS } : { deny: 'ENOENT' }))
  on('ui.log', () => ({ value: undefined }))
  on('tool.call', () => ({ result: 'ok' }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve() // the hello waits for session.start to return (afterStart)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['lint.result'], consumes: [] }])

  const result = await $.tool.call({ tool: 'Write', file_path: FILE, content: THEME_CSS })

  expect(result.context?.[0]).toContain('contrast')
  expect(hub.published).toEqual([{ topic: 'lint.result', data: { tool: 'contrast-checker', errors: 0, warnings: 1, files: [FILE] } }])
  expect(hub.notified).toEqual([{ level: 'warning', title: expect.stringContaining('1 contrast issue in theme.css') }])
  expect(toasts).toEqual([])
})
