import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { packageRequests } from '../hooks/parse'

const NOW = Date.parse('2026-10-07T12:00:00Z')
const DAY = 86_400_000

type Registry = Record<string, { status: number; body?: unknown } | 'hang'>

/** The engine beneath the plugin: a clock, a store, a registry by URL, and a Bash that always runs. */
const world = (on: On, registry: Registry) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const fetched: string[] = []
  const toasts: string[] = []
  on('http.fetch', async ($, e) => {
    fetched.push(e.url)
    const answer = registry[e.url] ?? { status: 404 }
    if (answer === 'hang') await new Promise(() => undefined)
    const { status, body } = answer as { status: number; body?: unknown }
    const text = typeof body === 'string' ? body : JSON.stringify(body ?? {})
    return { value: { status, ok: status >= 200 && status < 300, headers: {}, text } }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', () => ({ result: 'installed' }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  return { clock, fetched, toasts }
}

const bash = async ($: Engine, command: string): Promise<string | undefined> => {
  const result = await $.tool.call({ tool: 'Bash', command })
  return result.deny ?? (result.isError === true ? result.text : undefined)
}

const npmDoc = (createdDaysAgo: number, versions: number) => ({
  status: 200,
  body: {
    time: { created: new Date(NOW - createdDaysAgo * DAY).toISOString() },
    versions: Object.fromEntries(Array.from({ length: versions }, (_, i) => [`1.0.${i}`, {}])),
  },
})

test('holds back a typosquat that does not exist on the registry', async ($, on) => {
  const { toasts } = world(on, {})
  const reason = await bash($, 'npm install lodahs')
  expect(reason).toContain('lodahs looks like a typo of "lodash" (1 edit away)')
  expect(reason).toContain('lodahs does not exist on npm')
  expect(reason).toContain('DEPS-OK')
  expect(toasts.at(-1)).toContain('Held back lodahs')
})

test('lets popular packages through without asking any registry', async ($, on) => {
  const { fetched } = world(on, {})
  expect(await bash($, 'npm i -D typescript @types/node && pip install requests "pydantic>=2" && cargo add serde@1')).toBeUndefined()
  expect(fetched).toHaveLength(0)
})

test('holds back brand-new packages with a single release', async ($, on) => {
  world(on, {
    'https://pypi.org/pypi/fresh-helper/json': {
      status: 200,
      body: { releases: { '0.1.0': [{ upload_time_iso_8601: new Date(NOW - 5 * DAY).toISOString() }] } },
    },
  })
  const reason = await bash($, 'pip install fresh-helper')
  expect(reason).toContain('fresh-helper was first published 5 days ago')
  expect(reason).toContain('fresh-helper has only 1 release')
})

test('allows established packages and caches the lookup', async ($, on) => {
  const { fetched } = world(on, { 'https://registry.npmjs.org/left-pad': npmDoc(3000, 12) })
  expect(await bash($, 'yarn add left-pad')).toBeUndefined()
  expect(await bash($, 'pnpm add left-pad')).toBeUndefined()
  expect(fetched).toEqual(['https://registry.npmjs.org/left-pad'])
})

test('DEPS-OK in the prompt lets the install through and remembers the package', async ($, on) => {
  world(on, {})
  expect(await bash($, 'npm install lodahs')).toBeDefined()

  await $.prompt.submit({ text: 'yes, lodahs is right. DEPS-OK', wait: false, origin: { kind: 'composer' } })
  expect(await bash($, 'npm install lodahs')).toBeUndefined()

  await $.prompt.submit({ text: 'now run the tests', wait: false, origin: { kind: 'composer' } })
  expect(await bash($, 'npm install lodahs')).toBeUndefined()
  expect(await bash($, 'npm install expresss')).toContain('typo of "express"')
})

test('a registry that does not answer in time fails open with a toast', { options: { timeoutMs: 1000 } }, async ($, on) => {
  const { clock, toasts } = world(on, { 'https://crates.io/api/v1/crates/obscure-crate': 'hang' })
  const pending = bash($, 'cargo add obscure-crate')
  await clock.advance(1000)
  expect(await pending).toBeUndefined()
  expect(toasts.at(-1)).toContain('Could not check obscure-crate on crates.io')
})

test('finds the packages of each installer and skips paths, URLs and flags', () => {
  const names = (command: string) => packageRequests(command).map(request => `${request.ecosystem}:${request.name}`)
  expect(names('npm i -D @scope/pkg@^2 ./local git+https://x.git user/repo')).toEqual(['npm:@scope/pkg'])
  expect(names('python3 -m pip install -r requirements.txt Django==5.0 "uvicorn[standard]"')).toEqual(['pypi:django', 'pypi:uvicorn'])
  expect(names('uv pip install -e . black && poetry add Flask_Cors')).toEqual(['pypi:black', 'pypi:flask-cors'])
  expect(names('cargo add tokio --features full && cargo install --git https://x ripgrep')).toEqual(['crates:tokio'])
  expect(names('go get github.com/gin-gonic/gin@v1.9.1 ./...')).toEqual(['go:github.com/gin-gonic/gin'])
  expect(names('npx -y create-vite my-app')).toEqual(['npm:create-vite'])
  expect(names('npm install && npm run build')).toEqual([])
})

test('a well-known package that happens to sit near a popular name is not held back', async ($, on) => {
  world(on, {
    'https://registry.npmjs.org/chalks': npmDoc(2000, 40),
    'https://registry.npmjs.org/lodashh': npmDoc(10, 1),
  })
  // Popular in their own right, so not even looked up: ms is not a typo of ws, pygame not of pyyaml.
  expect(await bash($, 'npm install ms vuex globby && pip install pygame dask cython')).toBeUndefined()
  // Years old with many releases: established, whatever it is close to.
  expect(await bash($, 'npm install chalks')).toBeUndefined()
  // Close to lodash and brand new: still a suspect.
  expect(await bash($, 'npm install lodashh')).toContain('typo of "lodash"')
})

test('leading package-manager options and env do not hide the install', () => {
  const names = (command: string) => packageRequests(command).map(request => request.name)
  expect(names('pnpm --filter web add lodahs')).toEqual(['lodahs'])
  expect(names('pnpm -C packages/api add zod')).toEqual(['zod'])
  expect(names('npm -w apps/web install lodahs')).toEqual(['lodahs'])
  expect(names('yarn workspace web add lodahs')).toEqual(['lodahs'])
  expect(names('env CI=1 npm i lodahs')).toEqual(['lodahs'])
  expect(names('pnpm --filter web run build')).toEqual([])
})
