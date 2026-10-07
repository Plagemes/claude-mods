import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

const user = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const claude = (text: string): SessionMessage => ({ role: 'assistant', text, toolUses: [] })

// Stands for the engine: a transcript the test edits and a clipboard that records what it is given.
const engine = (on: On, messages: SessionMessage[], clipboard: { isCopied: boolean } = { isCopied: true }) => {
  const state = { messages, copied: [] as string[], commands: [] as string[] }
  on('session.messages', () => ({ value: state.messages }))
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', (_$, e) => {
    state.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.copy', (_$, e) => {
    state.copied.push(e.text)
    return { value: clipboard.isCopied ? { isCopied: true } : { isCopied: false, reason: 'no-surface' } }
  })
  return state
}

const run = async ($: Engine, command: string, args = '') => {
  const { text } = await $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  return text ?? ''
}

test('/links lists each URL once, in order, with who mentioned it', async ($, on) => {
  engine(on, [
    user('Read https://example.com/docs and https://github.com/acme/app/issues/7 please'),
    claude('The docs at https://example.com/docs/ say X. See also [the guide](https://guide.dev/start).'),
  ])

  const listed = await run($, 'links')

  expect(listed).toBe(
    [
      '🔗 Links in this conversation (3)',
      '1. https://example.com/docs — you + Claude',
      '2. https://github.com/acme/app/issues/7 — you',
      '3. https://guide.dev/start — Claude',
      'Copy them all with /links-copy.',
    ].join('\n'),
  )
})

test('strips prose punctuation but keeps balanced parentheses', async ($, on) => {
  engine(on, [
    claude(
      [
        'Check (https://a.dev/x).',
        'Or https://en.wikipedia.org/wiki/Foo_(bar), then **https://b.dev/y**!',
        'Also <https://c.dev/z> and "https://d.dev/w?q=1&r=2;".',
      ].join(' '),
    ),
  ])

  const listed = await run($, 'links')

  expect(listed).toContain('1. https://a.dev/x —')
  expect(listed).toContain('2. https://en.wikipedia.org/wiki/Foo_(bar) —')
  expect(listed).toContain('3. https://b.dev/y —')
  expect(listed).toContain('4. https://c.dev/z —')
  expect(listed).toContain('5. https://d.dev/w?q=1&r=2 —')
})

test('ignores rows the engine injected, and says so when there are no links', async ($, on) => {
  const state = engine(on, [
    user('<system-reminder>See https://docs.claude.com/en/docs</system-reminder>'),
    user('<local-command-stdout>🔗 https://old.dev/list</local-command-stdout>'),
    claude('No links in this answer.'),
  ])

  expect(await run($, 'links')).toBe('link-vault: no links in this conversation yet.')

  state.messages.push(user('now https://real.dev/page'))
  expect(await run($, 'links')).toContain('1. https://real.dev/page — you')
})

test('/links takes a filter', async ($, on) => {
  engine(on, [claude('https://github.com/a/b https://docs.rs/serde https://github.com/c/d')])

  const listed = await run($, 'links', 'GitHub')

  expect(listed).toContain('(2)')
  expect(listed).not.toContain('docs.rs')
  expect(await run($, 'links', 'nothing-here')).toBe('link-vault: no links matching "nothing-here".')
})

test('/links-copy copies the URLs one per line', async ($, on) => {
  const state = engine(on, [user('https://a.dev/1'), claude('and https://b.dev/2')])

  expect(await run($, 'links-copy')).toBe('🔗 Copied 2 links to the clipboard.')
  expect(state.copied).toEqual(['https://a.dev/1\nhttps://b.dev/2'])
})

test('/links-copy prints the list when no clipboard is reachable', async ($, on) => {
  engine(on, [claude('https://a.dev/1')], { isCopied: false })

  expect(await run($, 'links-copy')).toBe('link-vault: no clipboard here (no-surface). The links:\nhttps://a.dev/1')
})

test('registers /links and /links-copy when the session starts', async ($, on) => {
  const state = engine(on, [])

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  expect(state.commands.sort()).toEqual(['links', 'links-copy'])
})
