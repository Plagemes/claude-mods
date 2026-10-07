import type { On } from 'claude-code'
import { test, expect } from 'claude-code/testing'

import { addFutureAnnotations, addStrictTypes } from '../hooks/transform'

/** Stands in for the engine: which files exist, what content the Write tool receives, and the toasts. */
function engine(on: On, existing: string[] = []) {
  const seen = { written: [] as string[], toasts: [] as string[] }
  on('tool.call', (_$, e) => {
    if (e.tool === 'Write') seen.written.push(e.content)
    return { result: 'ok' }
  })
  on('fs.exists', (_$, e) => ({ value: existing.includes(e.path) }))
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  return seen
}

test('adds declare(strict_types=1) to a new PHP file, and says so', async ($, on) => {
  const seen = engine(on)
  const result = await $.tool.call({
    tool: 'Write',
    file_path: '/repo/src/User.php',
    content: '<?php\n\nnamespace App;\n\nfinal class User {}\n',
  })
  expect(seen.written).toEqual(['<?php\n\ndeclare(strict_types=1);\n\nnamespace App;\n\nfinal class User {}\n'])
  expect(seen.toasts).toEqual(['added declare(strict_types=1); to User.php'])
  expect(result.context?.[0]).toContain('declare(strict_types=1); was added to the new file /repo/src/User.php')
})

test('adds from __future__ import annotations to a new Python file', async ($, on) => {
  const seen = engine(on)
  await $.tool.call({ tool: 'Write', file_path: '/repo/app/models.py', content: 'import os\n\n\ndef f(x: "Foo") -> "Foo":\n    return x\n' })
  expect(seen.written).toEqual(['from __future__ import annotations\n\nimport os\n\n\ndef f(x: "Foo") -> "Foo":\n    return x\n'])
  expect(seen.toasts).toEqual(['added from __future__ import annotations to models.py'])
})

test('leaves existing files, other languages, templates and empty files alone', async ($, on) => {
  const seen = engine(on, ['/repo/src/Old.php'])
  const write = (file_path: string, content: string) => $.tool.call({ tool: 'Write', file_path, content })
  await write('/repo/src/Old.php', '<?php\n\nclass Old {}\n')
  await write('/repo/src/notes.ts', 'export const a = 1\n')
  await write('/repo/views/home.blade.php', '<?php\n$x = 1;\n')
  await write('/repo/views/page.php', '<html><?php echo 1; ?></html>\n')
  await write('/repo/app/__init__.py', '')
  expect(seen.written).toEqual([
    '<?php\n\nclass Old {}\n',
    'export const a = 1\n',
    '<?php\n$x = 1;\n',
    '<html><?php echo 1; ?></html>\n',
    '',
  ])
  expect(seen.toasts).toEqual([])
})

test('php and python can each be switched off', { options: { php: false, python: true } }, async ($, on) => {
  const seen = engine(on)
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/A.php', content: '<?php\nclass A {}\n' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/a.py', content: 'x = 1\n' })
  expect(seen.written).toEqual(['<?php\nclass A {}\n', 'from __future__ import annotations\n\nx = 1\n'])
})

test('PHP: keeps a shebang first, skips files that already declare, handles CRLF and a bare tag', () => {
  expect(addStrictTypes('#!/usr/bin/env php\n<?php\necho 1;\n')).toBe('#!/usr/bin/env php\n<?php\n\ndeclare(strict_types=1);\n\necho 1;\n')
  expect(addStrictTypes('<?php\ndeclare(strict_types=1);\n')).toBeUndefined()
  expect(addStrictTypes('<?php\n\nDECLARE( strict_types = 1 );\n')).toBeUndefined()
  expect(addStrictTypes('<?php\r\n\r\nclass A {}\r\n')).toBe('<?php\r\n\r\ndeclare(strict_types=1);\r\n\r\nclass A {}\r\n')
  expect(addStrictTypes('<?php')).toBe('<?php\n\ndeclare(strict_types=1);\n')
  expect(addStrictTypes('<?php echo 1;')).toBeUndefined()
  expect(addStrictTypes('<?= $x ?>')).toBeUndefined()
  expect(addStrictTypes('<?php\n/** Doc */\nclass A {}\n')).toBe('<?php\n\ndeclare(strict_types=1);\n\n/** Doc */\nclass A {}\n')
})

test('Python: goes after the shebang, encoding line, comments, docstring and other __future__ imports', () => {
  const insert = addFutureAnnotations
  expect(insert('#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\n"""Tool."""\n\nimport sys\n')).toBe(
    '#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\n"""Tool."""\n\nfrom __future__ import annotations\n\nimport sys\n',
  )
  expect(insert('# Copyright 2026\n\n"""Doc\nover two lines."""\nimport os\n')).toBe(
    '# Copyright 2026\n\n"""Doc\nover two lines."""\n\nfrom __future__ import annotations\n\nimport os\n',
  )
  expect(insert('"doc"\nx = 1\n')).toBe('"doc"\n\nfrom __future__ import annotations\n\nx = 1\n')
  expect(insert('"""Doc."""\nfrom __future__ import division\nimport os\n')).toBe(
    '"""Doc."""\nfrom __future__ import division\nfrom __future__ import annotations\n\nimport os\n',
  )
  expect(insert('from __future__ import (\n    division,\n)\nimport os\n')).toBe(
    'from __future__ import (\n    division,\n)\nfrom __future__ import annotations\n\nimport os\n',
  )
  expect(insert('"""Only a docstring."""\n')).toBe('"""Only a docstring."""\n\nfrom __future__ import annotations\n')
  expect(insert('x = 1\r\n')).toBe('from __future__ import annotations\r\n\r\nx = 1\r\n')
})

test('Python: no change when it is there already or the file is empty', () => {
  expect(addFutureAnnotations('from __future__ import annotations\n\nx = 1\n')).toBeUndefined()
  expect(addFutureAnnotations('from __future__ import division, annotations\n')).toBeUndefined()
  expect(addFutureAnnotations('')).toBeUndefined()
  expect(addFutureAnnotations('\n\n')).toBeUndefined()
})
