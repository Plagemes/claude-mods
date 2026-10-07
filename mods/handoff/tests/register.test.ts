import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { composeNote, missingSections, sectionsOf, stampOf } from '../hooks/note'

const ROOT = '/work/shop'
const NOW = new Date(2026, 9, 7, 13, 42).getTime()
const NOTE = [
  'Here is the note.',
  '## Goal',
  'Make checkout totals round half-cents up.',
  '## Status',
  'Fix written, tests pending.',
  '## What changed',
  '- `src/cart/total.ts`: banker rounding replaced.',
  '## Next steps',
  '1. Run `npm test -- total`.',
  '## Gotchas',
  'Currency API mocks are stale.',
  '## How to verify',
  '`npm test`',
].join('\n')
const PANE_PROPS = {
  title: 'Handoff',
  isFocused: false,
  bodyColumns: 90,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}
const NO_USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const handoff = (args = '') => ({
  command: 'handoff',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 160 },
})

type World = { forks: string[]; files: Map<string, string>; copies: string[] }
type Setup = { fork?: 'nothing'; repo?: boolean; existing?: string[] }

const world = (on: On, setup: Setup = {}): World => {
  const state: World = { forks: [], files: new Map((setup.existing ?? []).map(path => [path, 'old'])), copies: [] }
  mock.clock(on, { now: NOW })
  on('process.run', ($, e) => {
    const args = e.argv.slice(1).join(' ')
    const out = (stdout: string) => ({ value: { exitCode: setup.repo === false ? 128 : 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (args.startsWith('rev-parse')) return out('fix/rounding\n')
    if (args.startsWith('status')) return out(' M src/cart/total.ts\n?? notes.md\n')
    if (args.startsWith('diff')) return out(' src/cart/total.ts | 4 ++--\n 1 file changed\n')
    return out('a1b2c3d fix: rounding\n')
  })
  on('model.fork', ($, e) => {
    state.forks.push(e.prompt)
    return setup.fork === 'nothing'
      ? { value: { isAnswered: false, reason: 'nothing-to-fork' } }
      : { value: { isAnswered: true, text: NOTE, usage: NO_USAGE } }
  })
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 'sess-123' }))
  on('fs.exists', ($, e) => ({ value: state.files.has(e.path) }))
  on('fs.write', ($, e) => {
    state.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    state.copies.push(e.text)
    return { value: { isCopied: true } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  return state
}

test('the note keeps the six sections under a dated header', async () => {
  expect(stampOf(NOW)).toBe('2026-10-07-1342')
  const sections = sectionsOf(NOTE)
  expect(sections.startsWith('## Goal')).toBe(true)
  expect(missingSections(sections)).toEqual([])
  expect(missingSections('## Goal\nx')).toEqual(['Status', 'What changed', 'Next steps', 'Gotchas', 'How to verify'])
  const note = composeNote(sections, { when: NOW, branch: 'main', sessionId: 's1' })
  expect(note.startsWith('# Handoff · 2026-10-07 13:42\n\nBranch `main` · session `s1`\n\n## Goal')).toBe(true)
  expect(note).toContain('claude --resume s1')
})

test('/handoff forks the session with git facts, saves the note and copies it', async ($, on) => {
  const state = world(on)
  const ran = await $.command.run(handoff('stress the stale mocks'))
  expect(ran.text).toBe('Wrote .claude/handoff/2026-10-07-1342.md and copied it to the clipboard.')

  expect(state.forks[0]).toContain('Branch: fix/rounding')
  expect(state.forks[0]).toContain(' M src/cart/total.ts')
  expect(state.forks[0]).toContain('The author adds: stress the stale mocks')
  expect(state.forks[0]).toContain('## How to verify')

  const saved = state.files.get(`${ROOT}/.claude/handoff/2026-10-07-1342.md`) ?? ''
  expect(saved).toContain('# Handoff · 2026-10-07 13:42')
  expect(saved).toContain('## Next steps\n1. Run `npm test -- total`.')
  expect(saved).not.toContain('Here is the note.')
  expect(state.copies).toEqual([saved])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'handoff', surface, component: 'Pane', requestId: 'handoff', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: 'Saved to .claude/handoff/2026-10-07-1342.md' })).toBeDefined()
    expect((await ui.find({ key: 'note' }))?.text).toContain('Currency API mocks are stale.')
    await ui.press({ key: 'copy' })
    await ui.unmount()
  }
  expect(state.copies).toHaveLength(3)
})

test('a second note in the same minute gets its own file; outside git it still works', async ($, on) => {
  const state = world(on, { repo: false, existing: [`${ROOT}/.claude/handoff/2026-10-07-1342.md`] })
  const ran = await $.command.run(handoff())
  expect(ran.text).toContain('Wrote .claude/handoff/2026-10-07-1342-2.md')
  expect(state.forks[0]).not.toContain('Repository facts')
  expect(state.files.get(`${ROOT}/.claude/handoff/2026-10-07-1342-2.md`)).toContain('session `sess-123`')
})

test('nothing to hand off: no file, no copy', async ($, on) => {
  const state = world(on, { fork: 'nothing' })
  const ran = await $.command.run(handoff())
  expect(ran.text).toBe('Nothing to hand off yet: this conversation has no work in it.')
  expect([...state.files.keys()]).toEqual([])
  expect(state.copies).toEqual([])
})

test('copying can be turned off, and the folder moved', { options: { copy: false, dir: 'docs/handoffs/' } }, async ($, on) => {
  const state = world(on)
  const ran = await $.command.run(handoff())
  expect(ran.text).toBe('Wrote docs/handoffs/2026-10-07-1342.md.')
  expect(state.copies).toEqual([])
})
