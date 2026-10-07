import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

type World = { toasts: string[]; percent: number | undefined; failing: Set<string> }

const answerEngine = (on: On): World => {
  const world: World = { toasts: [], percent: 70, failing: new Set() }
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000, percent: world.percent }, rateLimits: [] },
  }))
  on('tool.call', (_$, e) =>
    world.failing.has(String(e.tool)) ? { result: 'failed', isError: true } : { result: 'ok' },
  )
  on('ui.toast', (_$, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  return world
}

let turnCount = 0

/** One main-conversation turn that runs `work` between its start and its completion. */
const turn = async ($: Engine, work: () => Promise<unknown> = async () => undefined) => {
  const turnId = `turn-${(turnCount += 1)}`
  await $.turn.start({ text: 'go', turnId })
  await work()
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1000, isAborted: false, turnId })
}

const bash = ($: Engine, command: string) => () => $.tool.call({ tool: 'Bash', command })

test('suggests /compact after a commit once the context is over 60%', async ($, on) => {
  const world = answerEngine(on)

  await turn($, bash($, 'git add -A && git commit -m "feat: add thing"'))

  expect(world.toasts).toEqual(['Good moment to /compact (context 70%, after a commit)'])
})

test('suggests it after a passing test run, but not after a failing one', async ($, on) => {
  const world = answerEngine(on)

  world.failing.add('Bash')
  await turn($, bash($, 'npm test'))
  expect(world.toasts).toHaveLength(0)

  world.failing.clear()
  await turn($, bash($, 'pnpm run test'))
  expect(world.toasts).toHaveLength(1)
  expect(world.toasts[0]).toContain('tests just passed')
})

test('stays quiet while the context is small, work is open, or the task did not just end', async ($, on) => {
  const world = answerEngine(on)

  world.percent = 40
  await turn($, bash($, 'git commit -m x'))
  expect(world.toasts).toHaveLength(0)

  world.percent = 80
  await turn($, async () => {
    await $.tool.call({
      tool: 'TodoWrite',
      todos: [{ content: 'next', status: 'pending', activeForm: 'Doing next' }],
    })
    await bash($, 'git commit -m x')()
  })
  expect(world.toasts).toHaveLength(0)

  await turn($, async () => {
    await bash($, 'npm test')()
    await $.tool.call({ tool: 'Edit', file_path: '/a.ts', old_string: 'a', new_string: 'b' })
  })
  expect(world.toasts).toHaveLength(0)
})

test('completed todos and task-list bookkeeping after the commit do not hide the milestone', async ($, on) => {
  const world = answerEngine(on)

  await turn($, async () => {
    await $.tool.call({
      tool: 'TodoWrite',
      todos: [{ content: 'ship', status: 'in_progress', activeForm: 'Shipping' }],
    })
    await bash($, 'git commit -m ship')()
    await $.tool.call({
      tool: 'TodoWrite',
      todos: [{ content: 'ship', status: 'completed', activeForm: 'Shipping' }],
    })
  })

  expect(world.toasts).toHaveLength(1)
})

test('suggests at most once per 10 turns', async ($, on) => {
  const world = answerEngine(on)

  await turn($, bash($, 'git commit -m one'))
  expect(world.toasts).toHaveLength(1)

  for (let i = 0; i < 8; i++) await turn($)
  await turn($, bash($, 'git commit -m two'))
  expect(world.toasts).toHaveLength(1)

  await turn($, bash($, 'git commit -m three'))
  expect(world.toasts).toHaveLength(2)
})

test('the context threshold is configurable', { options: { minPercent: 30 } }, async ($, on) => {
  const world = answerEngine(on)
  world.percent = 35

  await turn($, bash($, 'go test ./...'))
  expect(world.toasts).toHaveLength(1)
})

test('regression: a command that only mentions a test runner is no passing test run', async ($, on) => {
  const world = answerEngine(on)

  await turn($, bash($, 'cat jest.config.js'))
  await turn($, bash($, 'pip install pytest'))
  expect(world.toasts).toHaveLength(0)

  await turn($, bash($, 'cd api && CI=1 npx vitest run'))
  expect(world.toasts[0]).toContain('tests just passed')
})
