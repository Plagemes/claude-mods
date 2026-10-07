import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const run = (args = '') => ({
  command: 'recent',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

const MISSING = '/proj/missing.ts'

/** Other builds of Claude Code have a MultiEdit tool; this build's typings do not know it. */
const MULTI_EDIT = { tool: 'MultiEdit', file_path: '/proj/src/multi.ts', edits: [] } as unknown as Parameters<
  Engine['tool']['call']
>[0]

const answerEngine = (on: On) => {
  on('session.root', () => ({ value: '/proj' }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('tool.call', (_$, e) =>
    e.tool === 'Read' && e.file_path === MISSING ? { result: 'no such file', isError: true } : { result: 'ok' },
  )
}

const recent = async ($: Engine, args = '') => (await $.command.run(run(args))).text ?? ''

test('lists files newest first with R/E markers and project-relative paths', async ($, on) => {
  answerEngine(on)

  await $.tool.call({ tool: 'Read', file_path: '/proj/README.md' })
  await $.tool.call({ tool: 'Read', file_path: '/proj/src/auth.ts' })
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/auth.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/new.ts', content: 'x' })
  await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/elsewhere/n.ipynb', new_source: 'x' })
  await $.tool.call(MULTI_EDIT)

  const text = await recent($)
  const lines = text.split('\n').slice(1)

  expect(text).toContain('5 of 5')
  expect(lines).toEqual([
    '   E  src/multi.ts',
    '   E  /elsewhere/n.ipynb',
    '   E  src/new.ts',
    '  RE  src/auth.ts',
    '  R   README.md',
  ])
})

test('a file touched again moves to the top without being listed twice', async ($, on) => {
  answerEngine(on)

  await $.tool.call({ tool: 'Read', file_path: '/proj/a.ts' })
  await $.tool.call({ tool: 'Read', file_path: '/proj/b.ts' })
  await $.tool.call({ tool: 'Read', file_path: '/proj/a.ts' })

  expect((await recent($)).split('\n').slice(1)).toEqual(['  R   a.ts', '  R   b.ts'])
})

test('keeps the 50 newest files, and /recent <n> shows fewer', async ($, on) => {
  answerEngine(on)

  for (let i = 1; i <= 60; i++) await $.tool.call({ tool: 'Read', file_path: `/proj/f${i}.ts` })

  const lines = (await recent($)).split('\n').slice(1)
  expect(lines).toHaveLength(50)
  expect(lines[0]).toBe('  R   f60.ts')
  expect(lines.at(-1)).toBe('  R   f11.ts')

  expect((await recent($, '3')).split('\n').slice(1)).toHaveLength(3)
})

test('ignores failed calls, other tools and handles an empty history', async ($, on) => {
  answerEngine(on)

  expect(await recent($)).toBe('No files read or edited yet in this session.')

  await $.tool.call({ tool: 'Read', file_path: MISSING })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Grep', pattern: 'x' })
  expect(await recent($)).toBe('No files read or edited yet in this session.')
})

test('/clear forgets the history', async ($, on) => {
  answerEngine(on)

  await $.tool.call({ tool: 'Read', file_path: '/proj/a.ts' })
  await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } })

  expect(await recent($)).toBe('No files read or edited yet in this session.')
})
