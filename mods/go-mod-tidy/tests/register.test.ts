import type { On } from 'claude-code'
import { test, expect, mock } from 'claude-code/testing'

import { changedImports, describeChange, isOwnPackage, modulePathOf, moduleImports } from '../hooks/imports'

const GO_MOD = 'module example.com/app\n\ngo 1.22\n\nrequire github.com/old/pkg v1.0.0\n'
const UUID_ADDED = 'module example.com/app\n\ngo 1.22\n\nrequire (\n\tgithub.com/google/uuid v1.6.0\n)\n'

type Tidy = { exitCode: number; stderr?: string; goMod?: string } | 'no-go' | 'timeout'

/** Stands in for the engine: files on a virtual disk, what `go mod tidy` does, and the toasts and runs. */
function project(on: On, files: Record<string, string>, tidy: Tidy = { exitCode: 0, goMod: UUID_ADDED }) {
  const clock = mock.clock(on)
  const seen = { runs: [] as { argv: readonly string[]; cwd: string | undefined }[], toasts: [] as string[] }
  on('tool.call', () => ({ result: 'ok' }))
  on('fs.exists', (_$, e) => ({ value: e.path in files }))
  on('fs.read', (_$, e) => {
    const text = files[e.path]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('process.run', (_$, e) => {
    seen.runs.push({ argv: e.argv, cwd: e.init?.cwd })
    if (tidy === 'no-go') return { deny: 'failed to start: ENOENT' }
    if (tidy === 'timeout') return { deny: 'aborted: still running after 60000ms' }
    if (tidy.goMod !== undefined && tidy.exitCode === 0) files[`${e.init?.cwd}/go.mod`] = tidy.goMod
    return { value: { exitCode: tidy.exitCode, stdout: '', stderr: tidy.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  return { seen, clock }
}

const FILES = { '/repo/go.mod': GO_MOD, '/repo/go.sum': '', '/repo/cmd/main.go': 'package main\n' }

const addImport = {
  tool: 'Edit',
  file_path: '/repo/cmd/main.go',
  old_string: 'import (\n\t"fmt"\n)',
  new_string: 'import (\n\t"fmt"\n\t"github.com/google/uuid"\n)',
} as const

test('runs go mod tidy two seconds after an import was added, in the module root, and tells the user and Claude', async ($, on) => {
  const { seen, clock } = project(on, { ...FILES })
  await $.tool.call(addImport)

  await clock.advance(1999)
  expect(seen.runs).toEqual([])
  await clock.advance(1)
  expect(seen.runs).toEqual([{ argv: ['go', 'mod', 'tidy'], cwd: '/repo' }])
  expect(seen.toasts).toEqual(['go mod tidy: go.mod updated (added github.com/google/uuid v1.6.0; removed github.com/old/pkg)'])

  const next = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(next.context?.[0]).toContain('ran go mod tidy in /repo; go.mod/go.sum changed: added github.com/google/uuid v1.6.0; removed github.com/old/pkg')
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).context).toBeUndefined()
})

test('a burst of edits runs it once', async ($, on) => {
  const { seen, clock } = project(on, { ...FILES, '/repo/pkg/a.go': 'package pkg\n' })
  await $.tool.call(addImport)
  await clock.advance(1500)
  await $.tool.call({ ...addImport, file_path: '/repo/pkg/a.go' })
  await clock.advance(1500)
  expect(seen.runs).toEqual([])
  await clock.advance(500)
  expect(seen.runs).toHaveLength(1)
})

test('only import changes that go.mod can care about start it: not stdlib, local packages, bodies, other languages or vendor', async ($, on) => {
  const { seen, clock } = project(on, { ...FILES })
  const edit = (old_string: string, new_string: string, file_path = '/repo/cmd/main.go') => $.tool.call({ tool: 'Edit', file_path, old_string, new_string })
  await edit('import "fmt"', 'import (\n\t"fmt"\n\t"os"\n)')
  await edit('import "fmt"', 'import (\n\t"fmt"\n\t"example.com/app/internal/store"\n)')
  await edit('x := 1', 'x := 2\n\treturn "github.com/a/b"')
  await edit('a', 'b', '/repo/cmd/main.ts')
  await edit('import "fmt"', 'import "github.com/a/b"', '/repo/vendor/github.com/a/b/b.go')
  await clock.advance(10000)
  expect(seen.runs).toEqual([])
})

test('a Write is compared with the file it replaces', async ($, on) => {
  const old = 'package main\n\nimport (\n\t"fmt"\n\t"github.com/google/uuid"\n)\n'
  const { seen, clock } = project(on, { ...FILES, '/repo/cmd/main.go': old })
  await $.tool.call({ tool: 'Write', file_path: '/repo/cmd/main.go', content: old.replace('fmt', 'log') })
  await clock.advance(5000)
  expect(seen.runs).toEqual([])

  await $.tool.call({ tool: 'Write', file_path: '/repo/cmd/main.go', content: old.replace('\t"github.com/google/uuid"\n', '') })
  await clock.advance(2000)
  expect(seen.runs).toHaveLength(1)
})

test('does nothing when there is no go.mod above the file', async ($, on) => {
  const { seen, clock } = project(on, { '/tmp/x/main.go': 'package main\n' })
  await $.tool.call({ ...addImport, file_path: '/tmp/x/main.go' })
  await clock.advance(5000)
  expect(seen.runs).toEqual([])
})

test('reports a failure to the user and to Claude', async ($, on) => {
  const { seen, clock } = project(on, { ...FILES }, { exitCode: 1, stderr: 'go: finding module for package github.com/nope/x\nno required module provides package github.com/nope/x\n' })
  await $.tool.call(addImport)
  await clock.advance(2000)
  expect(seen.toasts).toEqual(['go mod tidy failed: go: finding module for package github.com/nope/x'])
  const next = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(next.context?.[0]).toContain('go mod tidy failed in /repo: go: finding module for package github.com/nope/x | no required module provides package')
})

test('says so once when go is not installed, and stops trying', async ($, on) => {
  const { seen, clock } = project(on, { ...FILES }, 'no-go')
  await $.tool.call(addImport)
  await clock.advance(2000)
  await $.tool.call(addImport)
  await clock.advance(2000)
  expect(seen.runs).toHaveLength(1)
  expect(seen.toasts).toEqual(['go is not installed, so go.mod was not tidied'])
})

test('a run that takes too long is reported, and timeoutSeconds sets the limit', { options: { timeoutSeconds: 5 } }, async ($, on) => {
  const { seen, clock } = project(on, { ...FILES }, 'timeout')
  await $.tool.call(addImport)
  await clock.advance(2000)
  expect(seen.toasts).toEqual(['go mod tidy stopped after 5s'])
})

test('already tidy is a short toast, with nothing for Claude', async ($, on) => {
  const { seen, clock } = project(on, { ...FILES }, { exitCode: 0 })
  await $.tool.call(addImport)
  await clock.advance(2000)
  expect(seen.toasts).toEqual(['go mod tidy: already tidy'])
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).context).toBeUndefined()
})

test('import parsing: blocks, aliases, single imports and fragments; strings that are not imports', () => {
  const file = 'package a\n\nimport (\n\t"fmt"\n\tlog "github.com/rs/zerolog"\n\t_ "github.com/lib/pq"\n\t. "golang.org/x/exp/slices" // dot\n)\nimport "gopkg.in/yaml.v3"\n'
  expect([...moduleImports(file)]).toEqual(['github.com/rs/zerolog', 'github.com/lib/pq', 'golang.org/x/exp/slices', 'gopkg.in/yaml.v3'])
  expect([...moduleImports('\t"github.com/a/b"\n\treturn "github.com/c/d"\n\tx := []string{\n\t\t"github.com/e/f",\n\t}\n')]).toEqual(['github.com/a/b'])
  expect(changedImports('"github.com/a/b"', '"github.com/a/b"\n"github.com/c/d"')).toEqual(['github.com/c/d'])
  expect(changedImports('"github.com/a/b"\n"fmt"', '"github.com/a/b"')).toEqual([])
  expect(changedImports('"github.com/a/b"', '"github.com/c/d"')).toEqual(['github.com/c/d', 'github.com/a/b'])
  expect(modulePathOf(GO_MOD)).toBe('example.com/app')
  expect(isOwnPackage('example.com/app/internal/x', 'example.com/app')).toBe(true)
  expect(isOwnPackage('example.com/application', 'example.com/app')).toBe(false)
})

test('describes go.mod changes in words', () => {
  const before = 'require (\n\tgithub.com/a/a v1.0.0\n\tgithub.com/b/b v1.0.0\n)\n'
  const after = 'require (\n\tgithub.com/a/a v1.1.0\n\tgithub.com/c/c v2.0.0 // indirect\n)\n'
  expect(describeChange(before, after)).toBe('added github.com/c/c v2.0.0; removed github.com/b/b; changed version of github.com/a/a')
})
