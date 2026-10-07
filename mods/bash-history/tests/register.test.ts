import type { On } from 'claude-code'
import { test, expect, mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

/** Answers `$.state` from memory, as the host does: a value and the version it stands at. */
const memoryState = (on: On) => {
  const cells = new Map<string, { value: unknown; version: number }>()
  const keyOf = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}/${e.key}/${e.id ?? ''}`
  on('state.get', (_$, e) => ({ value: cells.get(keyOf(e)) ?? { value: undefined, version: 0 } }))
  on('state.set', (_$, e) => {
    const held = cells.get(keyOf(e)) ?? { value: undefined, version: 0 }
    if (e.ifVersion !== undefined && e.ifVersion !== held.version) {
      return { value: { isSet: false, version: held.version } }
    }
    cells.set(keyOf(e), { value: e.value, version: held.version + 1 })
    return { value: { isSet: true, version: held.version + 1 } }
  })
}

type Outcome = 'ok' | 'fail' | 'deny'

/** A Bash tool that takes mocked time and ends as `outcome` says. */
const shell = (on: On) => {
  memoryState(on)
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 7, 12, 0, 0) })
  const plan = { ms: 40, outcome: 'ok' as Outcome }
  on('tool.call', async () => {
    await clock.sleep(plan.ms)
    if (plan.outcome === 'deny') return { deny: 'blocked by policy' }
    return plan.outcome === 'fail' ? { isError: true as const, result: 'Exit code 1' } : { result: 'ok' }
  })
  const run = async ($: Engine, command: string, ms = 40, outcome: Outcome = 'ok') => {
    plan.ms = ms
    plan.outcome = outcome
    const pending = $.tool.call({ tool: 'Bash', command })
    await clock.settle()
    await clock.advance(ms)
    return pending
  }
  return run
}

const history = async ($: Engine, args = '') =>
  (
    await $.command.run({
      command: 'bash-history',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })
  ).text ?? ''

test('registers the command when the session starts', async ($, on) => {
  const registered: string[] = []
  on('command.register', (_$, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  expect(registered).toEqual(['bash-history'])
})

test('lists commands with their outcome and duration, newest last', async ($, on) => {
  const run = shell(on)
  await run($, 'git status', 400)
  await run($, 'npm test', 12_500, 'fail')
  await run($, 'rm -rf /', 5, 'deny')

  const text = await history($)
  const rows = text.split('\n').slice(2)

  expect(text).toContain('Last 3 of 3 shell commands')
  expect(rows).toHaveLength(3)
  expect(rows[0]).toMatch(/^\d\d:\d\d:\d\d {2}ok\s+400ms\s+git status$/)
  expect(rows[1]).toMatch(/FAILED\s+12\.5s\s+npm test$/)
  expect(rows[2]).toMatch(/denied\s+5ms\s+rm -rf \/$/)
})

test('shows the last 30 by default, honours a count and flattens multi-line commands', async ($, on) => {
  const run = shell(on)
  for (let i = 1; i <= 35; i += 1) await run($, `echo ${i}`)
  await run($, 'cat <<EOF\nhello\nEOF')

  const defaultRows = (await history($)).split('\n').slice(2)
  expect(defaultRows).toHaveLength(30)
  expect(defaultRows.at(-1)).toContain('cat <<EOF hello EOF')

  const two = await history($, '2')
  expect(two).toContain('Last 2 of 36 shell commands')
  expect(two.split('\n').slice(2)).toHaveLength(2)
})

test('says so when nothing has run yet', async ($, on) => {
  shell(on)

  expect(await history($)).toContain('has not run any shell commands yet')
})

test('regression: minutes never show 60 seconds, and a huge command is not kept whole', async ($, on) => {
  const run = shell(on)
  await run($, 'sleep 119', 119_600)
  await run($, `cat > big.txt <<'EOF'\n${'x'.repeat(50_000)}\nEOF`)

  const rows = (await history($)).split('\n').slice(2)
  expect(rows[0]).toMatch(/ok\s+2m0s\s+sleep 119$/)
  expect(rows[1]?.length).toBeLessThan(200)
})
