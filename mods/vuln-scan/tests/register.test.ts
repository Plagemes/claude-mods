import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { NPM_AUDIT_V2, PIP_AUDIT } from './fixtures'
import { fakeHub } from './hub'

const PANE_PROPS = { title: 'Vulnerabilities', isFocused: false, bodyColumns: 110, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const
const OSV: Record<string, string> = {
  'https://api.osv.dev/v1/vulns/GHSA-jjg7-2v4v-x38h': JSON.stringify({ id: 'GHSA-jjg7-2v4v-x38h', database_specific: { severity: 'MODERATE' } }),
  'https://api.osv.dev/v1/vulns/GHSA-g3rq-g295-4j3m': JSON.stringify({ id: 'GHSA-g3rq-g295-4j3m', database_specific: { severity: 'MODERATE' } }),
  'https://api.osv.dev/v1/vulns/GHSA-pq67-6m6q-mj2v': JSON.stringify({ id: 'GHSA-pq67-6m6q-mj2v', database_specific: { severity: 'HIGH' } }),
}

type Run = { argv: readonly string[]; cwd: string | undefined }
type World = {
  runs: Run[]
  statuses: (string | undefined)[]
  toasts: string[]
  submitted: string[]
  fetched: string[]
  clock: ReturnType<typeof mock.clock>
  installFails: boolean
}

/** A repository at /repo with an npm app and a Python API in api/ whose virtualenv lives in api/.venv. */
const world = (on: On, options: { missing?: string[]; npmOutput?: string } = {}): World => {
  const files = new Set(['/repo/package-lock.json', '/repo/package.json', '/repo/api/requirements.txt', '/repo/api/.venv/lib/python3.12/site-packages'])
  const state: World = { runs: [], statuses: [], toasts: [], submitted: [], fetched: [], clock: mock.clock(on, { now: 1_000_000 }), installFails: false }
  mock.env(on, {})
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('fs.list', ($, e) => {
    if (e.path === '/repo/api/.venv/lib') return { value: [{ name: 'python3.12', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }] }
    if (e.path === '/repo') {
      return { value: ['package-lock.json', 'package.json', 'src'].map(name => ({ name, kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })) }
    }
    return { deny: 'ENOENT' }
  })
  on('process.run', ($, e) => {
    state.runs.push({ argv: e.argv, cwd: e.init?.cwd })
    const answer = (stdout: string, exitCode: number) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (options.missing?.includes(e.argv[0] ?? '')) return { deny: `failed to start: ENOENT: ${e.argv[0]}` }
    if (e.argv[0] === 'npm') return answer(options.npmOutput ?? NPM_AUDIT_V2, 1)
    if (e.argv[0] === 'pip-audit') return answer(PIP_AUDIT, 1)
    return answer('', 0)
  })
  on('http.fetch', ($, e) => {
    state.fetched.push(e.url)
    const text = OSV[e.url]
    return { value: { status: text === undefined ? 404 : 200, ok: text !== undefined, headers: {}, text: text ?? '{}' } }
  })
  on('tool.call', ($, e) => {
    if (state.installFails) return { isError: true, result: 'Exit code 1', text: 'npm ERR! 404 Not Found' }
    return { result: { stdout: `ran ${e.tool}`, stderr: '', interrupted: false } }
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
  on('prompt.submit', ($, e) => {
    state.submitted.push(e.text)
    return { text: e.text }
  })
  return state
}

const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })
const vulns = ($: Engine, args = '') =>
  $.command.run({ command: 'vulns', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

test('a successful npm install is audited once the installs settle, and the status line counts the worst', async ($, on) => {
  const state = world(on)
  await bash($, 'npm install lodash')
  await bash($, 'npm i -D vitest')
  await state.clock.advance(1_499)
  expect(state.runs).toHaveLength(0)
  await state.clock.advance(1)
  expect(state.runs).toEqual([{ argv: ['npm', 'audit', '--json'], cwd: '/repo' }])
  expect(state.statuses.at(-1)).toBe('🛡 1 critical · 2 high')

  state.installFails = true
  await bash($, 'npm install not-a-package')
  await state.clock.advance(5_000)
  expect(state.runs).toHaveLength(1)
})

test('pip installs run pip-audit on the project virtualenv and rate advisories with OSV', async ($, on) => {
  const state = world(on)
  await bash($, 'cd api && pip install -r requirements.txt')
  await state.clock.advance(1_500)
  expect(state.runs).toEqual([
    {
      argv: ['pip-audit', '-f', 'json', '--progress-spinner', 'off', '--path', '/repo/api/.venv/lib/python3.12/site-packages'],
      cwd: '/repo/api',
    },
  ])
  expect(state.fetched).toContain('https://api.osv.dev/v1/vulns/GHSA-jjg7-2v4v-x38h')
  expect(state.statuses.at(-1)).toBe('🛡 1 high · 2 moderate')
})

test('/vulns lists findings worst first on every surface; Ask Claude to fix sends them as a prompt', async ($, on) => {
  const state = world(on)
  expect((await vulns($)).text).toBe('Auditing 1 project…')
  await state.clock.advance(0)
  expect((await vulns($)).text).toBe('🛡 1 critical · 2 high · 4 moderate · 4 low')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'vuln-scan', surface, component: 'Pane', requestId: 'vulns', props: PANE_PROPS })
    expect((await ui.find({ key: 'summary' }))?.text).toContain('npm audit · just now · 11 findings')
    const row = (await ui.find({ key: 'finding:npm::minimist:GHSA-xvch-5gv4-984h' }))?.text ?? ''
    expect(row).toContain('CRITICAL')
    expect(row).toContain('Prototype Pollution in minimist')
    expect(row).toContain('→ minimist@1.2.8')
    expect((await ui.find({ key: 'finding:npm::qs:GHSA-hrpp-h998-j3pp' }))?.text).toContain('no fix yet')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'vuln-scan', surface: 'terminal', component: 'Pane', requestId: 'vulns', props: PANE_PROPS })
  await ui.press({ key: 'fix' })
  await ui.unmount()
  await state.clock.advance(1)
  expect(state.toasts.at(-1)).toBe('Asked Claude to fix 11 vulnerabilities.')
  expect(state.submitted[0]).toStartWith('Fix these dependency vulnerabilities that npm audit reported:\n- minimist: critical, GHSA-xvch-5gv4-984h')
  expect(state.submitted[0]).toContain('run the tests and the audit again')
})

test('says why an auditor could not run, and when there is nothing to audit', async ($, on) => {
  const state = world(on, { missing: ['pip-audit'] })
  await bash($, 'uv add requests --directory api; cd api && uv add httpx')
  await state.clock.advance(1_500)
  expect(state.toasts).toContain('pip-audit (api) could not run: pip-audit is not installed (pipx install pip-audit)')
  expect(state.statuses.filter(status => status !== undefined)).toEqual([])

  await bash($, 'cd docs && npm install')
  await state.clock.advance(1_500)
  expect(state.toasts.at(-1)).toBe('npm audit (docs) could not run: no package-lock.json to audit')
})

test('a clean audit says so in the status line for a minute', async ($, on) => {
  const state = world(on, { npmOutput: '{"auditReportVersion":2,"vulnerabilities":{},"metadata":{}}' })
  await bash($, 'npm install')
  await state.clock.advance(1_500)
  expect(state.statuses.at(-1)).toBe('🛡 no known vulnerabilities')
  await state.clock.advance(60_000)
  expect(state.statuses.at(-1)).toBeUndefined()
})

test('with mods-hub: says hello, publishes x.vuln-scan.found, raises an error notice only when critical or high ones increase, and a failed audit is a warning notice', async ($, on) => {
  const state = world(on, { missing: ['pip-audit'] })
  const hub = fakeHub(on, {}, state.clock)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['x.vuln-scan.found'], consumes: [] }])

  await bash($, 'npm install lodash')
  await state.clock.advance(1_500)
  expect(hub.published).toEqual([{ topic: 'x.vuln-scan.found', data: { tool: 'npm audit', dir: '', total: 11, critical: 1, high: 2, moderate: 4, low: 4 } }])
  expect(hub.notified).toEqual([{ level: 'error', title: '🛡 1 critical · 2 high in npm audit', body: '/vulns lists them and can ask Claude to fix them.' }])

  // The same audit again: nothing is worse than before, so no second alert.
  await bash($, 'npm install lodash')
  await state.clock.advance(1_500)
  expect(hub.published).toHaveLength(2)
  expect(hub.notified).toHaveLength(1)

  await bash($, 'cd api && uv add httpx')
  await state.clock.advance(1_500)
  expect(hub.notified.at(-1)).toEqual({ level: 'warning', title: 'pip-audit (api) could not run: pip-audit is not installed (pipx install pip-audit)' })
  expect(state.toasts).toEqual([])
})

test('with mods-hub, a clean audit publishes nothing', async ($, on) => {
  const state = world(on, { npmOutput: '{"auditReportVersion":2,"vulnerabilities":{},"metadata":{}}' })
  const hub = fakeHub(on, {}, state.clock)
  await bash($, 'npm install')
  await state.clock.advance(1_500)
  expect(hub.published).toEqual([])
  expect(hub.notified).toEqual([])
})

test('without mods-hub the audit is the status line only, and a failure is the same toast', async ($, on) => {
  const state = world(on, { missing: ['pip-audit'] })
  await bash($, 'npm install lodash')
  await bash($, 'cd api && uv add httpx')
  await state.clock.advance(1_500)
  expect(state.statuses.at(-1)).toBe('🛡 1 critical · 2 high')
  expect(state.toasts).toEqual(['pip-audit (api) could not run: pip-audit is not installed (pipx install pip-audit)'])
})
