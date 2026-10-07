import type { On } from 'claude-code'
import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { fakeHub } from './hub'
import { matchesPin, parseVersion, satisfies } from '../hooks/semver'
import type { Version } from '../hooks/semver'

/** Stands in for the engine: the node that is running (undefined = not installed), project files, toasts and the status line. */
function project(on: On, node: string | undefined, files: Record<string, string>) {
  const clock = mock.clock(on)
  const seen = { toasts: [] as string[], statuses: [] as (string | undefined)[], nodeRuns: 0, ran: [] as string[] }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.root', () => ({ value: '/repo' }))
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash') seen.ran.push(e.command)
    return { result: 'ran' }
  })
  on('fs.read', (_$, e) => {
    const text = files[e.path]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('process.run', () => {
    seen.nodeRuns += 1
    if (node === undefined) return { deny: 'failed to start: ENOENT' }
    return { value: { exitCode: 0, stdout: `${node}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  return { seen, clock }
}

const start = async ($: Engine, clock: { advance: (ms: number) => Promise<void> }) => {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
}

const v = (text: string): Version => parseVersion(text) as Version

test('at session start, warns once with a toast and the status line when node differs from .nvmrc', async ($, on) => {
  const { seen, clock } = project(on, 'v18.19.0', { '/repo/.nvmrc': 'v20.11.0\n' })
  await start($, clock)
  expect(seen.toasts).toEqual(['node v18.19.0 is running, but the project wants v20.11.0 (.nvmrc)'])
  expect(seen.statuses).toEqual(['⚠ node v18.19.0, project wants v20.11.0'])
  await start($, clock)
  expect(seen.toasts).toHaveLength(1)
})

test('with mods-hub: the start-up warning is a warning notification (the status line stays), not a toast', async ($, on) => {
  const { seen, clock } = project(on, 'v18.19.0', { '/repo/.nvmrc': 'v20.11.0\n' })
  const hub = fakeHub(on, {}, clock)
  await start($, clock)

  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: [], consumes: [] }])
  expect(seen.toasts).toEqual([])
  expect(hub.notified).toEqual([{ level: 'warning', title: 'node v18.19.0 is running, but the project wants v20.11.0 (.nvmrc)' }])
  expect(seen.statuses).toEqual(['⚠ node v18.19.0, project wants v20.11.0'])
  await start($, clock)
  expect(hub.notified).toHaveLength(1)
})

const MATCHING: Record<string, Record<string, string>> = {
  '.nvmrc with a major': { '/repo/.nvmrc': '20\n' },
  '.node-version': { '/repo/.node-version': 'v20.11.0' },
  '.tool-versions': { '/repo/.tool-versions': 'python 3.12.1\nnodejs 20.11.0\n' },
  'an lts name': { '/repo/.nvmrc': 'lts/iron' },
  'engines.node': { '/repo/package.json': JSON.stringify({ engines: { node: '>=18 <22' } }) },
}

for (const [name, files] of Object.entries(MATCHING)) {
  test(`says nothing when node matches: ${name}`, async ($, on) => {
    const { seen, clock } = project(on, 'v20.11.0', files)
    await start($, clock)
    expect(seen.toasts).toEqual([])
    expect(seen.statuses).toEqual([])
  })
}

const MISMATCHING: Record<string, { files: Record<string, string>; toast: string }> = {
  '.tool-versions': {
    files: { '/repo/.tool-versions': 'nodejs 20.11.0\n', '/repo/package.json': JSON.stringify({ engines: { node: '^20.9.0 || >=22' } }) },
    toast: 'node v18.19.0 is running, but the project wants 20.11.0 (.tool-versions)',
  },
  '.node-version': { files: { '/repo/.node-version': '20\n' }, toast: 'node v18.19.0 is running, but the project wants 20 (.node-version)' },
  'engines.node': {
    files: { '/repo/package.json': JSON.stringify({ engines: { node: '>=20' } }) },
    toast: 'node v18.19.0 is running, but the project wants >=20 (package.json engines)',
  },
}

for (const [name, { files, toast }] of Object.entries(MISMATCHING)) {
  test(`warns when node differs, naming the file: ${name}`, async ($, on) => {
    const { seen, clock } = project(on, 'v18.19.0', files)
    await start($, clock)
    expect(seen.toasts).toEqual([toast])
  })
}

test('stays silent when the project states no Node requirement', async ($, on) => {
  const none = project(on, 'v20.11.0', { '/repo/README.md': 'hi' })
  await start($, none.clock)
  expect(none.seen.toasts).toEqual([])
})

test('stays silent when node is not installed', async ($, on) => {
  const { seen, clock } = project(on, undefined, { '/repo/.nvmrc': '20' })
  await start($, clock)
  expect(seen.toasts).toEqual([])
})

test('stays silent for pins that name no fixed version (lts/*, node, system)', async ($, on) => {
  const { seen, clock } = project(on, 'v16.0.0', { '/repo/.nvmrc': 'lts/*\n' })
  await start($, clock)
  expect(seen.toasts).toEqual([])
})

test('adds a note to install commands when node differs, and leaves other commands alone', async ($, on) => {
  const { seen } = project(on, 'v18.19.0', { '/repo/package.json': JSON.stringify({ engines: { node: '^20' } }) })
  const install = async (command: string) => (await $.tool.call({ tool: 'Bash', command })).context?.[0]
  for (const command of ['npm install', 'npm i left-pad', 'npm ci', 'pnpm install --frozen-lockfile', 'pnpm add -D vitest', 'yarn', 'yarn add react', 'cd app && npm install']) {
    expect(`${command} => ${await install(command)}`).toContain('node v18.19.0 is running, but the project wants ^20 (package.json engines)')
  }
  for (const command of ['npm run dev', 'npm test', 'yarn build', 'pnpm dev', 'git status', 'echo "npm install"']) {
    expect(await install(command)).toBeUndefined()
  }
  expect(seen.nodeRuns).toBe(1)
})

test('install commands get no note when node matches', async ($, on) => {
  project(on, 'v20.11.0', { '/repo/.nvmrc': '20' })
  expect((await $.tool.call({ tool: 'Bash', command: 'npm install' })).context).toBeUndefined()
})

test('version ranges: caret, tilde, comparators, x-ranges, hyphen and or', () => {
  const yes = (version: string, range: string) => expect(`${version} in ${range} => ${satisfies(v(version), range)}`).toBe(`${version} in ${range} => true`)
  const no = (version: string, range: string) => expect(`${version} in ${range} => ${satisfies(v(version), range)}`).toBe(`${version} in ${range} => false`)
  yes('20.11.0', '^20'); yes('20.11.0', '^20.9.0'); no('20.8.0', '^20.9.0'); no('21.0.0', '^20.9.0'); no('19.9.9', '^20')
  yes('0.2.5', '^0.2.3'); no('0.3.0', '^0.2.3'); yes('0.0.3', '^0.0.3'); no('0.0.4', '^0.0.3')
  yes('20.11.0', '~20.11'); yes('20.11.9', '~20.11.0'); no('20.12.0', '~20.11'); yes('20.12.0', '~20')
  yes('20.0.0', '>=20'); yes('22.1.0', '>=20'); no('18.0.0', '>=20'); yes('20.5.0', '>= 18 < 21'); no('21.0.0', '>=18 <21')
  yes('19.9.0', '>=19 <20'); no('19.9.0', '>19'); yes('20.0.0', '>19'); yes('20.1.0', '<=20'); no('21.0.0', '<=20'); no('20.0.0', '<20')
  yes('20.3.1', '20.x'); yes('20.3.1', '20'); yes('20.3.1', '20.3'); no('20.4.0', '20.3.x'); yes('1.2.3', '*'); yes('1.2.3', '')
  yes('19.0.0', '18 - 20'); no('21.0.0', '18 - 20'); yes('20.11.0', '18.0.0 - 20.11.0'); no('20.11.1', '18.0.0 - 20.11.0')
  yes('22.1.0', '^18 || ^20 || ^22'); no('21.0.0', '^18 || ^20 || ^22'); yes('18.0.0', '=18.0.0'); no('18.0.1', '=18.0.0')
  expect(satisfies(v('20.0.0'), 'latest')).toBeUndefined()
})

test('pins: prefix match like nvm, lts names, and what cannot be told', () => {
  expect(matchesPin(v('20.11.0'), '20')).toBe(true)
  expect(matchesPin(v('20.11.0'), 'v20.11')).toBe(true)
  expect(matchesPin(v('20.11.0'), '20.11.0')).toBe(true)
  expect(matchesPin(v('20.11.1'), '20.11.0')).toBe(false)
  expect(matchesPin(v('20.11.0'), '20.10')).toBe(false)
  expect(matchesPin(v('20.11.0'), 'lts/iron')).toBe(true)
  expect(matchesPin(v('18.0.0'), 'lts/iron')).toBe(false)
  expect(matchesPin(v('20.11.0'), 'node-v20.11.0')).toBe(true)
  expect(matchesPin(v('20.11.0'), '^20.9')).toBe(true)
  expect(matchesPin(v('20.11.0'), 'lts/*')).toBeUndefined()
  expect(matchesPin(v('20.11.0'), 'node')).toBeUndefined()
  expect(matchesPin(v('20.11.0'), 'system')).toBeUndefined()
})
