import { expect, test } from 'claude-code/testing'

import { fakeHub } from './hub'

const CHART_BAD = `export function Chart() {
  useEffect(() => {
    window.addEventListener('resize', onResize)
  }, [])
  return null
}
`
const CHART_OK = `export function Chart() {
  useEffect(() => {
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return null
}
`

test('with mods-hub: says hello, publishes lint.result and sends the notice through notify instead of a toast', async ($, on) => {
  const hub = fakeHub(on)
  const toasts: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  const files: Record<string, string> = { '/repo/src/Chart.tsx': CHART_OK }
  on('fs.read', (_$, e) => (files[e.path] === undefined ? { deny: 'ENOENT' } : { value: files[e.path] ?? '' }))
  on('tool.call', (_$, e) => {
    const input = e as Readonly<Record<string, string>>
    files[input.file_path ?? ''] = input.content ?? ''
    return { result: 'ok', text: 'ok' }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve() // the hello waits for session.start to return (afterStart)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['lint.result'], consumes: [] }])

  const result = await $.tool.call({ tool: 'Write', file_path: '/repo/src/Chart.tsx', content: CHART_BAD })

  expect(result.context?.[0]).toContain('may have introduced a leak')
  expect(hub.published).toEqual([{ topic: 'lint.result', data: { tool: 'leak-hint', errors: 0, warnings: 1, files: ['/repo/src/Chart.tsx'] } }])
  expect(hub.notified).toEqual([{ level: 'info', title: expect.stringContaining('possible leak in Chart.tsx:3') }])
  expect(toasts).toEqual([])
})
