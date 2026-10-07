import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

// Stands for the engine: some files already exist, and every Write is recorded as the engine would receive it.
const engine = (on: On, existing: string[] = []) => {
  const written: { file_path: string; content: string }[] = []
  const toasts: string[] = []
  mock.clock(on, { now: Date.UTC(2026, 9, 7) })
  on('fs.exists', (_$, e) => ({ value: existing.includes(e.path) }))
  on('tool.call', (_$, e) => {
    if (e.tool === 'Write') written.push({ file_path: e.file_path, content: e.content })
    return { result: { type: 'create' }, text: 'File created successfully' }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { written, toasts }
}

test('adds the SPDX line to a new TypeScript file', async ($, on) => {
  const { written, toasts } = engine(on)

  await $.tool.call({ tool: 'Write', file_path: '/repo/src/add.ts', content: 'export const add = (a: number, b: number) => a + b\n' })

  expect(written[0]?.content).toBe('// SPDX-License-Identifier: MIT\n\nexport const add = (a: number, b: number) => a + b\n')
  expect(toasts).toEqual(['License header added to add.ts'])
})

test('uses the configured license, holder and year', { options: { license: 'Apache-2.0', holder: 'Acme Inc.', year: '2024', header: '' } }, async ($, on) => {
  const { written } = engine(on)

  await $.tool.call({ tool: 'Write', file_path: '/repo/main.go', content: 'package main\n' })

  expect(written[0]?.content).toBe('// Copyright (c) 2024 Acme Inc.\n// SPDX-License-Identifier: Apache-2.0\n\npackage main\n')
})

test('the year defaults to the current one', { options: { license: 'MIT', holder: 'Plagemes', year: '', header: '' } }, async ($, on) => {
  const { written } = engine(on)

  await $.tool.call({ tool: 'Write', file_path: '/repo/lib.rs', content: 'fn main() {}\n' })

  expect(written[0]?.content).toContain('// Copyright (c) 2026 Plagemes\n// SPDX-License-Identifier: MIT')
})

test('uses each language\'s comment syntax and keeps a shebang or opening tag first', async ($, on) => {
  const { written } = engine(on)

  await $.tool.call({ tool: 'Write', file_path: '/repo/run.py', content: '#!/usr/bin/env python3\nprint("hi")\n' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/style.css', content: 'body { margin: 0 }\n' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/index.html', content: '<h1>Hi</h1>\n' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/page.php', content: '<?php\necho 1;\n' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/query.sql', content: 'select 1;\n' })

  expect(written.map(w => w.content)).toEqual([
    '#!/usr/bin/env python3\n# SPDX-License-Identifier: MIT\n\nprint("hi")\n',
    '/*\n * SPDX-License-Identifier: MIT\n */\n\nbody { margin: 0 }\n',
    '<!--\n  SPDX-License-Identifier: MIT\n-->\n\n<h1>Hi</h1>\n',
    '<?php\n// SPDX-License-Identifier: MIT\n\necho 1;\n',
    '-- SPDX-License-Identifier: MIT\n\nselect 1;\n',
  ])
})

test('leaves existing files, other file types, empty files and files that already have a notice alone', async ($, on) => {
  const { written, toasts } = engine(on, ['/repo/old.ts'])

  await $.tool.call({ tool: 'Write', file_path: '/repo/old.ts', content: 'export {}\n' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/data.json', content: '{}\n' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/README.md', content: '# Hi\n' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/__init__.py', content: '' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/node_modules/x/index.js', content: 'module.exports = 1\n' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/owned.ts', content: '// Copyright (c) 2020 Someone\nexport {}\n' })

  expect(written.map(w => w.content)).toEqual(['export {}\n', '{}\n', '# Hi\n', '', 'module.exports = 1\n', '// Copyright (c) 2020 Someone\nexport {}\n'])
  expect(toasts).toHaveLength(0)
})

test('a custom header replaces the generated one', { options: { license: 'GPL-3.0-only', holder: 'Acme', year: '2025', header: 'Part of Acme.\\n(c) {year} {holder}, {license}' } }, async ($, on) => {
  const { written } = engine(on)

  await $.tool.call({ tool: 'Write', file_path: '/repo/app.js', content: 'run()\n' })

  expect(written[0]?.content).toBe('// Part of Acme.\n// (c) 2025 Acme, GPL-3.0-only\n\nrun()\n')
})

test('does nothing when it cannot tell whether the file exists', async ($, on) => {
  const written: string[] = []
  mock.clock(on)
  on('fs.exists', () => ({ deny: 'no file system here' }))
  on('tool.call', (_$, e) => {
    if (e.tool === 'Write') written.push(e.content)
    return { result: { type: 'create' }, text: 'ok' }
  })

  await $.tool.call({ tool: 'Write', file_path: '/repo/a.ts', content: 'export {}\n' })

  expect(written).toEqual(['export {}\n'])
})

test('a PHP template, whose text outside <?php is output, gets no header', async ($, on) => {
  const { written } = engine(on)
  const templates = [
    ['/repo/resources/views/welcome.blade.php', '<!DOCTYPE html>\n<html>{{ $title }}</html>\n'],
    ['/repo/page.php', '<?php include "head.php"; ?>\n<h1>Hi</h1>\n'],
  ] as const
  for (const [file_path, content] of templates) await $.tool.call({ tool: 'Write', file_path, content })
  expect(written.map(w => w.content)).toEqual(templates.map(([, content]) => content))
})
