import { expect, test } from 'claude-code/testing'

import { fakeHub } from './hub'

const MIT_LICENSE = ['MIT License', '', 'Copyright (c) 2026 Plagemes', '', 'Permission is hereby granted, free of charge, to any person obtaining a copy'].join('\n')
const FACEBOOK_HEADER = '// Copyright (c) 2015-present, Facebook, Inc.\n// All rights reserved.\n'

test('with mods-hub: says hello, publishes lint.result and sends the notice through notify instead of a toast', async ($, on) => {
  const hub = fakeHub(on)
  const toasts: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('session.root', () => ({ value: '/repo' }))
  on('fs.read', (_$, e) => (e.path === '/repo/LICENSE' ? { value: MIT_LICENSE } : { deny: 'ENOENT' }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve() // the hello waits for session.start to return (afterStart)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['lint.result'], consumes: [] }])

  const result = await $.tool.call({ tool: 'Write', file_path: '/repo/src/vendor-ish.ts', content: `${FACEBOOK_HEADER}export const x = 1\n` })

  expect(result.context?.[0]).toContain('Copyright (c) 2015-present, Facebook, Inc.')
  expect(hub.published).toEqual([{ topic: 'lint.result', data: { tool: 'copyright-guard', errors: 0, warnings: 1, files: ['/repo/src/vendor-ish.ts'] } }])
  expect(hub.notified).toEqual([{ level: 'warning', title: 'other license in vendor-ish.ts: // Copyright (c) 2015-present, Facebook, Inc.' }])
  expect(toasts).toEqual([])
})
