import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseBuiltinLine, parseMockArgs, parsePrismLine } from '../hooks/server'
import { mockSpecOf } from '../hooks/spec'
import { parseYaml } from '../hooks/yaml'

const ROOT = '/work/shop'
const SPEC = [
  'openapi: 3.0.3',
  'info:',
  '  title: Shop API # the shop',
  '  version: "1.0"',
  'paths:',
  '  /products:',
  '    get:',
  '      responses:',
  "        '200':",
  '          description: All products',
  '          content:',
  '            application/json:',
  '              schema:',
  '                type: array',
  '                items:',
  "                  $ref: '#/components/schemas/Product'",
  '    post:',
  '      responses:',
  '        201:',
  '          description: Created',
  '          content:',
  '            application/json:',
  '              example: { id: 9, name: "Lamp" }',
  '  /products/{id}:',
  '    delete:',
  '      responses:',
  "        '204':",
  '          description: Gone',
  'components:',
  '  schemas:',
  '    Product:',
  '      type: object',
  '      properties:',
  '        id: { type: integer }',
  '        name:',
  '          type: string',
  '          example: Chair',
  '        createdAt: { type: string, format: date-time }',
  '        tags:',
  '          type: array',
  '          items: { type: string, enum: [new, sale] }',
  '',
].join('\n')
const PANE = {
  plugin: 'mock-server',
  component: 'Pane',
  requestId: 'mock',
  props: { title: 'Mock server', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const mockCommand = (args = '') => ({ command: 'mock', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const

/** A child process the test drives: lines it prints, an exit, or the kill the plugin asks for. */
type Child = { argv: readonly string[]; input?: string; print: (text: string) => void; exit: (code: number) => void; isKilled: boolean }
type World = { children: Child[]; statuses: (string | undefined)[]; toasts: string[]; files: Set<string> }

const world = (on: On, files: string[] = ['openapi.yaml'], options: { missingBinary?: boolean } = {}) => {
  const state: World = { children: [], statuses: [], toasts: [], files: new Set(files.map(file => `${ROOT}/${file}`)) }
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 7, 12, 0, 0) })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.root', () => ({ value: ROOT }))
  on('fs.exists', ($, e) => ({ value: state.files.has(e.path) }))
  on('fs.read', ($, e) => (state.files.has(e.path) ? { value: /\.(?:ya?ml|json)$/.test(e.path) ? SPEC : '# Shop\n' } : { deny: 'ENOENT' }))
  on('fs.list', ($, e) => {
    const names = [...state.files].filter(file => file.startsWith(`${e.path}/`)).map(file => file.slice(e.path.length + 1)).filter(name => !name.includes('/'))
    return names.length === 0 ? { deny: 'ENOENT' } : { value: names.map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('process.spawn', async function* ($, e, next) {
    if (options.missingBinary === true) return { deny: 'failed to start: ENOENT' }
    const queue: (string | number)[] = []
    let wake = () => {}
    const child: Child = {
      argv: e.argv,
      ...(e.input === undefined ? {} : { input: e.input }),
      print: text => {
        queue.push(text)
        wake()
      },
      exit: code => {
        queue.push(code)
        wake()
      },
      isKilled: false,
    }
    state.children.push(child)
    next.signal.addEventListener('abort', () => wake())
    for (;;) {
      while (queue.length === 0 && !next.signal.aborted) await new Promise<void>(resolve => (wake = resolve))
      if (next.signal.aborted) {
        child.isKilled = true
        return { value: { code: null, signal: 'SIGTERM' } }
      }
      const item = queue.shift() as string | number
      if (typeof item === 'number') return { value: { code: item, signal: null } }
      yield { stream: 'stdout' as const, text: item }
    }
  })
  on('ui.status', ($, e) => {
    state.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({}))
  return { state, clock }
}

test('reads YAML specs into canned responses: examples first, then values made from the schemas', () => {
  expect(parseYaml('a: 1\nb: [x, "y z"]\nc: |\n  line\nd:\n  - k: v\n    w: 2\n')).toEqual({ a: 1, b: ['x', 'y z'], c: 'line\n', d: [{ k: 'v', w: 2 }] })
  const spec = mockSpecOf(SPEC)
  expect(spec.title).toBe('Shop API')
  expect(spec.routes).toEqual([
    { method: 'GET', path: '/products', status: 200, contentType: 'application/json', body: [{ id: 0, name: 'Chair', createdAt: '2024-01-01T12:00:00Z', tags: ['new'] }] },
    { method: 'POST', path: '/products', status: 201, contentType: 'application/json', body: { id: 9, name: 'Lamp' } },
    { method: 'DELETE', path: '/products/{id}', status: 204, contentType: 'application/json' },
  ])
  const swagger = mockSpecOf(JSON.stringify({ swagger: '2.0', basePath: '/v2', paths: { '/pet': { get: { responses: { 200: { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } } } } }))
  expect(swagger.routes[0]).toEqual({ method: 'GET', path: '/v2/pet', status: 200, contentType: 'application/json', body: { ok: true } })
  expect(() => mockSpecOf('name: not a spec')).toThrow('not an OpenAPI or Swagger document')

  expect(parseBuiltinLine('{"type":"request","method":"GET","path":"/products?page=2","status":200,"ms":3}')).toEqual({ type: 'request', method: 'GET', path: '/products?page=2', status: 200, ms: 3 })
  expect(parsePrismLine('[10:00:01 AM] › [CLI] ▶  start     Prism is listening on http://127.0.0.1:4010')).toEqual({ type: 'ready', url: 'http://localhost:4010' })
  expect(parsePrismLine('\u001b[2m[10:00:05 AM]\u001b[22m › [HTTP SERVER] get /pets ℹ  info      Request received')).toEqual({ type: 'request', method: 'GET', path: '/pets' })
  expect(parsePrismLine('[10:00:05 AM] ›     [NEGOTIATOR] ✔  success   Responding with the requested status code 200')).toEqual({ type: 'status', status: 200 })
  expect(parsePrismLine('[10:00:00 AM] › [CLI] ℹ  info      POST       http://127.0.0.1:4010/pets')).toEqual({ type: 'route', method: 'POST', path: '/pets' })
  expect(parseMockArgs('api/openapi.yaml 5000')).toEqual({ spec: 'api/openapi.yaml', port: 5000 })
  expect(parseMockArgs('99999')).toEqual({ error: '99999 is not a port.' })
})

test('/mock starts the built-in mock from the spec it finds, shows requests, and /mock stop ends it', { timeoutMs: 20_000 }, async ($, on) => {
  const { state, clock } = world(on, ['docs/openapi.yaml'])
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const started = await $.command.run(mockCommand())
  expect(started.text).toBe('Starting the built-in mock (3 operations) for docs/openapi.yaml on http://localhost:4010…')
  const child = state.children[0] as Child
  expect(child.argv.slice(0, 2)).toEqual(['node', '-e'])
  const config = JSON.parse(child.input ?? '{}') as { port: number; host: string; routes: { path: string }[] }
  expect(config.port).toBe(4010)
  expect(config.host).toBe('127.0.0.1')
  expect(config.routes.map(route => route.path)).toEqual(['/products', '/products', '/products/{id}'])

  child.print('{"type":"ready","url":"http://localhost:4010"}\n{"type":"request","method":"GET","path":"/products","status":200,"ms":4}\n')
  child.print('{"type":"request","method":"DELETE","pa')
  child.print('th":"/products/7","status":204,"ms":1}\n')
  await clock.settle()
  expect(state.statuses.at(-1)).toBe('🧪 mock :4010')
  expect(state.toasts).toContain('Mock ready on http://localhost:4010 (3 operations)')

  // While a child runs, every act waits for the plugin's reader to go quiet: read each drawing once.
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const drawn = JSON.stringify(await ui.drawn())
    for (const text of ['● running', 'GET     /products  → 200', '/products/7', 'Requests (2)', 'built-in · docs/openapi.yaml · 3 operations']) {
      expect(drawn).toContain(JSON.stringify(text))
    }
    await ui.unmount()
  }

  const stopped = await $.command.run(mockCommand('stop'))
  expect(stopped.text).toBe('Stopped the mock on :4010.')
  await clock.settle()
  expect(child.isKilled).toBe(true)
  expect(state.statuses.at(-1)).toBeUndefined()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '● stopped' })).toBeDefined()
  expect(await ui.find({ key: 'stop' })).toBeUndefined()
  expect((await $.command.run(mockCommand('stop'))).text).toBe('No mock server is running.')
})

test('a busy port fails with a hint, and the session ending stops a running mock', { timeoutMs: 20_000 }, async ($, on) => {
  const { state, clock } = world(on)
  await $.command.run(mockCommand('openapi.yaml 5000'))
  const busy = state.children[0] as Child
  busy.print('{"type":"error","code":"EADDRINUSE","message":"listen EADDRINUSE: address already in use 127.0.0.1:5000"}\n')
  busy.exit(1)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'port 5000 is already in use; try /mock openapi.yaml 5001' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '● failed' })).toBeDefined()
  expect(state.toasts.at(-1)).toBe('Mock stopped: port 5000 is already in use; try /mock openapi.yaml 5001')

  await ui.press({ key: 'restart' })
  const second = state.children[1] as Child
  expect(JSON.parse(second.input ?? '{}').port).toBe(5000)
  await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } })
  await clock.settle()
  expect(second.isKilled).toBe(false)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's', resume: { id: 's' } })
  await clock.settle()
  expect(second.isKilled).toBe(true)
})

test('Prism runs when the project has it installed, and its output becomes requests', { timeoutMs: 20_000 }, async ($, on) => {
  const { state, clock } = world(on, ['openapi.yaml', 'node_modules/.bin/prism'])
  const started = await $.command.run(mockCommand('4020'))
  expect(started.text).toBe('Starting Prism for openapi.yaml on http://localhost:4020…')
  const child = state.children[0] as Child
  expect(child.argv).toEqual([`${ROOT}/node_modules/.bin/prism`, 'mock', `${ROOT}/openapi.yaml`, '-p', '4020', '-h', '127.0.0.1'])
  child.print('[1:00:00 PM] › [CLI] ℹ  info      GET        http://127.0.0.1:4020/products\n')
  child.print('[1:00:00 PM] › [CLI] ▶  start     Prism is listening on http://127.0.0.1:4020\n')
  child.print('[1:00:02 PM] › [HTTP SERVER] get /products ℹ  info      Request received\n')
  child.print('[1:00:02 PM] ›     [NEGOTIATOR] ✔  success   Responding with the requested status code 200\n')
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('"Prism · openapi.yaml · 1 operation"')
  expect(drawn).toContain('"/products"')
  expect(drawn).toContain('"200"')
  expect(state.statuses).toContain('🧪 mock :4020')
  await $.command.run(mockCommand('stop'))
  await clock.settle()
  expect(child.isKilled).toBe(true)
})

test('no spec, a file that is no spec, or a wrong path are explained', async ($, on) => {
  world(on, ['README.md'])
  expect((await $.command.run(mockCommand())).text).toContain('No OpenAPI spec found')
  expect((await $.command.run(mockCommand('README.md'))).text).toBe('Could not read README.md: this is not an OpenAPI or Swagger document')
  expect((await $.command.run(mockCommand('nope.yaml'))).text).toBe('nope.yaml does not exist.')
})

test('a missing node binary fails the start with what to do', async ($, on) => {
  const { state, clock } = world(on, ['openapi.yaml'], { missingBinary: true })
  await $.command.run(mockCommand())
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'node (Node.js) is not installed or not on PATH; install it, or set engine to prism' })).toBeDefined()
  expect(state.statuses.at(-1)).toBeUndefined()
})

test('schemas that link to each other (Stripe-style) make a bounded body, quickly', () => {
  const schemas: Record<string, unknown> = {}
  for (let i = 0; i < 40; i += 1) {
    const properties: Record<string, unknown> = { id: { type: 'string' } }
    for (let link = 1; link <= 8; link += 1) properties[`link_${link}`] = { $ref: `#/components/schemas/S${(i + link) % 40}` }
    schemas[`S${i}`] = { type: 'object', properties }
  }
  const response = { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/S0' } } } }
  const doc = { openapi: '3.0.0', info: { title: 't', version: '1' }, paths: { '/s': { get: { responses: { '200': response } } } }, components: { schemas } }
  const startedAt = performance.now()
  const { routes } = mockSpecOf(JSON.stringify(doc))
  expect(performance.now() - startedAt).toBeLessThan(1_000)
  expect(JSON.stringify(routes[0]?.body).length).toBeLessThan(200_000)
  expect(routes[0]?.body).toMatchObject({ id: 'string' })
})
