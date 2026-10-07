import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { CommandRunInput, On, RenderPropsOf, SessionMessage, TurnCompleteInput } from 'claude-code'

import { fakeHub } from './hub'

const ROOT = '/home/me/shop'
const KEY = `brief:${ROOT}`
const NOW = Date.UTC(2026, 9, 7, 12)
const HOUR = 3_600_000

const PREVIOUS = {
  sessionId: 'old-session',
  savedAt: NOW - 2 * HOUR,
  branch: 'feat/orders',
  prompts: ['Add pagination to the orders API', 'Also cover the admin endpoint'],
  files: ['src/orders.ts', 'src/admin.ts', 'src/api.ts', 'test/orders.test.ts'],
  todos: ['Document the cursor parameter'],
  lastAnswer: 'Pagination works for /orders; the admin endpoint still needs tests.',
}

const MESSAGES: SessionMessage[] = [
  { role: 'user', text: 'Rename the Order model to Purchase', toolUses: [] },
  {
    role: 'assistant',
    text: 'Renamed it in two files.\nDetails below.',
    toolUses: [
      { tool_use_id: 'a', tool: 'Edit', input: { file_path: `${ROOT}/src/order.ts` }, text: 'ok' },
      { tool_use_id: 'b', tool: 'Edit', input: { file_path: `${ROOT}/src/db.ts` }, text: 'ok' },
      { tool_use_id: 'c', tool: 'Edit', input: { file_path: `${ROOT}/src/order.ts` }, text: 'ok' },
      { tool_use_id: 'd', tool: 'TodoWrite', input: { todos: [{ content: 'Migrate the table', status: 'in_progress', activeForm: 'Migrating' }] }, text: 'ok' },
    ],
  },
]

const BAND: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
}

type World = { prompts: { text: string; asUser: boolean }[]; store: Map<string, unknown>; clock: MockClock }

/** A project with `stored` saved by an earlier session; this session is "new-session". */
function world(on: On, stored: Record<string, unknown> = {}): World {
  const seen: World = { prompts: [], store: new Map(Object.entries(stored)), clock: mock.clock(on, { now: NOW }) }
  on('store.get', ($, e) => ({ value: seen.store.get(e.key) }))
  on('store.set', ($, e) => {
    seen.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 'new-session' }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: 'feat/rename\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('prompt.submit', ($, e) => {
    seen.prompts.push({ text: e.text, asUser: e.origin.kind === 'plugin' && e.origin.asUser === true })
    return { text: e.text }
  })
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'engine band' }))
  return seen
}

async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
}

const typed: CommandRunInput = {
  command: 'resume-brief',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
}

/** Box props that size a box: the engine refuses its own nodes under any of them, and the band then disappears. */
const SIZE_PROPS = ['width', 'minWidth', 'maxWidth', 'height', 'minHeight', 'maxHeight', 'flexBasis']
type DrawnNode = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

/** The elements above the first Text showing `text`, outermost first; undefined when the tree draws no such Text. */
const ancestorsOf = (node: unknown, text: string, above: DrawnNode[] = []): DrawnNode[] | undefined => {
  if (typeof node !== 'object' || node === null) return undefined
  const element = node as DrawnNode
  const children = element.children ?? []
  if (element.type === 'Text' && children.includes(text)) return above
  for (const child of children) {
    const found = ancestorsOf(child, text, [...above, element])
    if (found !== undefined) return found
  }
  return undefined
}
/** The size props set on any Box above the engine's band; a line says so when the band is not drawn at all. */
const sizedAbove = (tree: unknown): string[] => {
  const above = ancestorsOf(tree, 'engine band')
  if (above === undefined) return ['no engine band drawn']
  return above.flatMap(box => (box.type === 'Box' ? SIZE_PROPS.filter(prop => box.props?.[prop] !== undefined).map(prop => `Box ${prop}`) : []))
}

test('shows the last session above the prompt and Continue resumes it', async ($, on) => {
  const seen = world(on, { [KEY]: PREVIOUS })
  await start($)
  for (const surface of ['terminal', 'desktop'] as const) {
    if (surface === 'desktop') await $.command.run(typed)
    const band = await $.ui.mount({ plugin: 'resume-brief', surface, component: 'AbovePrompt', props: BAND })

    expect((await band.find({ type: 'Text', text: /Last session/ }))?.text).toContain('2 h ago · feat/orders')
    expect((await band.find({ type: 'Text', text: /You asked/ }))?.text).toContain('Also cover the admin endpoint')
    expect((await band.find({ type: 'Text', text: /Edited/ }))?.text).toBe('Edited orders.test.ts, api.ts, admin.ts +1 · 1 open todo')

    await band.press({ key: 'continue' })
    expect(await band.find({ key: 'continue' })).toBeUndefined()
    const prompt = seen.prompts.at(-1)
    expect(prompt?.asUser).toBe(true)
    expect(prompt?.text).toContain('Continue where we left off. In the last session (on branch feat/orders, 2 h ago):')
    expect(prompt?.text).toContain('- Todos still open: Document the cursor parameter')
    await band.unmount()
  }
})

test('saves a brief after each turn and at exit, for the next session', async ($, on) => {
  const seen = world(on)
  await start($)
  const turn: TurnCompleteInput = { answer: 'Renamed.', durationMs: 1_000, isAborted: false, turnId: 't', reason: 'answer' }

  await $.turn.complete(turn)
  await seen.clock.advance(0)
  expect(seen.store.get(KEY)).toMatchObject({ sessionId: 'new-session', branch: 'feat/rename' })
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'new-session', resume: { id: 'new-session' } })

  expect(seen.store.get(KEY)).toEqual({
    sessionId: 'new-session',
    savedAt: NOW,
    branch: 'feat/rename',
    prompts: ['Rename the Order model to Purchase'],
    files: ['src/db.ts', 'src/order.ts'],
    todos: ['Migrate the table'],
    lastAnswer: 'Renamed it in two files.',
  })
})

test('Dismiss and typing a prompt hide the band; /resume-brief brings it back', async ($, on) => {
  const seen = world(on, { [KEY]: PREVIOUS })
  await start($)
  const band = await $.ui.mount({ plugin: 'resume-brief', surface: 'terminal', component: 'AbovePrompt', props: BAND })

  await band.press({ key: 'dismiss' })
  expect(await band.find({ key: 'continue' })).toBeUndefined()
  expect((await band.find({ type: 'Text' }))?.text).toBe('engine band')

  const shown = await $.command.run(typed)
  expect(shown.text).toContain('Also cover the admin endpoint')
  expect(await band.find({ key: 'continue' })).toBeDefined()

  await $.prompt.submit({ text: 'something else', wait: false, origin: { kind: 'composer' } })
  expect(await band.find({ key: 'continue' })).toBeUndefined()
  expect(seen.prompts.map(one => one.text)).toEqual(['something else'])
})

test('stays hidden for a brief older than maxAgeDays', { options: { maxAgeDays: 1 } }, async ($, on) => {
  world(on, { [KEY]: { ...PREVIOUS, savedAt: NOW - 3 * 24 * HOUR } })
  await start($)
  const band = await $.ui.mount({ plugin: 'resume-brief', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ key: 'continue' })).toBeUndefined()
  expect((await $.command.run(typed)).text).toContain('No earlier session')
})

test('does not show a brief of the session being resumed', async ($, on) => {
  world(on, { [KEY]: { ...PREVIOUS, sessionId: 'new-session' } })
  await start($)
  const band = await $.ui.mount({ plugin: 'resume-brief', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ key: 'continue' })).toBeUndefined()
})

test('regression: the brief band keeps the bands beneath it on screen', async ($, on) => {
  world(on, { [KEY]: PREVIOUS })
  await start($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'resume-brief', surface, component: 'AbovePrompt', props: BAND })
    expect(await band.find({ key: 'continue' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    await band.unmount()
  }
})

test('the engine band is not drawn under a Box with a size prop', async ($, on) => {
  world(on, { [KEY]: PREVIOUS })
  await start($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'resume-brief', surface, component: 'AbovePrompt', props: BAND })
    expect(await band.find({ key: 'continue' })).toBeDefined()
    expect(sizedAbove(await band.drawn())).toEqual([])
    await band.unmount()
  }
})

test('with mods-hub: warns about other sessions open on the project and passes on decisions they recorded since', async ($, on) => {
  const seen = world(on, { [KEY]: PREVIOUS })
  const hub = fakeHub(on)
  const SESSIONS = {
    'new-session': { id: 'new-session', cwd: ROOT, lastSeen: NOW, events: [] },
    'web-session': {
      id: 'web-session',
      cwd: `${ROOT}/web`,
      lastSeen: NOW,
      events: [
        { topic: 'decision.recorded', at: NOW - 3 * HOUR, data: { title: 'Too old: before the brief' } },
        { topic: 'decision.recorded', at: NOW - HOUR, data: { title: 'Use cursor pagination' } },
      ],
    },
    'blog-session': { id: 'blog-session', cwd: '/home/me/blog', lastSeen: NOW, events: [{ topic: 'decision.recorded', at: NOW, data: { title: 'Elsewhere' } }] },
  }
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('fs.read', ($, e) => (e.path === '/home/me/.claude/claude-mods/hub/sessions.json' ? { value: JSON.stringify(SESSIONS) } : { deny: 'ENOENT' }))

  await start($)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: [], consumes: ['session.started', 'decision.recorded'] }])
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'resume-brief', surface, component: 'AbovePrompt', props: BAND })
    expect((await band.find({ type: 'Text', text: /other session/ }))?.text).toBe('1 other session is open on this project now')
    await band.unmount()
  }

  const band = await $.ui.mount({ plugin: 'resume-brief', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await band.press({ key: 'continue' })
  expect(seen.prompts.at(-1)?.text).toContain('- Decided since, in other sessions: Use cursor pagination\n')
  await band.unmount()
})

test('without mods-hub there is no other-sessions line', async ($, on) => {
  world(on, { [KEY]: PREVIOUS })
  await start($)
  const band = await $.ui.mount({ plugin: 'resume-brief', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: /other session/ })).toBeUndefined()
  await band.unmount()
})
