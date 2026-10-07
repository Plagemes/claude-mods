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

const added = async ($: Engine, traits: PromptComposeInput['traits'] = []) =>
  (await $.prompt.compose(facts(traits))).sections.slice(1)

const run = async ($: Engine, command: string) =>
  (
    await $.command.run({
      command,
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })
  ).text ?? ''

test('registers /eli5, /normal and /expert when the session starts', async ($, on) => {
  const registered: string[] = []
  engine(on)
  on('command.register', (_$, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  expect(registered).toEqual(['eli5', 'normal', 'expert'])
})

test('adds nothing at the normal level', async ($, on) => {
  engine(on)

  expect(await added($)).toEqual([])
})

test('/eli5 and /expert add their instruction and show the level in the status line', async ($, on) => {
  const statuses = engine(on)

  expect(await run($, 'eli5')).toContain('explain-level: eli5')
  expect(statuses.at(-1)).toBe('explain: eli5')
  const [eli5] = await added($)
  expect(eli5?.id).toBe('explain-level:depth')
  expect(eli5?.scope).toBe('session')
  expect(eli5?.text).toContain('curious beginner')

  expect(await run($, 'expert')).toContain('explain-level: expert')
  expect(statuses.at(-1)).toBe('explain: expert')
  const [expert] = await added($)
  expect(expert?.text).toContain('experienced engineer')
  expect(expert?.text).not.toContain('beginner')
})

test('/normal restores the default and clears the status', async ($, on) => {
  const statuses = engine(on)
  await run($, 'expert')

  expect(await run($, 'normal')).toContain('explain-level: normal')

  expect(statuses.at(-1)).toBeUndefined()
  expect(await added($)).toEqual([])
})

test('starts at the configured level and leaves a bare prompt alone', { options: { startLevel: 'expert' } }, async ($, on) => {
  const statuses = engine(on)
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  expect(statuses.at(-1)).toBe('explain: expert')
  expect((await added($))[0]?.text).toContain('experienced engineer')
  expect(await added($, ['bare'])).toEqual([])
})
