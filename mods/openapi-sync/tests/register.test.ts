import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fakeHub } from './hub'
import { diffRoutes, findIssues, isDocumented, mergeChanges, routesOf, specRoutesOf } from '../hooks/routes'

const ROOT = '/work/api'
const SPEC = [
  'openapi: 3.0.3',
  'servers:',
  '  - url: https://api.example.com/v1',
  'paths:',
  '  /users:',
  '    get:',
  '      summary: List users',
  '  /users/{userId}:',
  '    get:',
  '      summary: One user',
  '    delete:',
  '      summary: Remove a user',
  'components:',
  '  schemas:',
  '    User:',
  '      type: object',
  '',
].join('\n')
const ROUTES_BEFORE = [
  "import { Router } from 'express'",
  'const router = Router()',
  "router.get('/users', list)",
  "router.get('/users/:id', show)",
  "router.delete('/users/:id', remove)",
  'export default router',
  '',
].join('\n')
const ROUTES_AFTER = [
  "import { Router } from 'express'",
  'const router = Router()',
  "router.get('/users', list)",
  "router.get('/users/:id', show)",
  "router.post('/users/:id/avatar', upload.single('file'), setAvatar)",
  'export default router',
  '',
].join('\n')
const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {} }
const TURN = { answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' } as const

type Project = { files: Map<string, string>; prompts: string[] }

/** A project on a virtual disk; Edit and Write change it as the tools do. */
const project = (on: On, files: Record<string, string>): Project => {
  const state: Project = { files: new Map(Object.entries(files).map(([path, text]) => [`${ROOT}/${path}`, text])), prompts: [] }
  on('session.root', () => ({ value: ROOT }))
  on('fs.exists', ($, e) => ({ value: state.files.has(e.path) }))
  on('fs.stat', ($, e) => {
    const text = state.files.get(e.path)
    return text === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file', size: text.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', ($, e) => {
    const text = state.files.get(e.path)
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.list', ($, e) => {
    const names = new Map<string, 'file' | 'dir'>()
    for (const file of state.files.keys()) {
      if (!file.startsWith(`${e.path}/`)) continue
      const [name = '', ...rest] = file.slice(e.path.length + 1).split('/')
      names.set(name, rest.length > 0 ? 'dir' : 'file')
    }
    if (names.size === 0) return { deny: 'ENOENT' }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('tool.call', ($, e) => {
    if (e.tool === 'Write') state.files.set(e.file_path, e.content)
    if (e.tool === 'Edit') state.files.set(e.file_path, (state.files.get(e.file_path) ?? '').replace(e.old_string, e.new_string))
    return { result: { type: 'update' } }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', () => ({ type: 'Box', children: [] }))
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => {
    state.prompts.push(e.text)
    return { text: e.text }
  })
  return state
}

test('finds routes across frameworks and checks them against YAML and JSON specs', () => {
  const show = (file: string, text: string) => routesOf(file, text).map(route => `${route.method} ${route.path}`)
  expect(show('src/routes/users.ts', ROUTES_AFTER)).toEqual(['GET /users', 'GET /users/{id}', 'POST /users/{id}/avatar'])
  expect(show('src/api/client.ts', "export const list = () => axios.get('/users', { params })")).toEqual([])
  expect(show('app/api/orders/[orderId]/route.ts', 'export async function GET() {}\nexport const PATCH = handler')).toEqual([
    'GET /api/orders/{orderId}',
    'PATCH /api/orders/{orderId}',
  ])
  expect(show('app/routers/items.py', 'router = APIRouter(prefix="/items")\n@router.get("/{item_id}")\ndef read(item_id): ...')).toEqual(['GET /items/{item_id}'])
  expect(show('app.py', "@app.route('/login', methods=['GET', 'POST'])\ndef login(): ...")).toEqual(['GET /login', 'POST /login'])
  expect(show('shop/urls.py', "urlpatterns = [path('orders/<int:pk>/', views.detail), path('api/', include('api.urls'))]")).toEqual(['ANY /orders/{pk}'])
  expect(show('routes/api.php', "Route::get('/users/{id}', [UserController::class, 'show']);")).toEqual(['GET /api/users/{id}'])
  expect(show('main.go', 'mux.HandleFunc("GET /users/{id}", h)\nr.HandleFunc("/items", h).Methods("POST")\nhttp.HandleFunc("/", root)')).toEqual([
    'GET /users/{id}',
    'POST /items',
  ])
  expect(show('src/routes/users.test.ts', ROUTES_AFTER)).toEqual([])

  const spec = specRoutesOf(SPEC)
  expect(isDocumented({ method: 'GET', path: '/users/{id}' }, spec)).toBe(true)
  expect(isDocumented({ method: 'GET', path: '/v1/users/{id}' }, spec)).toBe(true)
  expect(isDocumented({ method: 'POST', path: '/users/{id}' }, spec)).toBe(false)
  const swagger = specRoutesOf(JSON.stringify({ swagger: '2.0', basePath: '/api', paths: { '/pets/{petId}': { get: {} } } }))
  expect(isDocumented({ method: 'GET', path: '/api/pets/{id}' }, swagger)).toBe(true)

  const changes = diffRoutes('src/routes/users.ts', routesOf('src/routes/users.ts', ROUTES_BEFORE), routesOf('src/routes/users.ts', ROUTES_AFTER))
  expect(changes.map(change => `${change.change} ${change.method} ${change.path}`)).toEqual(['added POST /users/{id}/avatar', 'removed DELETE /users/{id}'])
  expect(findIssues([], changes, spec).map(issue => `${issue.kind} ${issue.method} ${issue.path}`)).toEqual([
    'undocumented POST /users/{id}/avatar',
    'stale DELETE /users/{id}',
  ])
  const moved = mergeChanges(diffRoutes('a.ts', [{ method: 'GET', path: '/x' }], []), diffRoutes('b.ts', [], [{ method: 'GET', path: '/x' }]))
  expect(moved).toEqual([])
})

test('route changes the spec does not cover raise the band, and its button asks Claude to update it', async ($, on) => {
  const state = project(on, { 'openapi.yaml': SPEC, 'src/routes/users.ts': ROUTES_BEFORE })
  await $.turn.start({ text: 'add avatar upload, drop delete', turnId: 't1' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/routes/users.ts`, content: ROUTES_AFTER })
  await $.turn.complete(TURN)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'openapi-sync', surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ type: 'Text', text: '2 routes out of sync with openapi.yaml' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  + POST /users/{id}/avatar  (src/routes/users.ts) — not in the spec' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  − DELETE /users/{id}  (src/routes/users.ts) — removed, still in the spec' })).toBeDefined()
    await ui.unmount()
  }
  const busy = await $.ui.mount({ plugin: 'openapi-sync', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, isWorking: true } })
  expect(await busy.find({ key: 'update' })).toBeUndefined()
  await busy.unmount()

  const band = await $.ui.mount({ plugin: 'openapi-sync', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await band.press({ key: 'update' })
  expect(state.prompts).toHaveLength(1)
  expect(state.prompts[0]).toContain('My API routes changed but openapi.yaml does not match them yet:')
  expect(state.prompts[0]).toContain('- POST /users/{id}/avatar (defined in src/routes/users.ts) is not documented')
  expect(state.prompts[0]).toContain('- DELETE /users/{id} was removed from src/routes/users.ts but is still documented')
  expect(await band.find({ key: 'update' })).toBeUndefined()
})

test('with mods-hub: the routes out of sync are published as a lint.result at the turn end (no notification of its own)', async ($, on) => {
  project(on, { 'openapi.yaml': SPEC, 'src/routes/users.ts': ROUTES_BEFORE })
  const hub = fakeHub(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['lint.result'], consumes: [] }])

  await $.turn.start({ text: 'add avatar upload, drop delete', turnId: 't1' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/routes/users.ts`, content: ROUTES_AFTER })
  expect(hub.published).toEqual([])
  await $.turn.complete(TURN)

  expect(hub.published).toEqual([
    { topic: 'lint.result', data: { tool: 'openapi-sync', errors: 0, warnings: 2, files: ['openapi.yaml', 'src/routes/users.ts'] } },
  ])
  expect(hub.notified).toEqual([])
})

test('a spec updated in the same turn, or a later turn that fixes it, clears the warning', async ($, on) => {
  const state = project(on, { 'docs/openapi.yaml': SPEC, 'src/routes/users.ts': ROUTES_BEFORE })
  await $.turn.start({ text: 'add avatar', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/routes/users.ts`, old_string: "router.delete('/users/:id', remove)", new_string: "router.delete('/users/:id', remove)\nrouter.post('/users/:id/avatar', a, b)" })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/docs/openapi.yaml`, old_string: 'components:', new_string: '  /users/{userId}/avatar:\n    post:\n      summary: Upload\ncomponents:' })
  await $.turn.complete(TURN)
  const ui = await $.ui.mount({ plugin: 'openapi-sync', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ key: 'update' })).toBeUndefined()

  await $.turn.start({ text: 'remove delete', turnId: 't2' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/routes/users.ts`, old_string: "router.delete('/users/:id', remove)\n", new_string: '' })
  await $.turn.complete({ ...TURN, turnId: 't2' })
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: '1 route out of sync with docs/openapi.yaml' })).toBeDefined()

  await $.turn.start({ text: 'fix the spec', turnId: 't3' })
  const spec = state.files.get(`${ROOT}/docs/openapi.yaml`) ?? ''
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/docs/openapi.yaml`, content: spec.replace('    delete:\n      summary: Remove a user\n', '') })
  await $.turn.complete({ ...TURN, turnId: 't3' })
  await ui.redraw()
  expect(await ui.find({ key: 'update' })).toBeUndefined()
})

test('a project without a spec, or edits that touch no route, stay quiet', async ($, on) => {
  project(on, { 'src/routes/users.ts': ROUTES_BEFORE, 'src/util.ts': 'export const x = 1\n' })
  await $.turn.start({ text: 'add avatar', turnId: 't1' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/routes/users.ts`, content: ROUTES_AFTER })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/util.ts`, old_string: '1', new_string: '2' })
  await $.turn.complete(TURN)
  const ui = await $.ui.mount({ plugin: 'openapi-sync', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ key: 'update' })).toBeUndefined()
})

test('the dismiss button clears the band', { options: { specPath: 'contracts/api.yml' } }, async ($, on) => {
  project(on, { 'contracts/api.yml': SPEC, 'routes/api.php': "<?php\nRoute::get('/users', [U::class, 'index']);\n" })
  await $.turn.start({ text: 'add orders', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/routes/api.php`, old_string: "'index']);", new_string: "'index']);\nRoute::post('/orders', [O::class, 'store']);" })
  await $.turn.complete(TURN)
  const ui = await $.ui.mount({ plugin: 'openapi-sync', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ type: 'Text', text: '1 route out of sync with contracts/api.yml' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  + POST /api/orders  (routes/api.php) — not in the spec' })).toBeDefined()
  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ key: 'dismiss' })).toBeUndefined()
})
