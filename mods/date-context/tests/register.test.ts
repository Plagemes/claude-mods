import type { On, PromptOrigin } from 'claude-code'
import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

type Run = { exitCode: number; stdout: string } | 'fails'
type Answers = { git: Run; uname: Run; os?: string }

/** Stands in for the engine: a fixed clock, canned answers for git and uname, and the prompt as it enters. */
const engine = (on: On, answers: Answers) => {
  const spawned: string[] = []
  mock.clock(on, { now: Date.UTC(2026, 9, 7, 12, 3, 41) })
  mock.env(on, answers.os === undefined ? {} : { OS: answers.os })
  on('process.run', (_$, e) => {
    spawned.push(e.argv[0] ?? '')
    const answer = e.argv[0] === 'git' ? answers.git : answers.uname
    if (answer === 'fails') return { deny: 'not found' }
    return { value: { ...answer, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
  return spawned
}

const submit = (
  $: Engine,
  text: string,
  options: { origin?: PromptOrigin; context?: readonly string[] } = {},
) => $.prompt.submit({ text, wait: false, origin: options.origin ?? { kind: 'composer' }, context: options.context })

const contextOf = async ($: Engine, text = 'hello') => (await submit($, text)).context?.[0] ?? ''

const ON_A_BRANCH: Answers = {
  git: { exitCode: 0, stdout: 'feature/login\n' },
  uname: { exitCode: 0, stdout: 'Linux\n' },
}

test('attaches the date, time zone, git branch and OS to a prompt as hidden context', async ($, on) => {
  engine(on, ON_A_BRANCH)

  const result = await submit($, 'add a login page')

  expect(result.text).toBe('add a login page')
  expect(result.context).toHaveLength(1)
  expect(result.context?.[0]).toMatch(
    /^Current context: 2026-10-\d\dT\d\d:\d\d[+-]\d\d:\d\d(?: \([^)]+\))?, git branch feature\/login, Linux\.$/,
  )
})

test('adds to the context other hooks attached, and leaves slash commands and notifications alone', async ($, on) => {
  engine(on, ON_A_BRANCH)

  const withNote = await submit($, 'hello', { context: ['an earlier note'] })
  expect(withNote.context?.[0]).toBe('an earlier note')
  expect(withNote.context?.[1]).toContain('Current context:')

  expect((await submit($, '/clear')).context).toBeUndefined()
  expect((await submit($, 'task finished', { origin: { kind: 'task-notification' } })).context).toBeUndefined()
})

test('names a detached HEAD and leaves the branch out of a directory that is not a repository', async ($, on) => {
  const answers: Answers = { ...ON_A_BRANCH, git: { exitCode: 1, stdout: '' } }
  engine(on, answers)
  expect(await contextOf($)).toContain('git branch detached HEAD')

  answers.git = { exitCode: 128, stdout: '' }
  expect(await contextOf($)).not.toContain('git branch')
  expect(await contextOf($)).toContain(', Linux.')
})

test('names the platform, asking uname only once', async ($, on) => {
  const spawned = engine(on, { ...ON_A_BRANCH, uname: { exitCode: 0, stdout: 'Darwin\n' } })

  expect(await contextOf($)).toContain(', macOS.')
  expect(await contextOf($)).toContain(', macOS.')

  expect(spawned.filter(command => command === 'uname')).toHaveLength(1)
})

test('still gives the time when git and uname are unavailable, using the Windows variable for the OS', async ($, on) => {
  engine(on, { git: 'fails', uname: 'fails', os: 'Windows_NT' })

  const line = await contextOf($)

  expect(line).toMatch(/^Current context: 2026-10-\d\dT/)
  expect(line).not.toContain('git branch')
  expect(line).toEndWith(', Windows.')
})
