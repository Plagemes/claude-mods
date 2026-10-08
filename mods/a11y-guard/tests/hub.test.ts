import { expect, test } from 'claude-code/testing'

import { fakeHub } from './hub'

const GALLERY = ['export function Gallery({ photos }) {', '  return <img src={photos[0]} />', '}', ''].join('\n')

test('with mods-hub: says hello, publishes lint.result and sends the warning through notify instead of a toast', async ($, on) => {
  const hub = fakeHub(on)
  const toasts: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/app', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve() // the hello waits for session.start to return (afterStart)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['lint.result'], consumes: [] }])

  const result = await $.tool.call({ tool: 'Write', file_path: '/app/src/Gallery.tsx', content: GALLERY })

  expect(result.context?.[0]).toContain('adds 1 accessibility issue')
  expect(hub.published).toEqual([{ topic: 'lint.result', data: { tool: 'a11y-guard', errors: 0, warnings: 1, files: ['/app/src/Gallery.tsx'] } }])
  expect(hub.notified).toEqual([{ level: 'warning', title: '1 accessibility issue in Gallery.tsx' }])
  expect(toasts).toEqual([])
})

test('with mods-hub in block mode: the refusal is also published as errors', { options: { mode: 'block' } }, async ($, on) => {
  const hub = fakeHub(on)
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('tool.call', () => ({ result: 'ok' }))

  const result = await $.tool.call({ tool: 'Write', file_path: '/app/src/Gallery.tsx', content: GALLERY })

  expect(result.deny).toContain('a11y-guard: blocked')
  expect(hub.published).toEqual([{ topic: 'lint.result', data: { tool: 'a11y-guard', errors: 1, warnings: 0, files: ['/app/src/Gallery.tsx'] } }])
  expect(hub.notified).toEqual([])
})
