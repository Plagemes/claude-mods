import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { languageOf, toolsOf } from '../hooks/languages'
import { bars, isoWeekKey, mergeWeeks, recentWeeks } from '../hooks/weeks'

const DAY = 86_400_000
/** Wednesday 7 October 2026, ISO week 2026-W41. */
const START = Date.parse('2026-10-07T12:00:00Z')

/** The engine beneath the plugin: a clock, a store in memory the test can look into, and tool calls that succeed or fail by command. */
const world = (on: On, entries: Record<string, unknown> = {}) => {
  const clock = mock.clock(on, { now: START })
  const store = new Map<string, unknown>(Object.entries(entries))
  const seen = { store, registered: [] as string[], failing: new Set<string>(), isBroken: false, isDenying: false, advance: clock.advance }
  on('store.get', (_$, e) => (seen.isBroken ? { deny: 'EIO' } : { value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('tool.call', (_$, e) => {
    if (seen.isDenying) return { deny: 'refused' }
    const failed = e.tool === 'Bash' && seen.failing.has(e.command)
    return failed ? { isError: true as const, result: 'exit 1', text: 'exit 1' } : { result: 'ok' }
  })
  on('turn.complete', () => ({ text: '' }))
  on('command.register', (_$, e) => {
    seen.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  return seen
}

const edit = ($: Engine, file_path: string) => $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' })
const write = ($: Engine, file_path: string) => $.tool.call({ tool: 'Write', file_path, content: 'x' })
const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })
const endTurn = ($: Engine) => $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't', reason: 'answer' })
const skills = async ($: Engine): Promise<string> =>
  (
    await $.command.run({
      command: 'my-skills',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 100 },
    })
  ).text ?? ''

test('registers /my-skills (the built-in /skills is taken)', async ($, on) => {
  const seen = world(on)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  expect(seen.registered).toEqual(['my-skills'])
})

test('counts edits per language and commands per tool, and shows this week with bars', async ($, on) => {
  world(on)
  await edit($, '/repo/src/a.ts')
  await edit($, '/repo/src/b.tsx')
  await write($, '/repo/src/c.ts')
  await write($, '/repo/scripts/run.py')
  await edit($, '/repo/README.md')
  await bash($, 'git status && npm test')
  await bash($, 'git commit -m x')
  await bash($, 'cd app && docker compose up -d | tee log')
  await endTurn($)

  const text = await skills($)

  expect(text).toContain('This week (2026-W41)')
  expect(text).toContain('  TypeScript  ████████████████████  3')
  expect(text).toContain('  Markdown    ███████               1')
  expect(text).toContain('  Python      ███████               1')
  expect(text).toContain('  git     ████████████████████  2')
  expect(text).toContain('  docker  ██████████            1')
  expect(text).toContain('  npm     ██████████            1')
  expect(text).toContain('Last 8 weeks (2026-W34 to 2026-W41)')
})

test('a call another plugin refused is not counted', async ($, on) => {
  const seen = world(on)
  seen.isDenying = true

  await bash($, 'npm test')
  await edit($, '/repo/src/blocked.ts')

  expect(await skills($)).toContain('Nothing tracked yet')
})

test('a failing command and unknown or generated files are not counted', async ($, on) => {
  const seen = world(on)
  seen.failing.add('npm test')

  await bash($, 'npm test')
  await edit($, '/repo/logo.png')
  await edit($, '/repo/package-lock.lock')
  await bash($, 'ls -la && cat x | grep y')

  expect(await skills($)).toContain('Nothing tracked yet')
})

test('weeks add up across sessions: counts are kept in the store, week by week', async ($, on) => {
  const seen = world(on)
  await edit($, '/repo/a.go')
  await endTurn($)
  expect(seen.store.get('week:2026-W41')).toEqual({ lang: { Go: 1 }, tool: {} })

  await edit($, '/repo/b.go')
  await bash($, 'go test ./...')
  await endTurn($)
  expect(seen.store.get('week:2026-W41')).toEqual({ lang: { Go: 2 }, tool: { go: 1 } })

  await seen.advance(7 * DAY)
  await edit($, '/repo/c.rs')
  await endTurn($)
  expect(seen.store.get('week:2026-W42')).toEqual({ lang: { Rust: 1 }, tool: {} })
  expect(seen.store.get('week:2026-W41')).toEqual({ lang: { Go: 2 }, tool: { go: 1 } })
})

test('shows this week, the last 8 weeks together and a line per week', async ($, on) => {
  const weeks: Record<string, unknown> = {
    'week:2026-W34': { lang: { Python: 10 }, tool: { pip: 2 } },
    'week:2026-W36': { lang: { Python: 5, Go: 1 }, tool: { git: 4 } },
    'week:2026-W40': { lang: { TypeScript: 20 }, tool: { npm: 6, git: 3 } },
    'week:2026-W33': { lang: { Rust: 99 }, tool: { cargo: 99 } },
  }
  world(on, weeks)
  await edit($, '/repo/now.ts')

  const text = await skills($)

  expect(text.startsWith('```\nThis week (2026-W41)\n')).toBe(true)
  expect(text).toContain('Last 8 weeks (2026-W34 to 2026-W41)')
  expect(text).toContain('  TypeScript  ████████████████████  21')
  expect(text).toContain('  Python      ██████████████        15')
  expect(text).not.toContain('Rust')
  expect(text).toContain('  2026-W34  10 edits · 2 commands · Python / pip\n')
  expect(text).toContain('  2026-W35  -\n')
  expect(text).toContain('  2026-W36  6 edits  · 4 commands · Python, Go / git\n')
  expect(text).toContain('  2026-W40  20 edits · 9 commands · TypeScript / npm, git\n')
  expect(text).toContain('  2026-W41  1 edit   · 0 commands · TypeScript / -\n')
  expect(text.trimEnd().endsWith('```')).toBe(true)
})

test('says so when a week is empty but earlier ones are not', async ($, on) => {
  world(on, { 'week:2026-W40': { lang: { Go: 3 }, tool: {} } })

  const text = await skills($)

  expect(text).toContain('Nothing yet this week.')
  expect(text).toContain('  Go  ████████████████████  3')
})

test('the number of rows is configurable', { options: { topCount: 2 } }, async ($, on) => {
  world(on)
  for (const file of ['a.ts', 'b.ts', 'c.ts', 'a.py', 'b.py', 'a.go']) await edit($, `/repo/${file}`)

  const text = await skills($)

  expect(text).toMatch(/^ {2}TypeScript {2}█+ +3$/m)
  expect(text).toMatch(/^ {2}Python {6}█+ +2$/m)
  expect(text).not.toMatch(/^ {2}Go /m)
})

test('the store keeps the newest 60 weeks and a bad entry does not break the report', async ($, on) => {
  const old: Record<string, unknown> = {}
  for (let i = 0; i < 65; i += 1) old[`week:2024-W${String(i + 1).padStart(2, '0')}`] = { lang: { Go: 1 }, tool: {} }
  old['week:2026-W40'] = 'garbage'
  const seen = world(on, old)

  await edit($, '/repo/a.go')
  await endTurn($)

  const weekKeys = [...seen.store.keys()].filter(key => key.startsWith('week:')).sort()
  expect(weekKeys).toHaveLength(60)
  expect(weekKeys.at(-1)).toBe('week:2026-W41')
  expect(weekKeys).not.toContain('week:2024-W01')
  expect(await skills($)).toContain('This week (2026-W41)')
})

test('counts that cannot be written yet wait for the next flush', async ($, on) => {
  const seen = world(on)
  seen.isBroken = true
  await edit($, '/repo/a.ts')
  await endTurn($)
  expect(seen.store.size).toBe(0)

  seen.isBroken = false
  await edit($, '/repo/b.ts')
  await endTurn($)

  expect(seen.store.get('week:2026-W41')).toEqual({ lang: { TypeScript: 2 }, tool: {} })
})

test('isoWeekKey follows ISO 8601 at the year boundaries', () => {
  const key = (year: number, month: number, day: number) => isoWeekKey(new Date(year, month - 1, day, 12).getTime())
  expect(key(2026, 10, 7)).toBe('2026-W41')
  expect(key(2025, 12, 29)).toBe('2026-W01')
  expect(key(2026, 1, 1)).toBe('2026-W01')
  expect(key(2021, 1, 3)).toBe('2020-W53')
  expect(key(2024, 12, 30)).toBe('2025-W01')
  expect(key(2026, 12, 31)).toBe('2026-W53')
  expect(key(2026, 10, 11)).toBe('2026-W41')
  expect(key(2026, 10, 12)).toBe('2026-W42')
})

test('recentWeeks lists the last N weeks, oldest first', () => {
  expect(recentWeeks(START, 3)).toEqual(['2026-W39', '2026-W40', '2026-W41'])
  expect(recentWeeks(Date.parse('2026-01-14T12:00:00Z'), 4)).toEqual(['2025-W52', '2026-W01', '2026-W02', '2026-W03'])
})

test('languageOf and toolsOf', () => {
  expect(languageOf('/r/a.TS')).toBe('TypeScript')
  expect(languageOf('/r/Dockerfile')).toBe('Dockerfile')
  expect(languageOf('/r/Dockerfile.dev')).toBe('Dockerfile')
  expect(languageOf('/r/.gitignore')).toBeUndefined()
  expect(languageOf('/r/noext')).toBeUndefined()
  expect(languageOf('C:\\r\\main.rs')).toBe('Rust')
  expect(languageOf('/r/constructor')).toBeUndefined()

  expect(toolsOf('git status && git diff | head')).toEqual(['git'])
  expect(toolsOf('FOO=1 sudo docker run x; kubectl get pods')).toEqual(['docker', 'kubectl'])
  expect(toolsOf('npx vitest run && python3 -m pytest')).toEqual(['npm', 'python'])
  expect(toolsOf('/usr/bin/git log')).toEqual(['git'])
  expect(toolsOf('echo git | cat')).toEqual([])
  expect(toolsOf('')).toEqual([])
})

test('bars scale to the biggest count and merging adds weeks up', () => {
  expect(bars({ a: 4, b: 2, c: 1 }, 2)).toEqual(['  a  ████████████████████  4', '  b  ██████████            2'])
  expect(mergeWeeks([{ lang: { Go: 1 }, tool: { git: 1 } }, { lang: { Go: 2, Rust: 1 }, tool: {} }])).toEqual({ lang: { Go: 3, Rust: 1 }, tool: { git: 1 } })
})
