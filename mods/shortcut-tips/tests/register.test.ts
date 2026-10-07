import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { TIPS, dayKey, positionOf, tipAt } from '../hooks/tips'

const DAY = 86_400_000
const START = Date.parse('2026-10-07T12:00:00Z')

/** The engine beneath the plugin: a clock and a store in memory, the registered commands and the toasts recorded. */
const world = (on: On, stored: Record<string, unknown> = {}) => {
  const clock = mock.clock(on, { now: START })
  mock.store(on, stored)
  const seen = { toasts: [] as string[], registered: [] as string[], advance: clock.advance }
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_$, e) => {
    seen.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  return seen
}

const startSession = ($: Engine, isInteractive = true) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive })

const tip = async ($: Engine): Promise<string> =>
  (
    await $.command.run({
      command: 'tip',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })
  ).text ?? ''

test('registers /tip and toasts one tip when the first session of the day starts', async ($, on) => {
  const seen = world(on)

  await startSession($)

  expect(seen.registered).toEqual(['tip'])
  expect(seen.toasts).toEqual([`💡 ${tipAt(0).text}  ·  /tip for another`])
})

test('shows at most one tip a day, and the next one on the next day', async ($, on) => {
  const seen = world(on)

  await startSession($)
  await startSession($)
  expect(seen.toasts).toHaveLength(1)

  await seen.advance(DAY)
  await startSession($)
  expect(seen.toasts).toHaveLength(2)
  expect(seen.toasts[1]).toContain(tipAt(1).text)
})

test('stays quiet in a non-interactive run, but still registers /tip', async ($, on) => {
  const seen = world(on)

  await startSession($, false)

  expect(seen.toasts).toEqual([])
  expect(seen.registered).toEqual(['tip'])
})

test('/tip shows the next tip each time, wraps around, and does not use up the daily tip', async ($, on) => {
  const seen = world(on, { next: TIPS.length - 1 })

  expect(await tip($)).toBe(`Tip ${TIPS.length} of ${TIPS.length}: ${tipAt(TIPS.length - 1).text}`)
  expect(await tip($)).toBe(`Tip 1 of ${TIPS.length}: ${tipAt(0).text}`)
  expect(await tip($)).toBe(`Tip 2 of ${TIPS.length}: ${tipAt(1).text}`)

  await startSession($)
  expect(seen.toasts).toEqual([`💡 ${tipAt(2).text}  ·  /tip for another`])
})

test('the rotation survives in the store, so tips do not repeat from one day to the next', async ($, on) => {
  const seen = world(on, { next: 5, shownOn: dayKey(START - DAY) })

  await startSession($)

  expect(seen.toasts[0]).toContain(tipAt(5).text)
})

test('the daily toast can be turned off', { options: { showAtStart: false } }, async ($, on) => {
  const seen = world(on)

  await startSession($)

  expect(seen.toasts).toEqual([])
  expect(await tip($)).toContain('Tip 1 of')
})

test('a broken store means no tip, not a failed session start', async ($, on) => {
  mock.clock(on, { now: START })
  const toasts: string[] = []
  on('store.get', () => ({ deny: 'EIO' }))
  on('store.set', () => ({ deny: 'EIO' }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await startSession($)

  expect(toasts).toEqual([])
  expect(await tip($)).toBe(`Tip 1 of ${TIPS.length}: ${tipAt(0).text}`)
})

test('positionOf trusts only a whole number in range', () => {
  expect(positionOf(3)).toBe(3)
  expect(positionOf(TIPS.length + 2)).toBe(2)
  for (const junk of [undefined, null, -1, 1.5, '4', Number.NaN]) expect(positionOf(junk)).toBe(0)
})

/** Slash commands that exist in Claude Code 2.1.292, checked against its command definitions. */
const KNOWN_COMMANDS = new Set([
  'rewind', 'btw', 'compact', 'resume', 'clear', 'context', 'rename', 'terminal-setup', 'init', 'memory', 'tasks', 'add-dir',
  'model', 'effort', 'permissions', 'branch', 'hooks', 'skills', 'plugin', 'mcp', 'diff', 'copy', 'color', 'statusline',
  'skill-doctor', 'config', 'usage', 'keybindings', 'export', 'goal', 'recap', 'remote-control', 'focus', 'powerup', 'doctor',
  'release-notes',
])

test('every tip is short, has its own id and names only commands that exist in 2.1.292', () => {
  expect(TIPS.length).toBeGreaterThanOrEqual(40)
  expect(new Set(TIPS.map(item => item.id)).size).toBe(TIPS.length)
  expect(new Set(TIPS.map(item => item.text)).size).toBe(TIPS.length)

  for (const item of TIPS) {
    expect(item.text.length, item.id).toBeLessThanOrEqual(230)
    // `/name` as a command: not a path, not `/<name>` (the skill placeholder) and not a URL.
    for (const [, command] of item.text.matchAll(/(?:^|[\s(])\/([a-z][a-z-]*)(?=[\s).,;:]|$)/g)) {
      expect(KNOWN_COMMANDS.has(command as string), `${item.id}: /${command as string}`).toBe(true)
    }
  }
})

test('commands that are gone in 2.1.292 are not advertised', () => {
  const all = TIPS.map(item => item.text).join('\n')

  for (const gone of ['/agents', '/vim', '/todos', '/mods', '# ']) expect(all).not.toContain(gone)
})
