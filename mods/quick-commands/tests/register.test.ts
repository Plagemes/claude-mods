import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

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
