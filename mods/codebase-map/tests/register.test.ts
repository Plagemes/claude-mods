import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { buildMap, parseMeta } from '../hooks/map'

const ROOT = '/work/shop'
const FILES = [
  'package.json',
  'README.md',
  'src/index.ts',
  'src/api/routes.ts',
  'src/api/users.ts',
  'src/lib/db.ts',
  '.github/workflows/ci.yml',
]
const COMPOSE = {
  model: 'claude',
  promptModel: 'claude',
  surfaces: ['terminal'] as const,
  tools: [],
  outputStyle: null,
  traits: [],
}
const run = (args = '') => ({
  command: 'map',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 160 },
})
const PANE_PROPS = {
  title: 'Codebase map',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

type World = { writes: Map<string, string>; runs: string[][]; copies: string[] }

/** Answers every noun the mod calls, standing in for the engine. */
const world = (on: On, gitFiles: readonly string[] | 'fails'): World => {
  const state: World = { writes: new Map(), runs: [], copies: [] }
  mock.clock(on, { now: Date.UTC(2026, 9, 7, 9, 30) })
  on('session.root', () => ({ value: ROOT }))
  on('process.run', ($, e) => {
    state.runs.push([...e.argv])
    return gitFiles === 'fails'
      ? { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
      : { value: { exitCode: 0, stdout: gitFiles.join('\0') + '\0', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.write', ($, e) => {
    state.writes.set(e.path, e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.copy', ($, e) => {
    state.copies.push(e.text)
    return { value: { isCopied: true } }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }))
  return state
}

test('buildMap draws dir counts, marks key files and keeps to the size cap', async () => {
  const built = buildMap(FILES, { name: 'shop', depth: 3, maxChars: 6000, now: 0, source: 'git' })
  expect(built.files).toBe(7)
  expect(built.markdown).toContain('shop/ (7 files)')
  expect(built.markdown).toContain('src/ (4)')
  expect(built.markdown).toContain('api/ (2)')
  expect(built.markdown).toContain('index.ts  · entry point')
  expect(built.markdown).toContain('routes.ts')
  expect(built.markdown).toContain('- `package.json` (config)')
  expect(built.markdown).toContain('- `.github/workflows/ci.yml` (CI)')
  expect(parseMeta(built.markdown)).toEqual({ files: 7, dirs: 5, generatedAt: 0, source: 'git' })

  const packages = Array.from({ length: 40 }, (_, i) => [`pkg${i}/src/lib${i}.ts`, `pkg${i}/test/spec${i}.ts`]).flat()
  const shallower = buildMap(packages, { name: 'mono', depth: 3, maxChars: 1500, now: 0, source: 'walk' })
  expect(shallower.markdown.length).toBeLessThanOrEqual(1500)
  expect(shallower.depth).toBeLessThan(3)
  expect(shallower.isTruncated).toBe(false)

  const flat = Array.from({ length: 60 }, (_, i) => `notes-${i}.txt`)
  const cut = buildMap(flat, { name: 'flat', depth: 3, maxChars: 500, now: 0, source: 'walk' })
  expect(cut.markdown.length).toBeLessThanOrEqual(500)
  expect(cut.isTruncated).toBe(true)
  expect(cut.markdown).toContain('cut to fit the size cap')
})

test('/map lists files with git, saves the map and injects it into the system prompt', async ($, on) => {
  const state = world(on, FILES)
  const ran = await $.command.run(run())

  expect(ran.text).toContain('mapped 7 files in 5 dirs (git ls-files)')
  expect(state.runs[0]).toEqual(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'])
  const saved = state.writes.get(`${ROOT}/.claude/codebase-map.md`)
  expect(saved).toContain('# Codebase map: shop')
  expect(saved).toContain('src/ (4)')

  const composed = await $.prompt.compose(COMPOSE)
  const section = composed.sections.find(s => s.id === 'codebase-map:map')
  expect(section?.scope).toBe('session')
  expect(section?.text).toContain('routes.ts')
  expect(composed.sections[0]?.id).toBe('intro')
})

test('/map walks the folder when git is unavailable, skipping ignored dirs', async ($, on) => {
  const state = world(on, 'fails')
  const tree: Record<string, { name: string; kind: 'file' | 'dir' }[]> = {
    [ROOT]: [
      { name: 'main.py', kind: 'file' },
      { name: 'pyproject.toml', kind: 'file' },
      { name: 'node_modules', kind: 'dir' },
      { name: 'app', kind: 'dir' },
    ],
    [`${ROOT}/app`]: [{ name: 'models.py', kind: 'file' }],
  }
  on('fs.list', ($, e) => ({
    value: (tree[e.path] ?? []).map(entry => ({ ...entry, size: 1, mtimeMs: 0, isLink: false })),
  }))

  const ran = await $.command.run(run())
  expect(ran.text).toContain('mapped 3 files in 1 dirs (folder walk)')
  const saved = state.writes.get(`${ROOT}/.claude/codebase-map.md`) ?? ''
  expect(saved).toContain('main.py  · entry point')
  expect(saved).not.toContain('node_modules')
})

test('with autoInject off the map rides along with /map only', { options: { autoInject: false } }, async ($, on) => {
  world(on, FILES)
  const ran = await $.command.run(run())
  expect(ran.text).toContain('autoInject is off')
  expect(ran.context?.[0]).toContain('# Repository map')

  const composed = await $.prompt.compose(COMPOSE)
  expect(composed.sections.map(s => s.id)).toEqual(['intro'])
})

test('the pane shows the map and its buttons work on terminal and desktop', async ($, on) => {
  const state = world(on, FILES)
  await $.command.run(run())

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'codebase-map', surface, component: 'Pane', requestId: 'codebase-map', props: PANE_PROPS })
    expect((await ui.find({ type: 'Text', text: /7 files in 5 dirs/ }))).toBeDefined()
    expect((await ui.find({ key: 'map' }))?.text).toContain('users.ts')
    await ui.press({ key: 'copy' })
    expect(state.copies.at(-1)).toContain('# Codebase map: shop')
    await ui.press({ key: 'refresh' })
    await ui.unmount()
  }
  expect(state.runs.length).toBe(3)
})

test('/map show reuses the saved map without rebuilding', async ($, on) => {
  const state = world(on, FILES)
  await $.command.run(run())
  const shown = await $.command.run(run('show'))
  expect(shown.text).toContain('showing the saved map')
  expect(state.runs.length).toBe(1)
  const odd = await $.command.run(run('everything'))
  expect(odd.text).toContain('unknown argument')
})
