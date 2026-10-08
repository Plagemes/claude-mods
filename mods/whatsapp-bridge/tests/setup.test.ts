import { expect, test } from 'claude-code/testing'
import type { RenderPropsOf } from 'claude-code'

import { healthDelay, lockState, normalizeBaseUrl, runArgv, unreachableText } from '../hooks/launcher'
import { decodePng, qrBlocks, qrModules } from '../hooks/qr'
import { defaultLabel, isPathLabel, projectNameOf } from '../hooks/routing'
import { DIR, ME, OWNER, configured, pass, start, wa, world } from './fake'
import { QR_PNG, QR_ROWS } from './qr-fixture'

const PANE: RenderPropsOf['Pane'] = { title: 'WhatsApp', isFocused: true, bodyColumns: 52, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} }
const mountOn = <S extends 'terminal' | 'desktop'>(surface: S) => ({ plugin: 'whatsapp-bridge', surface, component: 'Pane' as const, requestId: 'whatsapp-bridge', props: PANE })
const SERVER = `${DIR}/server.json`
const health = (calls: { path: string }[]): number => calls.filter(call => call.path.endsWith('/api/health')).length

test('setup wizard: Start OpenWA pulls, runs, provisions a scoped key, shows the QR, then the link', async ($, on) => {
  const seen = world(on, { isDown: true, status: 'qr_ready' })
  seen.wa.qrPng = QR_PNG
  await start($)
  await wa($, '')
  const ui = await $.ui.mount(mountOn('desktop'))
  expect(await ui.find({ key: 'start-openwa' })).toBeDefined()

  await ui.press({ key: 'start-openwa' })
  await seen.clock.advance(10)
  // Docker checked, the image pulled through a spawned child, the container run on 127.0.0.1 only.
  expect(seen.docker.spawned).toEqual([['docker', 'pull', 'ghcr.io/rmyndharis/openwa:0.24']])
  const run = seen.docker.commands.find(argv => argv[1] === 'run') ?? []
  expect(run).toContain('127.0.0.1:2785:2785')
  expect(JSON.parse(seen.files.get(SERVER) ?? '{}')).toMatchObject({ owner: ME })
  expect(await ui.find({ type: 'Text', text: /Starting OpenWA/ })).toBeDefined()

  // It boots: the next tick finds it healthy and provisions it with the admin key read from the container.
  seen.wa.isDown = false
  await seen.clock.advance(3_000)
  const config = JSON.parse(seen.files.get(`${DIR}/config.json`) ?? '{}') as Record<string, unknown>
  expect(config.apiKey).toBe('owa_k1_minted0000000000000000000')
  expect(config.sessionId).toBeDefined()
  expect(config.managed).toBe(true)
  expect(JSON.stringify([...seen.files.values()])).not.toContain('ADMINKEY')
  const mint = seen.wa.calls.find(call => call.path === '/auth/api-keys')
  expect(mint?.body).toMatchObject({ role: 'operator' })

  // The QR, decoded from OpenWA's PNG, drawn as an SVG on the desktop.
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  expect(await ui.find({ key: 'qr' })).toBeDefined()
  await ui.unmount()

  // Scanned: connected, with the linked number; the owner is the last step.
  seen.wa.status = 'ready'
  await seen.clock.advance(3_000)
  expect(await wa($, `owner +${OWNER}`)).toContain('Owner set')
  const after = await $.ui.mount(mountOn('desktop'))
  expect(await after.find({ type: 'Text', text: /Connected · \+15550001111/ })).toBeDefined()
  expect(await after.find({ key: 'test' })).toBeDefined()
  await after.unmount()
})

test('setup wizard: no Docker, then Docker not running, are named; nothing starts', async ($, on) => {
  const seen = world(on, { isDown: true })
  seen.docker.installed = false
  await start($)
  await wa($, 'start')
  await seen.clock.advance(10)
  const ui = await $.ui.mount(mountOn('terminal'))
  await ui.press({ key: 'tab:status' })
  expect(await ui.find({ type: 'Text', text: /Docker is not installed/ })).toBeDefined()
  seen.docker.installed = true
  seen.docker.daemon = false
  await ui.press({ key: 'start-openwa' })
  await seen.clock.advance(10)
  expect(await ui.find({ type: 'Text', text: /not running: start Docker Desktop/ })).toBeDefined()
  await ui.unmount()
  expect(seen.docker.commands.some(argv => argv[1] === 'run')).toBe(false)
  expect(seen.docker.spawned).toEqual([])
  // The lock went back: another session may try.
  expect(JSON.parse(seen.files.get(SERVER) ?? '{}')).toMatchObject({ owner: '' })
})

test('leader lock: a second session reuses the server another session is starting, and never spawns one', async ($, on) => {
  const seen = world(on, { isDown: true, files: { [SERVER]: JSON.stringify({ owner: 'sess-b', phase: 'starting', heartbeatAt: new Date(2026, 9, 7, 12, 0, 0).getTime(), startedAt: 0 }) } })
  await start($)
  await wa($, 'start')
  await seen.clock.advance(10)
  expect(seen.docker.commands).toEqual([])
  expect(seen.docker.spawned).toEqual([])
  const ui = await $.ui.mount(mountOn('desktop'))
  expect(await ui.find({ type: 'Text', text: /Another Claude Code session is starting OpenWA/ })).toBeDefined()
  // The other session finishes: its server answers and its key lands in config.json; this one just uses it.
  seen.files.set(`${DIR}/config.json`, JSON.stringify({ apiKey: 'owa_k1_scopedoperatorkey0000000000', sessionId: '3f6b9c1e-0000-4000-8000-000000000001', managed: true }))
  seen.wa.isDown = false
  await seen.clock.advance(3_000)
  expect(await ui.find({ type: 'Text', text: /OpenWA running at 127\.0\.0\.1:2785 \(another session\)/ })).toBeDefined()
  await ui.unmount()
  expect(seen.docker.commands.some(argv => argv[1] === 'run')).toBe(false)
  expect(seen.wa.minted).toEqual([])
})

test('an already running server is reused: Start never runs a second container', async ($, on) => {
  const seen = world(on, { files: configured() })
  await start($)
  expect(await wa($, 'start')).toContain('Starting OpenWA')
  await seen.clock.advance(10)
  expect(seen.docker.commands).toEqual([])
})

test('a port already in use is explained in words, the raw docker error kept dim', async ($, on) => {
  const seen = world(on, { isDown: true })
  seen.docker.hasImage = true
  seen.docker.runError = 'docker: Error response from daemon: Ports are not available: listen tcp 127.0.0.1:2785: bind: address already in use.'
  await start($)
  await wa($, 'start')
  await seen.clock.advance(10)
  const ui = await $.ui.mount(mountOn('desktop'))
  expect(await ui.find({ type: 'Text', text: /Port 2785 is already in use/ })).toBeDefined()
  expect(await ui.find({ key: 'setup-raw' })).toBeDefined()
  await ui.unmount()
})

test('unreachable: a friendly line, Start and "I run it myself", the raw error dim; broken actions hidden', async ($, on) => {
  const seen = world(on, { isDown: true, files: configured() })
  await start($)
  await wa($, '')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(mountOn(surface))
    expect(await ui.find({ type: 'Text', text: /OpenWA isn't running/ })).toBeDefined()
    expect(await ui.find({ key: 'start-openwa' })).toBeDefined()
    expect(await ui.find({ key: 'manual' })).toBeDefined()
    expect(await ui.find({ key: 'raw' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Mode unknown/ })).toBeUndefined()
    for (const key of ['test', 'digest', 'link', 'sessions', 'group', 'reconnect']) expect(await ui.find({ key })).toBeUndefined()
    // "I run it myself" opens the URL and key fields; the URL is saved for every session.
    await ui.press({ key: 'manual' })
    expect(await ui.find({ key: 'base-url' })).toBeDefined()
    await ui.press({ key: 'manual' })
    await ui.unmount()
  }
  const ui = await $.ui.mount(mountOn('desktop'))
  await ui.press({ key: 'manual' })
  await ui.input({ key: 'base-url', text: '192.168.1.5:2785' })
  await ui.unmount()
  expect(JSON.parse(seen.files.get(`${DIR}/config.json`) ?? '{}')).toMatchObject({ baseUrl: 'http://192.168.1.5:2785/api', managed: false })
  expect(seen.toasts.filter(text => /ECONNREFUSED/.test(text))).toEqual([])
})

test('backoff: health checks while nothing answers space out to 60 s, and no toast repeats', async ($, on) => {
  const seen = world(on, { isDown: true, files: configured() })
  await start($)
  await wa($, '')
  const first = health(seen.wa.calls.map(call => ({ path: call.path })))
  await pass(seen, 10 * 60_000, 10_000)
  const later = health(seen.wa.calls.map(call => ({ path: call.path }))) - first
  // 10 minutes at 5, 10, 20, 40, then 60 s apart: about 13 checks, not one per 10 s heartbeat (60).
  expect(later).toBeGreaterThan(8)
  expect(later).toBeLessThan(16)
  expect(seen.toasts.length).toBeLessThan(2)
  expect(healthDelay(1)).toBe(5_000)
  expect(healthDelay(3)).toBe(20_000)
  expect(healthDelay(9)).toBe(60_000)
})

test('labels: the project folder name from Windows and POSIX paths, and old path-derived labels are replaced', () => {
  expect(projectNameOf('C:\\Users\\alexg\\OneDrive\\Documents\\my-app')).toBe('my-app')
  expect(projectNameOf('C:\\Users\\alexg\\OneDrive - Personal\\Projects\\My App\\')).toBe('My App')
  expect(projectNameOf('c:/Users/alexg/OneDrive/shop')).toBe('shop')
  expect(projectNameOf('/home/me/my-app/')).toBe('my-app')
  expect(projectNameOf('C:\\')).toBe('project')
  expect(projectNameOf('')).toBe('project')
  expect(defaultLabel('C:\\Users\\alexg\\OneDrive\\Documents\\my-app', '', [])).toBe('my-app')
  expect(defaultLabel('C:\\Users\\alexg\\OneDrive - Personal\\Projects\\My App', 'main', [])).toBe('my-app')
  expect(defaultLabel('/home/me/my-app', '', ['my-app'])).toBe('my-app2')
  expect(isPathLabel('c-users-alexg-onedrive--', 'C:\\Users\\alexg\\OneDrive - Personal\\Projects\\shop')).toBe(true)
  expect(isPathLabel('my-app', 'C:\\Users\\alexg\\OneDrive\\my-app')).toBe(false)
  expect(isPathLabel('c-users-x', '/home/me/c-users-x')).toBe(false)
})

test('a session on a Windows project gets #<folder> on start, replacing a stored path label', async ($, on) => {
  const root = 'C:\\Users\\alexg\\OneDrive - Personal\\Projects\\my-app'
  const seen = world(on, { root, files: { [`${DIR}/sessions/${ME}.json`]: JSON.stringify({ info: { id: ME, label: 'c-users-alexg-onedrive--' } }) } })
  await start($)
  await seen.clock.advance(1_000)
  const info = JSON.parse(seen.files.get(`${DIR}/sessions/${ME}.json`) ?? '{}').info as { label: string; project: string }
  // The fake repo is on feature/login, and a telling branch wins; the project is the folder, not the path.
  expect(info.project).toBe('my-app')
  expect(info.label).toBe('login')
})

test('pure: the QR decodes from the PNG; launcher words and arguments', () => {
  const picture = decodePng(QR_PNG)
  expect(picture).not.toBeNull()
  expect(picture === null ? [] : qrModules(picture)).toEqual(QR_ROWS)
  expect(qrBlocks(QR_ROWS, { quiet: 2, ink: 'dark' })[0]?.length).toBe(QR_ROWS.length + 4)
  expect(decodePng('not a png')).toBeNull()
  expect(unreachableText('whatsapp-bridge: $.http.fetch(http://127.0.0.1:2785/api/health) failed: ECONNREFUSED')).toBe("OpenWA isn't running")
  expect(normalizeBaseUrl('127.0.0.1:2785')).toBe('http://127.0.0.1:2785/api')
  expect(normalizeBaseUrl('https://wa.example/api/')).toBe('https://wa.example/api')
  expect(normalizeBaseUrl('')).toBe('')
  expect(runArgv(2785, 'baileys')).not.toContain('--restart')
  expect(lockState({ owner: 'b', phase: 'starting', heartbeatAt: 1_000, startedAt: 0 }, 'a', 2_000)).toBe('held')
  expect(lockState({ owner: 'b', phase: 'starting', heartbeatAt: 1_000, startedAt: 0 }, 'a', 60_000)).toBe('free')
  expect(lockState(null, 'a', 0)).toBe('free')
})
