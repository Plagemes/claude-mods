import type { On } from 'claude-code'
import { test, expect } from 'claude-code/testing'

const PERSON = { wait: false, origin: { kind: 'composer' } } as const
const TYPED = { command: 'git-branch', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

type Git = { exitCode: number; stderr: string }

/** Stands in for the engine: records the git calls (in `calls`) and the registered commands. */
function engine(on: On, git: Git = { exitCode: 0, stderr: '' }) {
  const calls: string[][] = []
  const registered: string[] = []
  on('process.run', (_$, e) => {
    calls.push([...e.argv])
    return { value: { exitCode: git.exitCode, stdout: '', stderr: git.stderr, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('session.messages', () => ({ value: [] }))
  on('command.register', (_$, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  return { calls, registered }
}

const branchOf = (calls: string[][]) => calls[0]?.at(-1)

test('registers the command when the session starts', async ($, on) => {
  const { registered } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(registered).toEqual(['git-branch'])
})

test('turns a description into <type>/<slug> and switches to it with git', async ($, on) => {
  const { calls } = engine(on)
  const result = await $.command.run({ ...TYPED, args: 'fix the login redirect loop' })
  expect(calls).toEqual([['git', 'switch', '-c', 'fix/login-redirect-loop']])
  expect(result.text).toContain('created and switched to fix/login-redirect-loop')
})

test('infers the type from keywords and cleans the slug', async ($, on) => {
  const { calls } = engine(on)
  const cases: Array<[string, string]> = [
    ['Add dark mode toggle to the settings page', 'feat/dark-mode-toggle-settings-page'],
    ['add unit tests for the date parser', 'test/unit-tests-date-parser'],
    ['fix typo in README', 'docs/typo-readme'],
    ['Refactor payment service into smaller modules', 'refactor/payment-service-smaller-modules'],
    ['bump lodash to 4.17.21', 'chore/lodash-4-17-21'],
    ['upgrade eslint to v9', 'chore/eslint-v9'],
    ['fix(auth): token refresh race', 'fix/token-refresh-race'],
    ['Überarbeite das Café-Menü!!', 'feat/uberarbeite-das-cafe-menu'],
    ['implement a really long description of everything that the new reporting dashboard must do', 'feat/really-long-description-everything-new'],
  ]
  for (const [args, expected] of cases) {
    calls.length = 0
    await $.command.run({ ...TYPED, args })
    expect(`${args} => ${branchOf(calls)}`).toBe(`${args} => ${expected}`)
  }
})

test('uses the configured prefix', { options: { prefix: 'AB' } }, async ($, on) => {
  const { calls } = engine(on)
  await $.command.run({ ...TYPED, args: 'add search filters' })
  expect(branchOf(calls)).toBe('ab/feat/search-filters')
})

test('without a description it uses the last prompt, not slash commands or other plugins', async ($, on) => {
  const { calls } = engine(on)
  await $.prompt.submit({ ...PERSON, text: 'Please fix the flaky checkout test' })
  await $.prompt.submit({ ...PERSON, text: '/status' })
  await $.prompt.submit({ text: 'something else', wait: false, origin: { kind: 'plugin', name: 'other' } })
  const result = await $.command.run({ ...TYPED, args: '' })
  expect(branchOf(calls)).toBe('test/flaky-checkout-test')
  expect(result.text).toContain('test/flaky-checkout-test')
})

test('without any description or prompt it explains the usage and does not touch git', async ($, on) => {
  const { calls } = engine(on)
  const result = await $.command.run({ ...TYPED, args: '  ' })
  expect(result.text).toContain('/git-branch <what you are about to do>')
  expect(calls).toHaveLength(0)
})

test('reports an existing branch and a missing repository in plain words', async ($, on) => {
  const git: Git = { exitCode: 128, stderr: "fatal: a branch named 'feat/x' already exists" }
  engine(on, git)
  const exists = await $.command.run({ ...TYPED, args: 'add x' })
  expect(exists.text).toContain('feat/x already exists')

  git.stderr = 'fatal: not a git repository (or any of the parent directories): .git'
  const missing = await $.command.run({ ...TYPED, args: 'add x' })
  expect(missing.text).toContain('not inside a git repository')
})
