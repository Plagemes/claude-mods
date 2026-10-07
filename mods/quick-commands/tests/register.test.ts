import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { checkCountsOf, toolOf } from '../hooks/results'
import { fakeHub } from './hub'

const run = ($: Engine, command: string, args = '') =>
  $.command.run({
    command,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })

type World = { submitted: string[]; advance: (ms: number) => Promise<void> }

/** A project made of `files` (path to content); records the prompts the engine is asked to run. */
const project = (on: On, files: Record<string, string>): World => {
  const clock = mock.clock(on)
  const world: World = { submitted: [], advance: clock.advance }
  on('session.cwd', () => ({ value: '/proj' }))
  on('fs.exists', (_$, e) => ({ value: e.path.startsWith('/proj/') && e.path.slice('/proj/'.length) in files }))
  on('fs.read', (_$, e) => {
    const content = files[e.path.slice('/proj/'.length)]
    return content === undefined ? { deny: 'ENOENT' } : { value: content }
  })
  on('prompt.submit', (_$, e) => {
    world.submitted.push(e.text)
    return { text: e.text }
  })
  return world
}

const PACKAGE_JSON = JSON.stringify({
  scripts: { test: 'vitest run', lint: 'eslint .', build: 'tsc -b', 'type-check': 'tsc --noEmit' },
})

test('/t /l /b /tc submit a prompt with the project’s own scripts, using the right package manager', async ($, on) => {
  const world = project(on, { 'package.json': PACKAGE_JSON, 'pnpm-lock.yaml': '' })

  const started = await run($, 't')
  await world.advance(1)
  await run($, 'l')
  await run($, 'b')
  await run($, 'tc')
  await world.advance(1)

  expect(started.text).toBe('Running the test suite: pnpm run test')
  expect(world.submitted).toEqual([
    'Run the test suite with `pnpm run test` and fix any failures.',
    'Run the linter with `pnpm run lint` and fix every issue it reports.',
    'Run the build with `pnpm run build` and fix any errors.',
    'Run the type checker with `pnpm run type-check` and fix every type error.',
  ])
})

test('arguments narrow the prompt, and the configured command beats detection', { options: { testCommand: 'just test' } }, async ($, on) => {
  const world = project(on, { 'package.json': PACKAGE_JSON })

  await run($, 't', ' src/auth ')
  await world.advance(1)

  expect(world.submitted).toEqual(['Run the test suite with `just test` and fix any failures. Limit it to: src/auth.'])
})

test('detects Makefile targets', async ($, on) => {
  const make = project(on, { Makefile: '.PHONY: test\ntest:\n\tgo test\nlint:\n\tgolangci-lint run\n' })
  await run($, 't')
  await run($, 'l')
  await make.advance(1)
  expect(make.submitted.map(text => /`(.*)`/.exec(text)?.[1])).toEqual(['make test', 'make lint'])
})

test('falls back from the placeholder npm test script to tsc, and to other ecosystems', async ($, on) => {
  const world = project(on, {
    'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    'tsconfig.json': '{}',
    'Cargo.toml': '',
  })

  await run($, 'tc')
  await run($, 't')
  await run($, 'b')
  await world.advance(1)

  expect(world.submitted.map(text => /`(.*)`/.exec(text)?.[1])).toEqual(['npx tsc --noEmit', 'cargo test', 'cargo build'])
})

test('reads Python tooling from pyproject.toml', async ($, on) => {
  const world = project(on, { 'pyproject.toml': '[build-system]\n[tool.ruff]\n[tool.mypy]\n' })

  for (const command of ['t', 'l', 'b', 'tc']) await run($, command)
  await world.advance(1)

  expect(world.submitted.map(text => /`(.*)`/.exec(text)?.[1])).toEqual(['pytest', 'ruff check .', 'python -m build', 'mypy .'])
})

test('says what to configure when no command can be found, and submits nothing', async ($, on) => {
  const world = project(on, {})

  const { text } = await run($, 'l')
  await world.advance(1)

  expect(text).toContain('No linter command found')
  expect(text).toContain('lintCommand')
  expect(world.submitted).toHaveLength(0)
})

test('reads Go projects from go.mod', async ($, on) => {
  const world = project(on, { 'go.mod': 'module x' })

  for (const command of ['t', 'l', 'b']) await run($, command)
  await world.advance(1)

  expect(world.submitted.map(text => /`(.*)`/.exec(text)?.[1])).toEqual(['go test ./...', 'go vet ./...', 'go build ./...'])
})

test('reads errors and warnings from linters, type checkers and compilers', () => {
  expect(checkCountsOf('/src/a.ts\n  1:1  error  x\n\n✖ 5 problems (3 errors, 2 warnings)\n', true)).toEqual({ errors: 3, warnings: 2 })
  expect(checkCountsOf('src/a.py:1:1: F401 unused\nFound 4 errors.\n', true)).toEqual({ errors: 4, warnings: 0 })
  expect(checkCountsOf("src/a.ts(1,7): error TS2322: Type 'x'.\nsrc/b.ts(2,1): error TS2304: Cannot find.\n", true)).toEqual({ errors: 2, warnings: 0 })
  expect(checkCountsOf('warning: unused variable\nerror[E0308]: mismatched types\nerror: could not compile `app`\n', true)).toEqual({ errors: 1, warnings: 1 })
  expect(checkCountsOf('Segmentation fault\n', true)).toEqual({ errors: 1, warnings: 0 })
  expect(checkCountsOf('All good\n', false)).toEqual({ errors: 0, warnings: 0 })
  expect(toolOf('CI=1 npm run lint')).toBe('npm')
  expect(toolOf('./scripts/check.sh --all')).toBe('check.sh')
})

test('with mods-hub: the result of the command it asked for is published, and the hub\'s own test runs are not repeated', { options: { testCommand: './scripts/run-tests.sh' } }, async ($, on) => {
  const world = project(on, { 'package.json': PACKAGE_JSON })
  const hub = fakeHub(on)
  const outputs: Record<string, { stdout: string; isError: boolean }> = {
    'npm run lint': { stdout: '✖ 5 problems (3 errors, 2 warnings)\n', isError: true },
    './scripts/run-tests.sh': { stdout: ' Test Files  1 passed (1)\n      Tests  7 passed (7)\n', isError: false },
    'npm run build': { stdout: 'done\n', isError: false },
  }
  on('tool.call', (_$, e) => {
    const ran = (e as { command: string }).command
    const out = Object.entries(outputs).find(([command]) => ran.includes(command))?.[1] ?? { stdout: '', isError: false }
    const result = { stdout: out.stdout, stderr: '', interrupted: false }
    return out.isError ? { result, isError: true } : { result }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  expect(hub.hellos[0]?.publishes).toEqual(['test.result', 'build.result', 'lint.result', 'typecheck.result'])

  await run($, 'l')
  await run($, 't')
  await run($, 'b')
  await world.advance(1)
  expect(world.submitted).toHaveLength(3)

  // A command nobody asked for publishes nothing.
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Bash', command: 'npm run lint' })
  await $.tool.call({ tool: 'Bash', command: 'cd /proj && ./scripts/run-tests.sh' })
  await $.tool.call({ tool: 'Bash', command: 'npm run build' })
  await world.advance(1)
  expect(hub.published).toEqual([
    { topic: 'lint.result', data: { tool: 'npm', errors: 3, warnings: 2 } },
    { topic: 'test.result', data: { runner: 'vitest', outcome: 'passed', passed: 7, failed: null, durationMs: 0, command: 'cd /proj && ./scripts/run-tests.sh' } },
    { topic: 'build.result', data: { tool: 'npm', outcome: 'passed', durationMs: 0, command: 'npm run build', errors: 0 } },
  ])

  // Run again by hand later: nothing is waiting for it any more.
  await $.tool.call({ tool: 'Bash', command: 'npm run lint' })
  await world.advance(1)
  expect(hub.published).toHaveLength(3)
})

test('with mods-hub: a test runner the hub already reports is not published twice', async ($, on) => {
  const world = project(on, { 'package.json': PACKAGE_JSON })
  const hub = fakeHub(on)
  on('tool.call', () => ({ result: { stdout: 'Tests  1 passed (1)', stderr: '', interrupted: false } }))
  await run($, 't')
  await world.advance(1)
  await $.tool.call({ tool: 'Bash', command: 'npm run test' })
  await world.advance(1)
  expect(hub.published).toEqual([])
})
