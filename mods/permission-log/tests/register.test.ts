import type { On } from 'claude-code'
import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

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

/** Stands in for the engine and the guards beneath the plugin. */
const engine = (on: On) => {
  const statuses: (string | undefined)[] = []
  memoryState(on)
  mock.clock(on, { now: Date.UTC(2026, 9, 7, 12, 0, 0) })
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash' && e.command.startsWith('rm ')) return { deny: 'rm-rf-guard: refusing to delete outright.' }
    if (e.tool === 'Write') {
      return { isError: true as const, result: 'rejected', text: "The user doesn't want to proceed with this tool use. The tool use was rejected." }
    }
    return { result: 'ok' }
  })
  return statuses
}

const denied = async ($: Engine, args = '') =>
  (
    await $.command.run({
      command: 'denied',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })
  ).text ?? ''

test('registers /denied when the session starts', async ($, on) => {
  const registered: string[] = []
  engine(on)
  on('command.register', (_$, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  expect(registered).toEqual(['denied'])
})

test('logs a guard refusal with the tool, what it was about and why, and counts it in the status', async ($, on) => {
  const statuses = engine(on)

  await $.tool.call({ tool: 'Bash', command: 'ls' })
  const refused = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  expect(statuses.at(-1)).toBe('⛔ 1 denied')
  await $.tool.call({ tool: 'Bash', command: 'rm -rf dist' })
  const text = await denied($)

  expect(refused.deny).toContain('rm-rf-guard')
  expect(statuses.at(-1)).toBe('⛔ 2 denied')
  expect(text).toContain('2 denied tool calls (newest last)')
  expect(text).toMatch(/\d\d:\d\d:\d\d {2}Bash {2}rm -rf build/)
  expect(text).toContain('why: rm-rf-guard: refusing to delete outright.')
  expect(text).not.toMatch(/Bash {2}ls/)
})

test("logs the person's refusal at a permission prompt", async ($, on) => {
  engine(on)

  await $.tool.call({ tool: 'Write', file_path: '/repo/a.ts', content: 'x' })
  const text = await denied($)

  expect(text).toContain('Write  /repo/a.ts')
  expect(text).toContain('why: Rejected by you at the permission prompt.')
})

test("logs the engine's deny verdict once per call, whichever hook sees it", async ($, on) => {
  const statuses = engine(on)
  on('tool.check', () => ({ decision: 'deny', reason: 'Bash(curl:*) is denied by settings', rule: 'Bash(curl:*)' }))

  const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'curl example.com' }, tool_use_id: 'toolu_1' })
  await $.tool.check({ tool: 'Bash', input: { command: 'curl example.com' }, tool_use_id: 'toolu_1' })
  await $.tool.check({ tool: 'Bash', input: { command: 'curl other.com' } }) // a query, not a real call

  expect(verdict.decision).toBe('deny')
  expect(statuses.at(-1)).toBe('⛔ 1 denied')
  const text = await denied($)
  expect(text).toContain('Bash  curl example.com')
  expect(text).toContain('why: Bash(curl:*) is denied by settings (rule Bash(curl:*))')
  expect(text).not.toContain('other.com')
})

test('says so when nothing was denied, and /denied clear empties the log and the status', async ($, on) => {
  const statuses = engine(on)
  expect(await denied($)).toContain('No tool call has been denied')

  await $.tool.call({ tool: 'Bash', command: 'rm x' })
  expect(statuses.at(-1)).toBe('⛔ 1 denied')

  expect(await denied($, 'clear')).toContain('Cleared')
  expect(statuses.at(-1)).toBeUndefined()
  expect(await denied($)).toContain('No tool call has been denied')
})
