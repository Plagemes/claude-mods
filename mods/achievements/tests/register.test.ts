import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { fakeHub } from './hub'


const PLUGIN = 'achievements'
const SURFACES = ['terminal', 'desktop'] as const
/** Wednesday 7 October 2026, noon, in the local time zone. */
const NOON = new Date(2026, 9, 7, 12, 0, 0).getTime()
const DAY = 86_400_000

const PANE: RenderPropsOf['Pane'] = {
  title: 'Achievements',
  isFocused: true,
  bodyColumns: 96,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

const day = (ms: number): string => {
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Stands for the store, the clock, the tools and the surface beneath the plugin. */
function world(on: On, options: { now?: number; stored?: unknown; isPlaced?: boolean } = {}) {
  const clock = mock.clock(on, { now: options.now ?? NOON })
  const store = new Map<string, unknown>(options.stored === undefined ? [] : [['progress', options.stored]])
  const toasts: string[] = []
  const sounds: string[] = []
  const shell = { fails: false, output: 'ok' }
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('audio.play', ($, e) => {
    sounds.push('asset' in e.clip ? String(e.clip.asset) : 'other')
    return { value: undefined }
  })
  on('ui.open', () => ({
    value: options.isPlaced === false ? { isPlaced: false as const, reason: 'no surface places panes' } : { isPlaced: true as const },
  }))
  on('ui.close', () => ({ value: undefined }))
  on('tool.call', ($, e) => {
    if (e.tool === 'Bash' && shell.fails) return { isError: true as const, result: 'Exit code 1', text: `Exit code 1\n${shell.output}` }
    return { result: { stdout: shell.output, stderr: '', interrupted: false }, text: shell.output }
  })

  return { clock, store, toasts, sounds, shell }
}

const prompt = ($: Engine, text = 'hello') => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })
const progress = (store: Map<string, unknown>) => store.get('progress') as { counters: Record<string, number>; unlocked: Record<string, number>; languages: string[] }

test('the first prompt unlocks Hello, Claude with a toast and a sound, and the progress is saved', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await prompt($)
  await w.clock.settle()

  expect(w.toasts).toEqual(['🏆 Unlocked: 👋 Hello, Claude · Send your first prompt'])
  expect(w.sounds).toEqual(['assets/unlock.wav'])
  expect(progress(w.store).counters.prompts).toBe(1)
  expect(progress(w.store).unlocked).toEqual({ 'first-prompt': NOON })

  await $.prompt.submit({ text: 'from a plugin', wait: false, origin: { kind: 'plugin', name: 'task-queue' } })
  await w.clock.advance(5_000)
  expect(progress(w.store).counters.prompts).toBe(1)
})

test('commits, test runs that turn green, subagents and edits in five languages count toward their achievements', async ($, on) => {
  const w = world(on)
  await bash($, 'git commit -m "feat: login"')
  w.shell.fails = true
  w.shell.output = 'Tests: 1 failed, 4 passed'
  await bash($, 'npm test')
  w.shell.fails = false
  w.shell.output = 'Tests: 5 passed'
  await bash($, 'npm test')
  await $.tool.call({ tool: 'Agent', description: 'explore', prompt: 'look around', subagent_type: 'Explore' })
  for (const file of ['a.ts', 'b.py', 'c.go', 'd.rs', 'e.rb', 'notes.md']) {
    await $.tool.call({ tool: 'Write', file_path: `/repo/${file}`, content: 'x' })
  }
  await w.clock.settle()

  const saved = progress(w.store)
  expect(saved.counters).toMatchObject({ commits: 1, greenRuns: 1, redToGreen: 1, subagents: 1, tools: 10, sessionFiles: 6 })
  expect(saved.languages).toEqual(['Go', 'Python', 'Ruby', 'Rust', 'TypeScript'])
  expect(Object.keys(saved.unlocked).sort()).toEqual(['first-commit', 'first-subagent', 'green-1', 'polyglot'])
  expect(w.toasts.join('\n')).toContain('📝 First commit')
})

test('a prompt after midnight on a Saturday unlocks Night owl and Weekend warrior; seven days in a row make a streak', async ($, on) => {
  const saturday = new Date(2026, 9, 10, 1, 30).getTime()
  const before = Array.from({ length: 6 }, (_, index) => day(saturday - (index + 1) * DAY))
  const w = world(on, { now: saturday, stored: { counters: { prompts: 41 }, unlocked: { 'first-prompt': 1 }, activeDays: before } })
  await prompt($)
  await w.clock.settle()

  expect(Object.keys(progress(w.store).unlocked).sort()).toEqual(['first-prompt', 'night-owl', 'streak-3', 'streak-7', 'weekend'])
  expect(progress(w.store).counters).toMatchObject({ prompts: 42, bestStreak: 7, nightOwl: 1, weekend: 1 })
  expect(w.toasts).toEqual(['🏆 Unlocked 4: 🦉 Night owl, 🏖 Weekend warrior, 🔥 On a roll, 📅 Week-long streak'])
})

test('another session saving meanwhile is added to, not overwritten', async ($, on) => {
  const w = world(on, { stored: { counters: { prompts: 5 }, unlocked: { 'first-prompt': 1 } } })
  await prompt($)
  await w.clock.advance(3_000)
  expect(progress(w.store).counters.prompts).toBe(6)
  w.store.set('progress', { counters: { prompts: 20, commits: 3 }, unlocked: { 'first-prompt': 1, 'first-commit': 2 } })
  await prompt($)
  await w.clock.advance(3_000)
  expect(progress(w.store).counters).toMatchObject({ prompts: 21, commits: 3 })
  expect(Object.keys(progress(w.store).unlocked).sort()).toEqual(['first-commit', 'first-prompt'])
})

test('/achievements opens a grid of cards with progress bars and a filter', async ($, on) => {
  const stored = { counters: { prompts: 3, commits: 4 }, unlocked: { 'first-prompt': NOON - 2 * DAY, 'first-commit': NOON - 3_600_000 } }
  world(on, { stored })
  expect((await $.command.run({ command: 'achievements', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })).text).toBe(
    '🏆 2 of 26 achievements unlocked.',
  )

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PLUGIN, props: PANE })
    expect(await ui.find({ type: 'Text', text: /2\/26 unlocked/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Latest: 📝 First commit · 1 h ago' })).toBeDefined()
    expect((await ui.find({ key: 'card:first-prompt' }))?.text).toContain('✓ unlocked 2 days ago')
    expect((await ui.find({ key: 'card:commits-10' }))?.text).toContain('████░░░░░░ 4/10')
    expect((await ui.findAll({ type: 'Box' })).filter(box => box.key?.startsWith('row:'))).toHaveLength(9)

    await ui.select({ key: 'filter', value: 'unlocked' })
    expect((await ui.findAll({ type: 'Box' })).filter(box => box.key?.startsWith('card:')).map(box => box.key)).toEqual(['card:first-prompt', 'card:first-commit'])
    await ui.select({ key: 'filter', value: 'all' })
    await ui.unmount()
  }
})

test('without a pane, /achievements lists them in the transcript', { options: { sound: false } }, async ($, on) => {
  const w = world(on, { isPlaced: false })
  await prompt($)
  await w.clock.settle()
  expect(w.sounds).toEqual([])
  const text = (await $.command.run({ command: 'achievements', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).text ?? ''
  expect(text).toStartWith('🏆 1 of 26 achievements unlocked\n✓ 👋 Hello, Claude: Send your first prompt (just now)\n· 💬 Regular: Send 100 prompts (1/100)')
})

test('with mods-hub: commit-composer\'s commits, test-watch\'s runs and CI runs count, and an unlock is a success notice', async ($, on) => {
  const { clock, store, toasts } = world(on)
  const hub = fakeHub(on, {}, clock)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(1_500) // the hello waits for session.start to return (afterStart)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: [], consumes: ['git.commit', 'test.result', 'ci.result'] }])

  const at = clock.now() + 1
  hub.events.push(
    { topic: 'git.commit', source: 'commit-composer', at, data: { sha: 'abc', message: 'feat: x', branch: 'main', files: 1 } },
    { topic: 'test.result', source: 'test-watch', at, data: { runner: 'vitest', outcome: 'failed', passed: 1, failed: 1 } },
    { topic: 'test.result', source: 'test-watch', at, data: { runner: 'vitest', outcome: 'passed', passed: 2, failed: 0 } },
    // The hub's own report of a Bash run, which the tool hook counts already.
    { topic: 'test.result', source: 'mods-hub', at, data: { runner: 'jest', outcome: 'passed', passed: 2, failed: 0 } },
    { topic: 'ci.result', source: 'ci-watch', at, data: { provider: 'github', workflow: 'test', outcome: 'passed' } },
  )
  await clock.advance(15_000)
  await clock.settle()

  expect(progress(store).counters).toMatchObject({ commits: 1, greenRuns: 2, redToGreen: 1 })
  expect(Object.keys(progress(store).unlocked)).toEqual(expect.arrayContaining(['first-commit', 'green-1']))
  expect(toasts).toEqual([])
  expect(hub.notified[0]?.level).toBe('success')
  expect(hub.notified[0]?.title).toContain('🏆 Unlocked 2:')
})
