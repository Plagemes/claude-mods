import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptAutocompleteInput, PromptAutocompleteResult, PromptComposeInput } from 'claude-code'

const ROOT = '/work/shop'

const facts: PromptComposeInput = {
  model: 'claude-opus',
  promptModel: 'claude-opus',
  surfaces: ['terminal'],
  tools: ['Bash'],
  outputStyle: null,
  traits: [],
}

/** The engine beneath the plugin: a project root, a store, a status line and the base prompt. */
const world = (on: On, saved: Record<string, unknown> = {}) => {
  const store = new Map(Object.entries(saved))
  const statuses: (string | undefined)[] = []
  on('session.root', () => ({ value: ROOT }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
  return { store, statuses }
}

const run = ($: Engine, command: string, args = '') =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

const personaSection = async ($: Engine) =>
  (await $.prompt.compose(facts)).sections.find(section => section.id === 'persona-switch:persona')

test('/persona adds the persona to the system prompt, shows it and remembers it per project', async ($, on) => {
  const { store, statuses } = world(on)

  expect(await personaSection($)).toBeUndefined()
  const on1 = await run($, 'persona', 'Security Auditor')
  expect(on1.text).toContain('Security auditor is on')

  const section = await personaSection($)
  expect(section?.scope).toBe('session')
  expect(section?.text).toContain('# Active persona: Security auditor')
  expect(section?.text).toContain("attacker's eyes")
  expect(statuses.at(-1)).toBe('◆ Security auditor')
  expect(store.get(`active:${ROOT}`)).toBe('security-auditor')

  const off = await run($, 'persona', 'off')
  expect(off.text).toContain('persona off')
  expect(await personaSection($)).toBeUndefined()
  expect(statuses.at(-1)).toBeUndefined()
  expect(store.has(`active:${ROOT}`)).toBe(false)
})

test('restores the project persona when a session starts', async ($, on) => {
  const { statuses } = world(on, { [`active:${ROOT}`]: 'teacher' })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(statuses.at(-1)).toBe('◆ Teacher')
  expect((await personaSection($))?.text).toContain('# Active persona: Teacher')
})

test(
  'lists built-in and custom personas, and refuses unknown names',
  {
    options: {
      customPersonas: JSON.stringify({
        'Rust Mentor': { label: 'Rust mentor', summary: 'Idiomatic Rust, explained.', prompt: 'Prefer ownership over cloning.' },
        terse: 'Answer in at most three sentences.',
      }),
    },
  },
  async ($, on) => {
    world(on)
    const listed = await run($, 'personas')
    for (const name of ['reviewer', 'architect', 'teacher', 'pair-programmer', 'security-auditor', 'product-minded', 'rust-mentor', 'terse']) {
      expect(listed.text).toContain(name)
    }
    expect(listed.text).toContain('Idiomatic Rust, explained. (custom)')

    expect((await run($, 'persona', 'pirate')).text).toContain('no persona "pirate"')
    expect(await personaSection($)).toBeUndefined()

    await run($, 'persona', 'rust-mentor')
    expect((await personaSection($))?.text).toContain('Prefer ownership over cloning.')
    expect((await run($, 'personas')).text).toContain('● rust-mentor')
  },
)

test('completes persona names after /persona', async ($, on) => {
  world(on)
  on('prompt.autocomplete', () => ({ suggestions: [] }))
  const typed = '/persona pa'
  // The typeahead's event: raised by the engine as the person types; the test engine carries it untyped.
  const typeahead = $.prompt as unknown as { autocomplete: (e: PromptAutocompleteInput) => Promise<PromptAutocompleteResult> }
  const { suggestions } = await typeahead.autocomplete({ text: typed, cursor: typed.length, token: 'pa', start: 9 })
  expect(suggestions.map(suggestion => suggestion.text)).toEqual(['pair-programmer'])
})
