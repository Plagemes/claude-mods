import { expect, test } from 'claude-code/testing'
import type { On, PromptComposeInput } from 'claude-code'

const ROOT = '/work/shop'

type FakeFile = { text: string; mtimeMs: number }

/** A project tree in memory behind `$.session.root`, `$.fs.stat` and `$.fs.read`; returns the paths read. */
const project = (on: On, files: Map<string, FakeFile>) => {
  const reads: string[] = []
  on('session.root', () => ({ value: ROOT }))
  on('fs.stat', ($, e) => {
    const file = files.get(e.path)
    return file === undefined
      ? { deny: `ENOENT: ${e.path}` }
      : { value: { kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } }
  })
  on('fs.read', ($, e) => {
    reads.push(e.path)
    const file = files.get(e.path)
    return file === undefined ? { deny: `ENOENT: ${e.path}` } : { value: file.text }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  return reads
}

const facts: PromptComposeInput = {
  model: 'claude-opus',
  promptModel: 'claude-opus',
  surfaces: ['terminal'],
  tools: ['Bash', 'Read'],
  outputStyle: null,
  traits: [],
}

const STYLE = '# Shop style\n\n- Use tabs, not spaces.\n- Name React components in PascalCase.\n'

test('adds STYLE.md as a session section and re-reads it only when it changes', async ($, on) => {
  const files = new Map([[`${ROOT}/STYLE.md`, { text: STYLE, mtimeMs: 1000 }]])
  const reads = project(on, files)

  const first = await $.prompt.compose(facts)
  const section = first.sections.at(-1)
  expect(first.sections[0]?.id).toBe('intro')
  expect(section?.id).toBe('house-style:style')
  expect(section?.scope).toBe('session')
  expect(section?.text).toContain('# Project house style')
  expect(section?.text).toContain('Use tabs, not spaces.')

  await $.turn.start({ text: 'hi', turnId: 'turn-1' })
  await $.prompt.compose(facts)
  expect(reads).toHaveLength(1)

  files.set(`${ROOT}/STYLE.md`, { text: '- Prefer early returns.', mtimeMs: 2000 })
  await $.turn.start({ text: 'again', turnId: 'turn-2' })
  const changed = await $.prompt.compose(facts)
  expect(reads).toHaveLength(2)
  expect(changed.sections.at(-1)?.text).toContain('Prefer early returns.')
  expect(changed.sections.at(-1)?.text).not.toContain('Use tabs')
})

test('falls back to the style section of CONTRIBUTING.md and caps its length', { options: { maxChars: 500 } }, async ($, on) => {
  const contributing = [
    '# Contributing',
    'Open an issue first.',
    '## Code style',
    '- Run the formatter before you commit.',
    `- ${'Keep functions small. '.repeat(40)}`,
    '### Naming',
    '- Use camelCase for variables.',
    '## Releasing',
    'Tag the release on main.',
  ].join('\n')
  project(on, new Map([[`${ROOT}/CONTRIBUTING.md`, { text: contributing, mtimeMs: 1 }]]))

  const composed = await $.prompt.compose(facts)
  const text = composed.sections.at(-1)?.text ?? ''
  expect(text).toContain('the style sections of CONTRIBUTING.md')
  expect(text).toContain('Run the formatter')
  expect(text).not.toContain('Open an issue first')
  expect(text).not.toContain('Tag the release')
  expect(text).toContain('more characters of CONTRIBUTING.md were left out')
})

test('/style shows what is injected, or that nothing is', async ($, on) => {
  const files = new Map<string, FakeFile>()
  project(on, files)
  const style = () =>
    $.command.run({
      command: 'style',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 100 },
    })

  const none = await style()
  expect(none.text).toContain('No style guide found')
  expect((await $.prompt.compose(facts)).sections.map(section => section.id)).toEqual(['intro'])

  files.set(`${ROOT}/.claude/style.md`, { text: STYLE, mtimeMs: 5 })
  const shown = await style()
  expect(shown.text).toContain('Injecting .claude/style.md into the system prompt')
  expect(shown.text).toContain('Name React components in PascalCase.')
})
