import { test, expect } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fakeHub } from './hub'
import { diffSurface, mergeChanges, summarize, surfaceOf } from '../hooks/detect'

const ROOT = '/work/cli'
const CONFIG_BEFORE = [
  "import { readFileSync } from 'node:fs'",
  'export function loadConfig(path: string) {',
  '  return JSON.parse(readFileSync(path, "utf8"))',
  '}',
  'export const LEGACY = process.env.LEGACY_TOKEN',
  '',
].join('\n')
const CONFIG_AFTER = [
  "import { readFileSync } from 'node:fs'",
  'export function loadConfig(path: string, strict = false) {',
  '  return JSON.parse(readFileSync(path, "utf8"))',
  '}',
  'export function parseConfig(text: string) {',
  '  return JSON.parse(text)',
  '}',
  'const url = process.env.API_URL ?? "http://localhost"',
  "program.option('--strict', 'fail on unknown keys')",
  '',
].join('\n')
const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
}
const TURN = { answer: 'done', durationMs: 1200, isAborted: false, turnId: 't1', reason: 'answer' } as const

type Project = { files: Map<string, string>; prompts: { text: string; asUser?: true }[] }

/** A project on a virtual disk; the bottom `tool.call` applies Edit and Write to it as the tools would. */
const project = (on: On, files: Record<string, string>, below = 'nothing beneath'): Project => {
  const state: Project = { files: new Map(Object.entries(files).map(([path, text]) => [`${ROOT}/${path}`, text])), prompts: [] }
  on('session.root', () => ({ value: ROOT }))
  on('fs.exists', ($, e) => ({ value: state.files.has(e.path) }))
  on('fs.read', ($, e) => {
    const text = state.files.get(e.path)
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.list', () => ({
    value: [...state.files.keys()]
      .map(path => path.slice(ROOT.length + 1).split('/')[0] ?? '')
      .map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('tool.call', ($, e) => {
    if (e.tool === 'Write') state.files.set(e.file_path, e.content)
    if (e.tool === 'Edit') state.files.set(e.file_path, (state.files.get(e.file_path) ?? '').replace(e.old_string, e.new_string))
    return { result: { type: 'update' } }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', () => ({ type: 'Box', props: { key: 'below' }, children: [{ type: 'Text', props: {}, children: [below] }] }))
  on('prompt.submit', ($, e) => {
    state.prompts.push({ text: e.text, ...(e.origin.kind === 'plugin' && e.origin.asUser === true ? { asUser: true as const } : {}) })
    return { text: e.text }
  })
  return state
}

test('surface detection finds exports, CLI flags and env vars across languages', async () => {
  const before = surfaceOf('src/config.ts', CONFIG_BEFORE, true)
  const after = surfaceOf('src/config.ts', CONFIG_AFTER, true)
  const changes = diffSurface('src/config.ts', before, after)
  expect(changes.map(c => `${c.change} ${c.kind} ${c.name}`).sort()).toEqual([
    'added env API_URL',
    'added export parseConfig',
    'added flag --strict',
    'changed export loadConfig',
    'removed env LEGACY_TOKEN',
    'removed export LEGACY',
  ])
  expect(summarize(changes)).toBe('3 exports, 1 CLI flag, 2 env vars')

  const python = surfaceOf('pkg/api.py', 'def fetch(url):\n    pass\ndef _private():\n    pass\nTOKEN = os.getenv("API_TOKEN")\n', true)
  expect([...python.keys()]).toEqual(['export:fetch', 'env:API_TOKEN'])
  const go = surfaceOf('cmd/main.go', 'func Run() {}\nfunc helper() {}\nport := os.Getenv("PORT")\nflag.String("addr", "", "--addr to bind")\n', true)
  expect([...go.keys()]).toEqual(['export:Run', 'flag:--addr', 'env:PORT'])
  expect(surfaceOf('src/config.test.ts', CONFIG_AFTER, true).size).toBe(0)
  expect(surfaceOf('src/config.ts', CONFIG_AFTER, false).has('export:parseConfig')).toBe(false)

  const added = [{ kind: 'env' as const, name: 'X', change: 'added' as const, file: 'a.ts' }]
  expect(mergeChanges(added, [{ ...added[0]!, change: 'removed' }])).toEqual([])
})

test('code changes with no doc edit raise the band, and its button asks Claude', async ($, on) => {
  const state = project(on, { 'README.md': '# cli\n', 'src/config.ts': CONFIG_BEFORE })
  await $.turn.start({ text: 'add strict mode', turnId: 't1' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/config.ts`, content: CONFIG_AFTER })
  await $.turn.complete(TURN)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'readme-sync', surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ type: 'Text', text: 'docs untouched after 3 exports, 1 CLI flag, 2 env vars changed' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '− env var LEGACY_TOKEN (src/config.ts)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '~ export loadConfig' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '… 3 more' })).toBeDefined()
    await ui.unmount()
  }

  const band = await $.ui.mount({ plugin: 'readme-sync', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await band.press({ key: 'update' })
  expect(state.prompts).toHaveLength(1)
  expect(state.prompts[0]?.asUser).toBe(true)
  expect(state.prompts[0]?.text).toContain('- added export parseConfig (src/config.ts)')
  expect(state.prompts[0]?.text).toContain('- removed env var LEGACY_TOKEN (src/config.ts)')
  expect(await band.find({ key: 'update' })).toBeUndefined()
})

test('with mods-hub: the undocumented changes are published as a lint.result at the turn end (no notification of its own)', async ($, on) => {
  project(on, { 'README.md': '# cli\n', 'src/config.ts': CONFIG_BEFORE })
  const hub = fakeHub(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve() // the hello waits for session.start to return (afterStart)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['lint.result'], consumes: [] }])

  await $.turn.start({ text: 'add strict mode', turnId: 't1' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/config.ts`, content: CONFIG_AFTER })
  expect(hub.published).toEqual([])
  await $.turn.complete(TURN)

  expect(hub.published).toEqual([{ topic: 'lint.result', data: { tool: 'readme-sync', errors: 0, warnings: 6, files: ['src/config.ts'] } }])
  expect(hub.notified).toEqual([])
})

test('a doc edit in the same turn, or a repo without docs, keeps quiet', async ($, on) => {
  const state = project(on, { 'README.md': '# cli\n', 'src/config.ts': CONFIG_BEFORE })
  await $.turn.start({ text: 'add strict mode', turnId: 't1' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/config.ts`, content: CONFIG_AFTER })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/README.md`, old_string: '# cli', new_string: '# cli\n\nUse --strict.' })
  await $.turn.complete(TURN)
  const ui = await $.ui.mount({ plugin: 'readme-sync', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ key: 'update' })).toBeUndefined()

  state.files.delete(`${ROOT}/README.md`)
  await $.turn.start({ text: 'more', turnId: 't2' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/config.ts`, old_string: 'API_URL', new_string: 'SERVICE_URL' })
  await $.turn.complete({ ...TURN, turnId: 't2' })
  await ui.redraw()
  expect(await ui.find({ key: 'update' })).toBeUndefined()
})

test('only exports under the API paths count; tests and other files are ignored', async ($, on) => {
  project(on, { 'docs/usage.md': 'usage', 'scripts/build.ts': 'export function a() {}\n', 'src/x.test.ts': '' })
  await $.turn.start({ text: 'refactor', turnId: 't1' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/scripts/build.ts`, content: 'export function b() {}\nconst k = process.env.BUILD_KEY\n' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/x.test.ts`, content: 'export const t = process.env.TEST_ONLY\n' })
  await $.turn.complete(TURN)

  const ui = await $.ui.mount({ plugin: 'readme-sync', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ type: 'Text', text: 'docs untouched after 1 env var changed' })).toBeDefined()
  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ key: 'dismiss' })).toBeUndefined()
})

test('regression: the band keeps the bands beneath it on screen', async ($, on) => {
  project(on, { 'README.md': '# cli\n', 'src/config.ts': CONFIG_BEFORE }, 'engine band')
  await $.turn.start({ text: 'add strict mode', turnId: 't1' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/config.ts`, content: CONFIG_AFTER })
  await $.turn.complete(TURN)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'readme-sync', surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ key: 'update' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    await ui.unmount()
  }
})
