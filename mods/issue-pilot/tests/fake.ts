// The world beneath issue-pilot in the tests: git, gh and the test command (process.run), Jira and Linear
// (http.fetch), files, the store, the screen. Plus stand-ins for mods-hub and autopilot.
import { mock } from 'claude-code/testing'
import type { Engine, MockClock, Plugin } from 'claude-code/testing'
import type { EngineInterface, On, RenderPropsOf } from 'claude-code'

import type { ModsEvent } from '../types/mods-hub'

export const NOW = Date.UTC(2026, 9, 7, 12)
export const ROOT = '/work/shop'
export const SURFACES = ['terminal', 'desktop'] as const
export const PANE_PROPS: RenderPropsOf['Pane'] = { title: 'Issues', isFocused: true, bodyColumns: 76, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} }
export const JIRA = { jiraBaseUrl: 'https://acme.atlassian.net', jiraEmail: 'me@acme.io', jiraApiToken: 'jira-secret-token' }
export const LINEAR_KEY = 'lin_api_testkey123'

export const GH_ISSUES = [
  {
    number: 12,
    title: 'Login redirect loops after SSO',
    body: 'SSO users loop on /callback.\n\n## Acceptance criteria\n- SSO users land on the dashboard\n- [ ] Add a regression test',
    labels: [{ name: 'bug' }],
    milestone: { title: 'v2.4' },
    url: 'https://github.com/acme/shop/issues/12',
    state: 'OPEN',
  },
  { number: 15, title: 'Fix typo in README', body: 'teh → the', labels: [{ name: 'documentation' }], milestone: null, url: 'https://github.com/acme/shop/issues/15', state: 'OPEN' },
]

const JIRA_ISSUE = {
  id: '10007',
  key: 'SHOP-7',
  fields: {
    summary: 'Add gift cards to checkout',
    description: { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Acceptance criteria' }] }, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A gift card code reduces the total' }] }] }] }] },
    labels: ['checkout'],
    status: { name: 'To Do' },
    fixVersions: [{ name: '2026.10' }],
    customfield_10016: 3,
  },
}

const LINEAR_ISSUE = {
  id: 'uuid-42',
  identifier: 'ENG-42',
  title: 'Export invoices as CSV',
  description: '- [ ] CSV has one row per invoice\n- [ ] Amounts use two decimals',
  url: 'https://linear.app/acme/issue/ENG-42',
  estimate: 2,
  state: { name: 'Todo', type: 'unstarted' },
  labels: { nodes: [{ name: 'feature' }] },
  cycle: { name: 'Cycle 9', number: 9 },
  project: null,
}

type RunResult = { exitCode: number; stdout: string; stderr: string }
export type Setup = {
  remote?: string
  /** Answers a gh call instead of the default fake (return undefined for the default). */
  gh?: (args: readonly string[]) => RunResult | 'missing' | undefined
  testsFail?: boolean
  isClean?: boolean
  files?: Record<string, string>
  report?: string
}

export type Request = { method: string; url: string; headers: Record<string, string>; body: string }

export type World = {
  runs: string[][]
  stdin: Map<string, string>
  http: Request[]
  prompts: string[]
  toasts: string[]
  statuses: (string | undefined)[]
  opened: string[]
  store: Map<string, unknown>
  clock: MockClock
  hub: HubSeen
}

const ok = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '' })
const value = (result: RunResult) => ({ value: { ...result, isStdoutTruncated: false, isStderrTruncated: false } })

function git(args: readonly string[], setup: Setup): RunResult {
  const joined = args.join(' ')
  if (joined === 'rev-parse --show-toplevel') return ok(`${ROOT}\n`)
  if (joined === 'remote get-url origin') return ok(`${setup.remote ?? 'git@github.com:acme/shop.git'}\n`)
  if (joined.startsWith('symbolic-ref')) return ok('origin/main\n')
  if (joined.startsWith('merge-base')) return ok('abc1234\n')
  if (joined.startsWith('diff --stat')) return ok(' src/auth/callback.ts | 4 ++--\n test/callback.test.ts | 12 ++++++++++++\n 2 files changed, 14 insertions(+), 2 deletions(-)\n')
  if (joined.startsWith('log ')) return ok('- fix: keep returnTo through the SSO callback\n')
  if (joined === 'status --porcelain') return ok(setup.isClean === true ? '' : ' M src/auth/callback.ts\n')
  if (joined === 'rev-parse --short HEAD') return ok('f00ba12\n')
  if (joined.startsWith('show --name-only')) return ok('src/auth/callback.ts\n')
  if (joined.startsWith('rev-list --count')) return ok('1\n')
  return ok()
}

function gh(args: readonly string[]): RunResult {
  const [noun, verb, number] = args
  if (noun === 'issue' && verb === 'list') return ok(JSON.stringify(GH_ISSUES))
  if (noun === 'issue' && verb === 'view') return ok(JSON.stringify(GH_ISSUES.find(one => String(one.number) === number) ?? {}))
  if (noun === 'pr' && verb === 'create') return ok('Creating draft pull request for fix/12 into main in acme/shop\n\nhttps://github.com/acme/shop/pull/99\n')
  return ok()
}

function jira(request: Request): { status: number; text: string } {
  const { method, url } = request
  if (url.includes('/rest/api/3/search/jql')) return { status: 200, text: JSON.stringify({ issues: [JIRA_ISSUE] }) }
  if (url.endsWith('/transitions') && method === 'GET') {
    return { status: 200, text: JSON.stringify({ transitions: [{ id: '21', name: 'Start progress', to: { name: 'In Progress' } }, { id: '31', name: 'Send to review', to: { name: 'In Review' } }] }) }
  }
  if (method === 'POST') return { status: url.endsWith('/transitions') ? 204 : 201, text: url.endsWith('/transitions') ? '' : '{}' }
  if (url.includes('/rest/api/3/issue/SHOP-7')) return { status: 200, text: JSON.stringify(JIRA_ISSUE) }
  return { status: 404, text: '{"errorMessages":["Not found"]}' }
}

function linear(request: Request): { status: number; text: string } {
  const { query } = JSON.parse(request.body) as { query: string }
  const data = (payload: unknown) => ({ status: 200, text: JSON.stringify({ data: payload }) })
  if (query.includes('IssuePilotList')) return data({ issues: { nodes: [LINEAR_ISSUE] } })
  if (query.includes('IssuePilotView')) return data({ issue: LINEAR_ISSUE })
  if (query.includes('IssuePilotStates')) {
    return data({ issue: { team: { states: { nodes: [{ id: 's-todo', name: 'Todo', type: 'unstarted', position: 0 }, { id: 's-prog', name: 'In Progress', type: 'started', position: 1 }, { id: 's-rev', name: 'In Review', type: 'started', position: 2 }] } } } })
  }
  if (query.includes('IssuePilotMove')) return data({ issueUpdate: { success: true } })
  if (query.includes('IssuePilotComment')) return data({ commentCreate: { success: true } })
  if (query.includes('IssuePilotLink')) return data({ attachmentLinkURL: { success: true } })
  return { status: 400, text: JSON.stringify({ errors: [{ message: 'unknown query' }] }) }
}

/** Registers every engine answer the plugin needs; call before the first `$` call. */
export function world(on: On, setup: Setup = {}): World {
  const w: World = { runs: [], stdin: new Map(), http: [], prompts: [], toasts: [], statuses: [], opened: [], store: new Map(), clock: mock.clock(on, { now: NOW }), hub: { published: [], notices: [], tabs: [], hello: [], shown: [] } }
  const files: Record<string, string> = { [`${ROOT}/package.json`]: '{"scripts":{"test":"jest"}}', ...setup.files }
  mock.env(on, { HOME: '/home/me' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    w.runs.push(argv)
    if (e.init?.stdin !== undefined) w.stdin.set(argv.slice(0, 3).join(' '), e.init.stdin)
    const [bin = '', ...args] = argv
    if (bin === 'git') return value(git(args, setup))
    if (bin === 'gh') {
      const custom = setup.gh?.(args)
      if (custom === 'missing') return { deny: 'failed to start: spawn gh ENOENT' }
      return value(custom ?? gh(args))
    }
    if (bin === 'sh') {
      return value(setup.testsFail === true
        ? { exitCode: 1, stdout: 'FAIL test/callback.test.ts\nTest Suites: 1 failed, 1 total\nTests:       1 failed, 11 passed, 12 total\n', stderr: '' }
        : ok('PASS test/callback.test.ts\nTest Suites: 1 passed, 1 total\nTests:       12 passed, 12 total\n'))
    }
    return value({ exitCode: 127, stdout: '', stderr: `${bin}: not found` })
  })
  on('http.fetch', ($, e) => {
    const request: Request = { method: e.init?.method ?? 'GET', url: e.url, headers: { ...(e.init?.headers ?? {}) }, body: e.init?.body ?? '' }
    w.http.push(request)
    const answer = e.url.startsWith('https://api.linear.app') ? linear(request) : jira(request)
    return { value: { status: answer.status, ok: answer.status >= 200 && answer.status < 300, headers: {}, text: answer.text } }
  })
  on('fs.read', ($, e) => (e.path in files ? { value: files[e.path] ?? '' } : { deny: `ENOENT: ${e.path}` }))
  on('store.get', ($, e) => ({ value: w.store.get(e.key) }) as never)
  on('store.set', ($, e) => {
    w.store.set(e.key, e.value)
    return { value: undefined } as never
  })
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.status', ($, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', () => ({ value: { isCopied: true } }))
  on('ui.log', ($, e) => {
    const hub = /^hub (\w+) (.*)$/s.exec(e.text)
    if (hub !== null) (w.hub[hub[1] as keyof HubSeen] as unknown[]).push(JSON.parse(hub[2] ?? 'null'))
    return { value: undefined }
  })
  on('ui.render', () => ({ type: 'Box', children: [] }) as never)
  on('prompt.submit', ($, e) => {
    w.prompts.push(e.text)
    return { text: e.text }
  })
  on('model.fork', () => ({
    value: {
      isAnswered: true,
      text: setup.report ?? 'SUMMARY:\nThe SSO callback now keeps returnTo, so users land on the dashboard.\nRISKS:\n- Low: one handler changed.',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ok' }))
  return w
}

export const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
export const issues = async ($: Engine, args = ''): Promise<string> =>
  String((await $.command.run({ command: 'issues', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })).text ?? '')
export const endTurn = ($: Engine) => $.turn.complete({ answer: 'done', durationMs: 1_000, isAborted: false, turnId: 't-1', reason: 'answer' })

/** The argv of every call to `bin` whose arguments start with `prefix`. */
export const callsOf = (w: World, ...prefix: string[]): string[][] => w.runs.filter(argv => prefix.every((part, at) => argv[at] === part))

// ── Stand-ins for the hub and for autopilot ──────────────────────────────────────────────────────────
// A test plugin's register runs in its own environment: it may use nothing from this file. What the hub stand-in
// sees reaches the test as `$.ui.log` lines starting `hub ` (World.hub).

export type HubSeen = { published: ModsEvent[]; notices: { level: string; title: string; body?: string; url?: string }[]; tabs: string[]; hello: string[]; shown: string[] }

/** A minimal mods-hub: provides `$.mods`, records publishes as `latest`, keeps the shown tab. */
export const hubStub: Plugin = {
  name: 'mods-hub',
  register(on) {
    const mode = { presence: 'here', isSilent: false, silentUntil: null, isNight: false, quietHours: '22:00-07:00', interaction: 'auto', canAsk: false } as const
    const none = { hello: [], plugins: [], listedAt: null }
    const bottom: EngineInterface['mods'] = {
      publish: async () => ({ id: '' }),
      recent: async () => [],
      latest: async () => null,
      notify: async () => ({ id: '', targets: [], held: false }),
      mode: async () => mode,
      setMode: async () => mode,
      setPresence: async () => mode,
      registerTab: async () => ({ tabs: [] }),
      showTab: async () => ({ isPlaced: false }),
      registerChannel: async () => ({ channels: [] }),
      channelStatus: async () => ({ channels: [] }),
      deliver: async () => ({ isDelivered: false }),
      drain: async () => [],
      stop: async input => ({ id: 'c1', action: input.action ?? 'stop', scope: input.scope ?? 'session', reason: input.reason, by: input.by ?? '', session: '', source: '', at: 0 }),
      hello: async () => ({ installed: none }),
      installed: async () => none,
      share: async input => ({ key: input.name, owner: '', value: input.value, at: 0 }),
      read: async () => null,
    }
    let count = 0
    on('engine.create', async ($, e, next) => ({ ...(await next(e)), mods: bottom }))
    on('mods.publish', async ($, e, next) => {
      count += 1
      const event = { id: `ev-${count}`, topic: e.topic, data: e.data, source: next.origin.plugin ?? '', at: await $.clock.now(), session: 'sess-1', scope: 'session' as const }
      await $.state.set({ plugin: 'mods-hub', key: 'latest', id: e.topic }, event)
      $.ui.log(`hub published ${JSON.stringify(event)}`, { to: 'debug' })
      return { value: { id: event.id } }
    })
    on('mods.notify', ($, e) => {
      $.ui.log(`hub notices ${JSON.stringify({ level: e.level, title: e.title, body: e.body, url: e.url })}`, { to: 'debug' })
      return { value: { id: 'n', targets: ['toast'], held: false } }
    })
    on('mods.hello', ($, e, next) => {
      $.ui.log(`hub hello ${JSON.stringify(next.origin.plugin ?? '')}`, { to: 'debug' })
      return { value: { installed: none } }
    })
    on('mods.registerTab', ($, e) => {
      $.ui.log(`hub tabs ${JSON.stringify(e.id)}`, { to: 'debug' })
      return { value: { tabs: [] } }
    })
    on('mods.showTab', async ($, e) => {
      $.ui.log(`hub shown ${JSON.stringify(e.id)}`, { to: 'debug' })
      await $.state.set({ plugin: 'mods-hub', key: 'tab' }, e.id)
      return { value: { isPlaced: true } }
    })
    // `hub-stop <action>` in Bash: the person raised a stop or pause ($.mods.stop) — the `control` state in force.
    on('tool.call', async ($, e, next) => {
      const command = String((e as { command?: unknown }).command ?? '')
      if (String(e.tool) !== 'Bash' || !command.startsWith('hub-stop')) return next(e)
      const action = command.split(' ')[1] === 'pause' ? 'pause' : 'stop'
      await $.state.set({ plugin: 'mods-hub', key: 'control' }, { id: 'c1', action, scope: 'all', reason: 'STOP from the phone', by: 'owner via whatsapp', session: 'other', source: 'whatsapp-bridge', at: await $.clock.now() })
      return { result: 'stopped' }
    })
  },
}

/** autopilot, as far as issue-pilot sees it: a Bash command `autopilot-done <id> [failed]` publishes task.finished. */
export const autopilotStub: Plugin = {
  name: 'autopilot',
  register(on) {
    on('tool.call', async ($, e, next) => {
      const command = String((e as { command?: unknown }).command ?? '')
      if (String(e.tool) !== 'Bash' || !command.startsWith('autopilot-done ')) return next(e)
      const [, id = '', outcome = 'ok'] = command.split(' ')
      await $.mods.publish({ topic: 'task.finished', data: { id, title: 'Autopilot: fix the login loop', outcome: outcome === 'failed' ? 'failed' : 'ok' } })
      return { result: 'published' }
    })
  },
}

/** ci-watch, as far as issue-pilot sees it: a Bash command `ci <branch> <outcome>` publishes ci.result. */
export const ciStub: Plugin = {
  name: 'ci-watch',
  register(on) {
    on('tool.call', async ($, e, next) => {
      const command = String((e as { command?: unknown }).command ?? '')
      if (String(e.tool) !== 'Bash' || !command.startsWith('ci ')) return next(e)
      const [, branch = '', outcome = 'passed'] = command.split(' ')
      await $.mods.publish({ topic: 'ci.result', data: { provider: 'github', workflow: 'test', outcome: outcome === 'failed' ? 'failed' : 'passed', branch } })
      return { result: 'published' }
    })
  },
}
