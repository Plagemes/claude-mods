import type { On, PromptComposeInput } from 'claude-code'
import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

/** Answers `$.state` from memory, as the host does: a value and the version it stands at. */
const memoryState = (on: On) => {
  const cells = new Map<string, { value: unknown; version: number }>()
  const keyOf = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}/${e.key}/${e.id ?? ''}`
  on('state.get', (_$, e) => ({ value: cells.get(keyOf(e)) ?? { value: undefined, version: 0 } }))
  on('state.set', (_$, e) => {
    const held = cells.get(keyOf(e)) ?? { value: undefined, version: 0 }
    if (e.ifVersion !== undefined && e.ifVersion !== held.version) {
      return { value: { isSet: false, version: held.version } }
    }
    cells.set(keyOf(e), { value: e.value, version: held.version + 1 })
    return { value: { isSet: true, version: held.version + 1 } }
  })
}

/** Stands in for the engine: memory for `$.state`, the status line recorded, a bare system prompt. */
const engine = (on: On) => {
  const statuses: (string | undefined)[] = []
  memoryState(on)
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
  return statuses
}

const facts = (traits: PromptComposeInput['traits'] = []): PromptComposeInput => ({
  model: 'claude-test',
  promptModel: 'claude-test',
  surfaces: ['terminal'],
  tools: [],
  outputStyle: null,
  traits,
})

const sectionIds = async ($: Engine, traits: PromptComposeInput['traits'] = []) =>
  (await $.prompt.compose(facts(traits))).sections.map(s => s.id)

const concise = async ($: Engine, args = '') =>
  (
    await $.command.run({
      command: 'concise',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })
  ).text ?? ''

test('registers /concise when the session starts', async ($, on) => {
  const registered: string[] = []
  engine(on)
  on('command.register', (_$, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  expect(registered).toEqual(['concise'])
})

test('/concise toggles the brevity instruction and the status line', async ($, on) => {
  const statuses = engine(on)
  expect(await sectionIds($)).toEqual(['intro'])

  expect(await concise($)).toContain('concise-mode: on')
  expect(statuses.at(-1)).toBe('concise')
  expect(await sectionIds($)).toEqual(['intro', 'concise-mode:brevity'])

  expect(await concise($)).toContain('concise-mode: off')
  expect(statuses.at(-1)).toBeUndefined()
  expect(await sectionIds($)).toEqual(['intro'])
})

test('/concise on and /concise off set the mode explicitly', async ($, on) => {
  engine(on)

  await concise($, 'on')
  await concise($, 'on')
  expect(await sectionIds($)).toContain('concise-mode:brevity')

  await concise($, 'OFF')
  expect(await sectionIds($)).not.toContain('concise-mode:brevity')
})

test('the instruction asks for brevity without dropping what the user needs', async ($, on) => {
  engine(on)
  await concise($, 'on')

  const text = (await $.prompt.compose(facts())).sections.at(-1)?.text ?? ''

  expect(text).toContain('as short as the task allows')
  expect(text).toContain('name every file you changed')
})

test('starts on when configured, and leaves a bare prompt alone', { options: { startOn: true } }, async ($, on) => {
  const statuses = engine(on)
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  expect(statuses.at(-1)).toBe('concise')
  expect(await sectionIds($)).toEqual(['intro', 'concise-mode:brevity'])
  expect(await sectionIds($, ['bare'])).toEqual(['intro'])
})
