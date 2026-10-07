import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

const PLUGIN = 'regression-guard'
const SURFACES = ['terminal', 'desktop'] as const
const NOW = Date.UTC(2026, 9, 7, 12)

const GREEN = `PASS src/cart.test.ts
  cart
    ✓ adds items (2 ms)
    ✓ applies discounts (1 ms)
PASS src/user.test.ts
  user
    ✓ has a name (1 ms)
Tests:       3 passed, 3 total`

const BROKEN = `FAIL src/cart.test.ts
  cart
    ✓ adds items (2 ms)
    ✕ applies discounts (3 ms)

  ● cart › applies discounts

    Expected: 90
    Received: 100

FAIL src/user.test.ts
  user
    ✕ has a name (2 ms)

  ● user › has a name

    Expected: "Ada"

Tests:       2 failed, 1 passed, 3 total`

const BAND: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
}

/** Stands for the engine: Bash prints `shell.output` (failing when it says so), and records what the plugin shows. */
function world(on: On) {
  const seen = {
    output: GREEN,
    statuses: [] as (string | undefined)[],
    toasts: [] as string[],
    prompts: [] as { text: string; asUser: boolean }[],
  }
  const clock = mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', ($, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => {
    seen.prompts.push({ text: e.text, asUser: e.origin.kind === 'plugin' && e.origin.asUser === true })
    return { text: e.text }
  })
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'engine band' }))
  on('tool.call', ($, e) => {
    if (e.tool !== 'Bash') return { result: { filePath: 'file_path' in e ? String(e.file_path) : '' } }
    const hasFailed = /✕|FAIL /.test(seen.output) && e.command.includes('test')
    return hasFailed
      ? { isError: true as const, result: 'Exit code 1', text: `Exit code 1\n${seen.output}` }
      : { result: { stdout: seen.output, stderr: '', interrupted: false }, text: seen.output }
  })

  return { seen, clock }
}

const baseline = ($: Engine, args = '') =>
  $.command.run({ command: 'baseline', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

/** Box props that size a box: the engine refuses its own nodes under any of them, and the band then disappears. */
const SIZE_PROPS = ['width', 'minWidth', 'maxWidth', 'height', 'minHeight', 'maxHeight', 'flexBasis']
type DrawnNode = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

/** The elements above the first Text showing `text`, outermost first; undefined when the tree draws no such Text. */
const ancestorsOf = (node: unknown, text: string, above: DrawnNode[] = []): DrawnNode[] | undefined => {
  if (typeof node !== 'object' || node === null) return undefined
  const element = node as DrawnNode
  const children = element.children ?? []
  if (element.type === 'Text' && children.includes(text)) return above
  for (const child of children) {
    const found = ancestorsOf(child, text, [...above, element])
    if (found !== undefined) return found
  }
  return undefined
}
/** The size props set on any Box above the engine's band; a line says so when the band is not drawn at all. */
const sizedAbove = (tree: unknown): string[] => {
  const above = ancestorsOf(tree, 'engine band')
  if (above === undefined) return ['no engine band drawn']
  return above.flatMap(box => (box.type === 'Box' ? SIZE_PROPS.filter(prop => box.props?.[prop] !== undefined).map(prop => `Box ${prop}`) : []))
}

test('a test that passed at the session start and fails later raises the band, the status and a note for Claude', async ($, on) => {
  const { seen, clock } = world(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const first = await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(first.context).toBeUndefined()
  expect(seen.statuses.at(-1)).toBeUndefined()

  await clock.advance(5 * 60_000)
  seen.output = BROKEN
  const second = await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(second.isError).toBe(true)
  expect(second.context?.[0]).toBe(
    'regression-guard: 2 tests that passed earlier in this session now fail: src/cart.test.ts › cart › applies discounts; src/user.test.ts › user › has a name. Fix the cause before moving on, or tell the user if the change in behaviour is intended.',
  )
  expect(seen.statuses.at(-1)).toBe('⚠ 2 regressions')
  expect(seen.toasts).toEqual(['⚠ 2 tests that passed earlier this session now fail'])

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })
    expect((await band.find({ type: 'Text', text: /Regressions: 2/ }))?.text).toContain('passed earlier this session, failing now')
    expect((await band.find({ key: 'regression:src/cart.test.ts › cart › applies discounts' }))?.text).toContain('just now')
    expect(await band.find({ key: 'regression:src/user.test.ts › user › has a name' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    expect(await band.find({ key: 'fix' })).toMatchObject({ props: { label: 'Ask Claude to fix regressions' } })
    await band.unmount()
  }
})

test('the band asks Claude to fix the regressions, then hides until the set changes', async ($, on) => {
  const { seen } = world(on)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  seen.output = BROKEN
  await $.tool.call({ tool: 'Bash', command: 'npm test' })

  const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await band.press({ key: 'fix' })
  expect(seen.prompts).toHaveLength(1)
  expect(seen.prompts[0]?.asUser).toBe(true)
  expect(seen.prompts[0]?.text).toContain('These tests passed earlier in this session and now fail (2 regressions):')
  expect(seen.prompts[0]?.text).toContain('- src/user.test.ts › user › has a name')
  expect(seen.prompts[0]?.text).toContain('Re-run `npm test` to see the failures')
  expect(await band.find({ key: 'fix' })).toBeUndefined()
  expect(seen.statuses.at(-1)).toBe('⚠ 2 regressions')

  seen.output = GREEN.replace('✓ has a name', '✕ has a name')
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(seen.statuses.at(-1)).toBe('⚠ 1 regression')
  expect(await band.find({ key: 'fix' })).toBeDefined()
  await band.press({ key: 'dismiss' })
  expect(await band.find({ key: 'fix' })).toBeUndefined()

  seen.output = GREEN
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(seen.statuses.at(-1)).toBeUndefined()
  expect(seen.toasts.at(-1)).toBe('✓ Every regression passes again')
  await band.unmount()
})

test('failures already there at the start, other commands and new tests in edited files are not regressions', async ($, on) => {
  const { seen } = world(on)
  seen.output = BROKEN
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(seen.statuses.filter(status => status !== undefined)).toEqual([])

  seen.output = ' ✓ src/a.test.ts (2 tests) 3ms'
  await $.tool.call({ tool: 'Bash', command: 'npx vitest run' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/a.test.ts', content: 'test("new", () => {})' })
  seen.output = ' ❯ src/a.test.ts (3 tests | 1 failed) 3ms\n   × the new test 1ms'
  const run = await $.tool.call({ tool: 'Bash', command: 'npx vitest run' })
  expect(run.context).toBeUndefined()
  await $.tool.call({ tool: 'Bash', command: 'echo "FAIL src/user.test.ts"' })
  expect(seen.statuses.filter(status => status !== undefined)).toEqual([])
  expect(seen.toasts).toEqual([])
})

test('/baseline sums the baseline up and /baseline reset starts over', async ($, on) => {
  const { seen, clock } = world(on)
  expect((await baseline($)).text).toContain('No test run seen yet this session.')

  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  seen.output = BROKEN
  await clock.advance(3 * 60_000)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const shown = (await baseline($)).text ?? ''
  expect(shown).toContain('◆ Baseline: 5 tests seen this session, 5 passing at their first run.')
  expect(shown).toContain('⚠ 2 regressions:')
  expect(shown).toContain('  ✗ src/user.test.ts › user › has a name (failing since just now, `npm test`)')
  expect(shown).toContain('Last test run: `npm test` just now, 1 passed, 2 failed.')

  expect((await baseline($, 'reset')).text).toBe('↺ Baseline cleared. The next test run becomes the new baseline.')
  expect(seen.statuses.at(-1)).toBeUndefined()
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(seen.statuses.at(-1)).toBeUndefined()
  expect((await baseline($)).text).toContain('1 passing at their first run, 4 already failing')
  expect((await baseline($, 'nonsense')).text).toBe('✗ Unknown option "nonsense". Usage: /baseline [reset]')
})

test('with tellClaude off the test result is left as the runner printed it', { options: { tellClaude: false } }, async ($, on) => {
  const { seen } = world(on)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  seen.output = BROKEN
  const run = await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(run.context).toBeUndefined()
  expect(seen.statuses.at(-1)).toBe('⚠ 2 regressions')
})

test('the engine band is not drawn under a Box with a size prop', async ($, on) => {
  const { seen } = world(on)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  seen.output = BROKEN
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })
    expect(await band.find({ key: 'fix' })).toBeDefined()
    expect(sizedAbove(await band.drawn())).toEqual([])
    await band.unmount()
  }
})
