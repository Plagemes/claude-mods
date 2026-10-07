import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

type World = { files: Record<string, string>; toasts: string[]; failing: Set<string> }

/** `files` is the project as it stands after each call (the engine bottom writes nothing). */
const answerEngine = (on: On, files: Record<string, string> = {}): World => {
  const world: World = { files, toasts: [], failing: new Set() }
  on('session.root', () => ({ value: '/proj' }))
  on('fs.read', (_$, e) => {
    const text = world.files[e.path]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('tool.call', (_$, e) =>
    'file_path' in e && world.failing.has(String(e.file_path)) ? { result: 'no', isError: true } : { result: 'ok' },
  )
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('ui.toast', (_$, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  return world
}

let turnCount = 0

const turn = async ($: Engine, work: () => Promise<unknown>) => {
  const turnId = `turn-${(turnCount += 1)}`
  await $.turn.start({ text: 'go', turnId })
  await work()
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId })
}

const todos = async ($: Engine, args = '') =>
  (
    await $.command.run({
      command: 'todos-added',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 100 },
    })
  ).text ?? ''

test('toasts the count at turn end and /todos-added lists file:line items for an Edit', async ($, on) => {
  const world = answerEngine(on, {
    '/proj/src/a.ts': 'const a = 1\n\nfunction run() {\n  // TODO: handle errors\n  // FIXME retry\n  return a\n}\n',
  })

  await turn($, () =>
    $.tool.call({
      tool: 'Edit',
      file_path: '/proj/src/a.ts',
      old_string: '  return a',
      new_string: '  // TODO: handle errors\n  // FIXME retry\n  return a',
    }),
  )

  expect(world.toasts).toEqual([
    '2 markers added this turn (1 TODO, 1 FIXME). /todos-added lists them',
  ])
  expect((await todos($)).split('\n')).toEqual([
    'Markers added in the latest turn that added any (2):',
    '  src/a.ts:4  // TODO: handle errors',
    '  src/a.ts:5  // FIXME retry',
  ])
})

test('a Write counts only the markers the old file did not have', async ($, on) => {
  const world = answerEngine(on, { '/proj/lib.py': '# TODO: old one\nx = 1\n' })

  await turn($, () =>
    $.tool.call({
      tool: 'Write',
      file_path: '/proj/lib.py',
      content: '# TODO: old one\nx = 1\n# HACK: new\n# XXX also new\n',
    }),
  )

  expect(world.toasts).toEqual([
    '2 markers added this turn (1 HACK, 1 XXX). /todos-added lists them',
  ])
  expect((await todos($)).split('\n').slice(1)).toEqual(['  lib.py:3  # HACK: new', '  lib.py:4  # XXX also new'])
})

test('ignores edits that only keep a marker, failed edits, and text with no marker', async ($, on) => {
  const world = answerEngine(on, { '/proj/a.ts': '// TODO: keep\n' })
  world.failing.add('/proj/b.ts')

  await turn($, async () => {
    await $.tool.call({ tool: 'Edit', file_path: '/proj/a.ts', old_string: '// TODO: keep', new_string: '// TODO: keep' })
    await $.tool.call({ tool: 'Edit', file_path: '/proj/b.ts', old_string: 'a', new_string: '// TODO: lost' })
    await $.tool.call({ tool: 'Edit', file_path: '/proj/c.ts', old_string: 'a', new_string: 'const todoList = []' })
  })

  expect(world.toasts).toHaveLength(0)
  expect(await todos($)).toBe('No TODO, FIXME, HACK or XXX markers have been added in this session.')
})

test('a new file written with markers reports exact lines; /todos-added all spans turns', async ($, on) => {
  const world = answerEngine(on)

  await turn($, () =>
    $.tool.call({ tool: 'Write', file_path: '/proj/new.go', content: 'package x\n\n// HACK: temporary\nfunc f() {}\n' }),
  )
  expect(world.toasts[0]).toContain('1 marker added')
  expect(await todos($)).toContain('new.go:3  // HACK: temporary')

  world.files['/proj/z.ts'] = 'a\n// XXX check\n'
  await turn($, () =>
    $.tool.call({ tool: 'Edit', file_path: '/proj/z.ts', old_string: 'a', new_string: 'a\n// XXX check' }),
  )

  expect(world.toasts).toHaveLength(2)
  const latest = await todos($)
  expect(latest).toContain('z.ts:2  // XXX check')
  expect(latest).not.toContain('new.go')

  const all = await todos($, 'all')
  expect(all).toContain('new.go:3')
  expect(all).toContain('z.ts:2')
})

test('a turn without additions raises no toast and keeps the last list', async ($, on) => {
  const world = answerEngine(on, { '/proj/a.ts': 'x\n// TODO: later\n' })

  await turn($, () =>
    $.tool.call({ tool: 'Edit', file_path: '/proj/a.ts', old_string: 'x', new_string: 'x\n// TODO: later' }),
  )
  await turn($, async () => undefined)

  expect(world.toasts).toHaveLength(1)
  expect(await todos($)).toContain('a.ts:2')
})
