import { expect, test } from 'claude-code/testing'

import { fakeHub } from './hub'

test('with mods-hub: says hello, publishes lint.result and sends the notice through notify instead of a toast', async ($, on) => {
  const hub = fakeHub(on)
  const toasts: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  const files: Record<string, string> = { '/app/tailwind.config.ts': "export default { darkMode: 'class', content: ['./src/**/*.tsx'] }" }
  on('session.repo', () => ({ value: { root: '/app', remote: null, internal: false, name: null } }))
  on('session.cwd', () => ({ value: '/app' }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('fs.list', (_$, e) => {
    const prefix = `${e.path.replace(/\/+$/, '')}/`
    const names = Object.keys(files).filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
    return names.length === 0 ? { deny: 'ENOENT' } : { value: names.map(path => ({ name: path.slice(prefix.length), kind: 'file' as const, size: files[path]?.length ?? 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', (_$, e) => (files[e.path] === undefined ? { deny: 'ENOENT' } : { value: files[e.path] ?? '' }))
  on('fs.stat', (_$, e) => (files[e.path] === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file' as const, size: files[e.path]?.length ?? 0, mtimeMs: 0, isLink: false } }))
  on('tool.call', () => ({ result: 'ok' }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['lint.result'], consumes: [] }])

  const result = await $.tool.call({ tool: 'Write', file_path: '/app/src/Card.tsx', content: 'export const Card = () => (\n  <div className="bg-white text-gray-900 border border-gray-200 p-4 text-sm">\n    hi\n  </div>\n)\n' })

  expect(result.context?.[0]).toContain('no dark variant')
  expect(hub.published).toEqual([{ topic: 'lint.result', data: { tool: 'dark-mode-check', errors: 0, warnings: 3, files: ['/app/src/Card.tsx'] } }])
  expect(hub.notified).toEqual([{ level: 'info', title: '3 colors without a dark variant in Card.tsx' }])
  expect(toasts).toEqual([])
})
