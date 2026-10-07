import { test, expect } from 'claude-code/testing'
import type { On } from 'claude-code'

const FORMATTED = ' // formatted\n'

type Run = { argv: readonly string[]; cwd: string | undefined }

/**
 * A tiny project on a virtual disk: `files` maps absolute paths to their
 * text, folders are implied. `formatter` decides what a run does to the disk.
 */
const world = (
  on: On,
  files: Record<string, string>,
  formatter: (argv: readonly string[]) => 'missing' | number = () => 0,
  isToolError = false,
) => {
  const disk = new Map(Object.entries(files))
  const runs: Run[] = []
  const statuses: string[] = []
  const toasts: string[] = []

  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.list', ($, e) => {
    const prefix = e.path.endsWith('/') ? e.path : `${e.path}/`
    const names = new Set<string>()
    for (const path of disk.keys()) {
      if (path.startsWith(prefix)) names.add(path.slice(prefix.length).split('/')[0] ?? '')
    }
    return { value: [...names].map(name => ({ name, kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.exists', ($, e) => ({ value: disk.has(e.path) }))
  on('fs.read', ($, e) => {
    const text = disk.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('process.run', ($, e) => {
    runs.push({ argv: e.argv, cwd: e.init?.cwd })
    const outcome = formatter(e.argv)
    if (outcome === 'missing') return { deny: `failed to start: ENOENT: Executable not found in $PATH: "${e.argv[0]}"` }
    const file = e.argv[e.argv.length - 1] ?? ''
    const text = disk.get(file)
    if (outcome === 0 && text !== undefined && !text.endsWith(FORMATTED)) disk.set(file, `${text.trim()}${FORMATTED}`)
    return { value: { exitCode: outcome, stdout: '', stderr: outcome === 0 ? '' : 'SyntaxError: Unexpected token (3:1)', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () =>
    isToolError ? { isError: true, result: 'old_string not found', text: 'old_string not found' } : { result: { type: 'update' } },
  )
  on('ui.status', ($, e) => {
    statuses.push(e.text ?? '')
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { disk, runs, statuses, toasts }
}

const PRETTIER_PROJECT = {
  '/repo/.git/HEAD': 'ref: main',
  '/repo/package.json': JSON.stringify({ devDependencies: { prettier: '^3.0.0' } }),
  '/repo/node_modules/.bin/prettier': '#!/usr/bin/env node',
  '/repo/src/app.ts': 'const a=1',
}

const edit = (file_path: string) =>
  ({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' }) as const

test('runs the project prettier on an edited file and tells the model it changed', async ($, on) => {
  const { runs, statuses } = world(on, PRETTIER_PROJECT)

  const ran = await $.tool.call(edit('/repo/src/app.ts'))

  expect(runs).toEqual([{ argv: ['/repo/node_modules/.bin/prettier', '--write', '--ignore-unknown', '/repo/src/app.ts'], cwd: '/repo' }])
  expect(ran.context?.join('\n')).toContain('prettier reformatted src/app.ts')
  expect(statuses.at(-1)).toContain('1 file formatted')
})

test('adds nothing when the formatter leaves the file as it was', async ($, on) => {
  const { runs, statuses } = world(on, { ...PRETTIER_PROJECT, '/repo/src/app.ts': 'const a = 1 // formatted\n' })

  const ran = await $.tool.call(edit('/repo/src/app.ts'))

  expect(runs).toHaveLength(1)
  expect(ran.context).toBeUndefined()
  expect(statuses).toHaveLength(0)
})

test('picks ruff for a Python project that configures it, black when only black is named', async ($, on) => {
  const { runs } = world(on, {
    '/repo/.git/HEAD': '',
    '/repo/pyproject.toml': '[tool.ruff]\nline-length = 100\n',
    '/repo/pkg/mod.py': 'x=1',
    '/other/.git/HEAD': '',
    '/other/pyproject.toml': '[tool.poetry.group.dev.dependencies]\nblack = "^24.1"\n',
    '/other/mod.py': 'y=2',
  })

  await $.tool.call(edit('/repo/pkg/mod.py'))
  await $.tool.call({ tool: 'Write', file_path: '/other/mod.py', content: 'y=2' })

  expect(runs.map(run => run.argv)).toEqual([
    ['ruff', 'format', '--quiet', '/repo/pkg/mod.py'],
    ['black', '--quiet', '/other/mod.py'],
  ])
})

test('leaves unconfigured languages, failed edits and disabled formatters alone', { options: { disabled: 'gofmt, prettier' } }, async ($, on) => {
  const { runs } = world(on, {
    ...PRETTIER_PROJECT,
    '/repo/main.go': 'package main',
    '/repo/notes.txt': 'hello',
    '/repo/native.c': 'int main(){}',
  })

  await $.tool.call(edit('/repo/src/app.ts'))
  await $.tool.call(edit('/repo/main.go'))
  await $.tool.call(edit('/repo/notes.txt'))
  await $.tool.call(edit('/repo/native.c'))

  expect(runs).toHaveLength(0)
})

test('says once that a formatter is missing and stops trying it', async ($, on) => {
  const { runs, toasts } = world(on, { '/repo/.git/HEAD': '', '/repo/main.go': 'package main' }, () => 'missing')

  const first = await $.tool.call(edit('/repo/main.go'))
  await $.tool.call(edit('/repo/main.go'))

  expect(runs).toHaveLength(1)
  expect(toasts).toEqual(['auto-format: gofmt is not installed, so main.go was left as written'])
  expect(first.context).toBeUndefined()
})

test('reports a formatter failure (usually a syntax error) without touching the file', async ($, on) => {
  const { disk, statuses } = world(on, PRETTIER_PROJECT, () => 2)

  const ran = await $.tool.call(edit('/repo/src/app.ts'))

  expect(disk.get('/repo/src/app.ts')).toBe('const a=1')
  expect(ran.context?.join('\n')).toContain('prettier could not format src/app.ts (SyntaxError: Unexpected token (3:1))')
  expect(statuses.at(-1)).toContain('✗ auto-format')
})

test('does nothing for a tool call that errored', async ($, on) => {
  const { runs } = world(on, PRETTIER_PROJECT, () => 0, true)

  await $.tool.call(edit('/repo/src/app.ts'))

  expect(runs).toHaveLength(0)
})

test('regression: biome skips files its config ignores and prettier skips files it has no parser for, without a false error', async ($, on) => {
  const { runs } = world(on, {
    '/repo/.git/HEAD': 'ref: main',
    '/repo/biome.json': '{}',
    '/repo/node_modules/.bin/biome': '#!/usr/bin/env node',
    '/repo/src/gen.ts': 'const a=1',
    '/web/.git/HEAD': '',
    '/web/.prettierrc': '{}',
    '/web/App.svelte': '<p>hi</p>',
  })

  await $.tool.call(edit('/repo/src/gen.ts'))
  await $.tool.call(edit('/web/App.svelte'))

  expect(runs.map(run => run.argv)).toEqual([
    ['/repo/node_modules/.bin/biome', 'format', '--write', '--no-errors-on-unmatched', '/repo/src/gen.ts'],
    ['prettier', '--write', '--ignore-unknown', '/web/App.svelte'],
  ])
})

test('regression: biome used as a linter only (formatter off) leaves the file to prettier', async ($, on) => {
  const { runs } = world(on, {
    '/repo/.git/HEAD': 'ref: main',
    '/repo/biome.json': '{ "formatter": { "enabled": false }, "linter": { "enabled": true } }',
    '/repo/package.json': JSON.stringify({ devDependencies: { '@biomejs/biome': '^1.9.0', prettier: '^3.0.0' } }),
    '/repo/src/app.ts': 'const a=1',
  })

  await $.tool.call(edit('/repo/src/app.ts'))

  expect(runs.map(run => run.argv[0])).toEqual(['prettier'])
})
