import { expect, test } from 'claude-code/testing'

import { fakeHub } from './hub'

test('with mods-hub: says hello, publishes lint.result and sends the notice through notify instead of a toast', async ($, on) => {
  const hub = fakeHub(on)
  const toasts: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve() // the hello waits for session.start to return (afterStart)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['lint.result'], consumes: [] }])

  const result = await $.tool.call({ tool: 'Edit', file_path: '/repo/src/Button.tsx', old_string: '  return <button onClick={save}>{t("save")}</button>', new_string: '  return <button title="Save the form" onClick={save}>Save changes</button>' })

  expect(result.context?.[0]).toContain('title="Save the form"')
  expect(hub.published).toEqual([{ topic: 'lint.result', data: { tool: 'i18n-guard', errors: 0, warnings: 2, files: ['/repo/src/Button.tsx'] } }])
  expect(hub.notified).toEqual([{ level: 'warning', title: '2 hard-coded strings in Button.tsx' }])
  expect(toasts).toEqual([])
})

test('with mods-hub in block mode: the refusal is also published, as errors', { options: { mode: 'block' } }, async ($, on) => {
  const hub = fakeHub(on)
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('fs.read', () => ({ deny: 'ENOENT' }))

  const result = await $.tool.call({
    tool: 'Write',
    file_path: '/repo/src/Search.tsx',
    content: 'export const Search = () => <input placeholder="Search products" aria-label={t("search")} />\n',
  })

  expect(result.deny).toContain('i18n-guard')
  expect(hub.published).toEqual([{ topic: 'lint.result', data: { tool: 'i18n-guard', errors: 1, warnings: 0, files: ['/repo/src/Search.tsx'] } }])
})
