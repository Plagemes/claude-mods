import { expect, test } from 'claude-code/testing'

import { fakeHub } from './hub'

const TOKENS_CSS = [':root {', '  --color-primary: #3366ff;', '  --color-text: #111827;', '  --color-surface: #f9fafb;', '  --space-4: 16px;', '}', ''].join('\n')

test('with mods-hub: says hello, publishes lint.result and sends the notice through notify instead of a toast', async ($, on) => {
  const hub = fakeHub(on)
  const toasts: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  const files: Record<string, string> = { '/app/src/styles/tokens.css': TOKENS_CSS }
  on('session.repo', () => ({ value: { root: '/app', remote: null, internal: false, name: null } }))
  on('session.cwd', () => ({ value: '/app' }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('fs.list', (_$, e) => {
    const prefix = `${e.path.replace(/\/+$/, '')}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const path of Object.keys(files).filter(path => path.startsWith(prefix))) {
      const [name, ...deeper] = path.slice(prefix.length).split('/')
      if (name !== undefined) names.set(name, deeper.length > 0 ? 'dir' : 'file')
    }
    return names.size === 0 ? { deny: 'ENOENT' } : { value: [...names].map(([name, kind]) => ({ name, kind, size: files[`${prefix}${name}`]?.length ?? 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', (_$, e) => (files[e.path] === undefined ? { deny: 'ENOENT' } : { value: files[e.path] ?? '' }))
  on('fs.stat', (_$, e) => (files[e.path] === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file' as const, size: files[e.path]?.length ?? 0, mtimeMs: 0, isLink: false } }))
  on('tool.call', () => ({ result: 'ok' }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve() // the hello waits for session.start to return (afterStart)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['lint.result'], consumes: [] }])

  const result = await $.tool.call({ tool: 'Edit', file_path: '/app/src/Button.tsx', old_string: 'x', new_string: "const style = { color: '#3366FF', background: 'rgb(17, 24, 39)' }" })

  expect(result.context?.[0]).toContain('hard-codes values')
  expect(hub.published).toEqual([{ topic: 'lint.result', data: { tool: 'css-token-guard', errors: 0, warnings: 2, files: ['/app/src/Button.tsx'] } }])
  expect(hub.notified).toEqual([{ level: 'info', title: '2 hard-coded values in Button.tsx, tokens exist' }])
  expect(toasts).toEqual([])
})
