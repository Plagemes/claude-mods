import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'
import type { On, RenderPropsOf, TurnCompleteInput } from 'claude-code'

import { repoKey } from '../hooks/sync'
import type { SyncLeaseFile, SyncMessage, SyncPeer } from '../types'

const NOW = new Date(2026, 9, 7, 12, 0, 0).getTime()
const MINUTE = 60_000
const ME = 'a1b2c3d4-0000-4000-8000-000000000001'
const PEER = 'b2c3d4e5-0000-4000-8000-000000000002'
const REMOTE = 'git@github.com:acme/shop.git'
const DIR = `/home/me/.claude/claude-mods/sync/${repoKey(REMOTE, '/work/shop')}`
const PANE: RenderPropsOf['Pane'] = { title: 'Mission Control', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }

type World = ReturnType<typeof world>

/** The engine and the machine: files with their times, git, the session, the prompt and the screen. */
function world(on: On, options: { isRepo?: boolean } = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/me' })
  const files = new Map<string, { text: string; at: number }>()
  const git = { status: '## main...origin/main\n M src/api/user.ts\n' }
  const seen = { toasts: [] as string[], statuses: [] as (string | undefined)[], submitted: [] as { text: string; context: readonly string[]; asUser: boolean }[], edits: [] as string[] }
  on('fs.read', ($, e) => (files.has(e.path) ? { value: files.get(e.path)?.text ?? '' } : { deny: `ENOENT: ${e.path}` }))
  on('fs.write', ($, e) => {
    files.set(e.path, { text: e.text, at: clock.now() })
    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    const prefix = `${e.path}/`
    const entries = [...files.entries()]
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map(([path, file]) => ({ name: path.slice(prefix.length), kind: 'file' as const, size: file.text.length, mtimeMs: file.at, isLink: false }))
    return { value: entries }
  })
  on('fs.stat', ($, e) => ({ deny: `ENOENT: ${e.path}` }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: ME }))
  on('session.cwd', () => ({ value: '/work/shop' }))
  on('session.repo', () => ({ value: options.isRepo === false ? null : { root: '/work/shop', remote: REMOTE, internal: false, name: null } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', ($, e) => {
    const args = e.argv.slice(1).join(' ')
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (options.isRepo === false) return { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
    if (args === 'rev-parse --show-toplevel') return ok('/work/shop\n')
    if (args === 'status --porcelain --branch') return ok(git.status)
    return ok('')
  })
  on('prompt.submit', ($, e) => {
    const origin = e.origin
    seen.submitted.push({ text: e.text, context: e.context ?? [], asUser: origin.kind === 'plugin' && origin.asUser === true })
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', ($, e) => {
    if ('file_path' in e) seen.edits.push(String(e.file_path))
    return { result: 'ok' }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Box', props: {}, children: [{ type: 'Text', props: {}, children: ['MISSION BOARD'] }] }) as never)
  return { clock, files, git, seen }
}

const start = ($: Engine) => $.session.start({ cwd: '/work/shop', surface: 'terminal', isInteractive: true })
const command = ($: Engine, name: string, args = '') => $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
const edit = ($: Engine, path: string) => $.tool.call({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b', replace_all: false })
const leases = (w: World): SyncLeaseFile => JSON.parse(w.files.get(`${DIR}/leases.json`)?.text ?? '{"leases":{}}') as SyncLeaseFile
const inboxOf = (w: World, id: string): SyncMessage[] =>
  (w.files.get(`${DIR}/inbox/${id}.jsonl`)?.text ?? '')
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as SyncMessage)
const ended = (turnId: string): TurnCompleteInput => ({ answer: 'Done.', durationMs: 1_000, isAborted: false, turnId, reason: 'answer' })
const person = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

/** The second session, simulated by its files: what it would write as it works. */
function peerSession(w: World, patch: Partial<SyncPeer> = {}): void {
  const now = w.clock.now()
  const peer: SyncPeer = {
    v: 1,
    id: PEER,
    label: 'shop#b2c3',
    project: 'shop',
    tree: '/work/shop',
    branch: 'main',
    isDirty: true,
    task: 'Add the login form',
    touched: [{ path: 'src/api/auth.ts', at: now - 5 * MINUTE }],
    acked: [],
    startedAt: now - 60 * MINUTE,
    updatedAt: now,
    ended: false,
    ...patch,
  }
  w.files.set(`${DIR}/sessions/${PEER}.json`, { text: JSON.stringify(peer), at: now })
}

function peerLease(w: World, rel: string, expiresIn = 8 * MINUTE): void {
  const now = w.clock.now()
  const file = leases(w)
  const path = `/work/shop/${rel}`
  file.leases[path] = { path, rel, session: PEER, label: 'shop#b2c3', branch: 'main', task: 'Add the login form', since: now - 2 * MINUTE, renewedAt: now - MINUTE, expiresAt: now + expiresIn }
  w.files.set(`${DIR}/leases.json`, { text: JSON.stringify(file), at: now })
}

const refusal = (ran: unknown): string => JSON.stringify(ran)

test('a file another live session holds is refused with who and what, until the person says SYNC-OK; that session is told', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  peerSession(w)
  peerLease(w, 'src/api/user.ts')

  const denied = await edit($, '/work/shop/src/api/user.ts')
  expect(refusal(denied)).toContain('src/api/user.ts is being edited by another Claude session on this repo, shop#b2c3 (branch main), working on \\"Add the login form\\"')
  expect(refusal(denied)).toContain('/sync ask shop#b2c3')
  expect(w.seen.edits).toEqual([])

  // Not the person: a scheduled prompt saying SYNC-OK changes nothing.
  await $.prompt.submit({ text: 'SYNC-OK nightly', wait: false, origin: { kind: 'scheduled-trigger' } })
  await $.turn.start({ text: 'SYNC-OK nightly', turnId: 't0' })
  expect(refusal(await edit($, 'src/api/user.ts'))).toContain('is being edited')
  await $.turn.complete(ended('t0'))

  await person($, 'SYNC-OK, take it over')
  expect(w.seen.submitted.at(-1)?.context).toContainEqual(expect.stringContaining('the person said SYNC-OK'))
  await $.turn.start({ text: 'SYNC-OK, take it over', turnId: 't1' })
  const allowed = await edit($, 'src/api/user.ts')
  expect(refusal(allowed)).not.toContain('is being edited')
  expect(w.seen.edits).toEqual(['src/api/user.ts'])
  expect(leases(w).leases['/work/shop/src/api/user.ts']).toMatchObject({ session: ME, label: 'shop#a1b2', rel: 'src/api/user.ts' })
  expect(inboxOf(w, PEER)).toMatchObject([{ kind: 'overridden', from: { label: 'shop#a1b2' }, text: expect.stringContaining('took over src/api/user.ts') }])
  await $.turn.complete(ended('t1'))

  // The override was for that turn alone.
  peerLease(w, 'src/api/auth.ts')
  await person($, 'now the auth file')
  await $.turn.start({ text: 'now the auth file', turnId: 't2' })
  expect(refusal(await edit($, 'src/api/auth.ts'))).toContain('is being edited')
})

test('leases are renewed while the session works, expire when it idles, die with a gone session, and are released at the end', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  peerSession(w)

  await edit($, '/work/shop/src/a.ts')
  expect(leases(w).leases['/work/shop/src/a.ts']).toMatchObject({ session: ME, expiresAt: NOW + 10 * MINUTE })

  await w.clock.advance(4 * MINUTE)
  peerSession(w)
  await $.tool.call({ tool: 'Read', file_path: '/work/shop/src/b.ts' })
  await w.clock.advance(10_000)
  expect(leases(w).leases['/work/shop/src/a.ts']?.expiresAt).toBeGreaterThan(NOW + 14 * MINUTE - 1)

  // The other session's lease ran out: free.
  peerSession(w)
  peerLease(w, 'src/old.ts', -1)
  expect(refusal(await edit($, '/work/shop/src/old.ts'))).not.toContain('is being edited')
  // The other session is gone (no heartbeat for a minute): its lease binds nothing.
  peerLease(w, 'src/c.ts')
  await w.clock.advance(MINUTE)
  expect(refusal(await edit($, '/work/shop/src/c.ts'))).not.toContain('is being edited')
  expect(leases(w).leases['/work/shop/src/c.ts']?.session).toBe(ME)

  // Idle past the lease length: another session may take the file.
  await w.clock.advance(11 * MINUTE)
  expect(leases(w).leases['/work/shop/src/a.ts']?.expiresAt).toBeLessThan(w.clock.now())

  await $.session.end({ reason: 'prompt_input_exit', sessionId: ME, resume: { id: ME } } as never)
  expect(Object.values(leases(w).leases).filter(one => one.session === ME)).toEqual([])
  expect(JSON.parse(w.files.get(`${DIR}/sessions/${ME}.json`)?.text ?? '{}').ended).toBe(true)
})

test('two sessions in one folder and on one dirty branch: a toast and a note for the model, once each', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  peerSession(w)

  const ran = (await edit($, '/work/shop/src/api/user.ts')) as { context?: readonly string[] }
  expect(ran.context?.join('\n')).toContain('shop#b2c3 (main) is also changing src/api/ (src/api/auth.ts): "Add the login form"')
  expect(w.seen.toasts.filter(text => text.includes('also changing src/api/'))).toHaveLength(1)
  await edit($, '/work/shop/src/api/routes.ts')
  expect(w.seen.toasts.filter(text => text.includes('also changing src/api/'))).toHaveLength(1)

  await w.clock.advance(10_000)
  peerSession(w)
  await w.clock.advance(10_000)
  expect(w.seen.toasts.filter(text => text.includes('works in this same checkout on main'))).toHaveLength(1)
  expect(w.seen.statuses.at(-1)).toBe('⇆ 1 other session on this repo · ⚠ same branch · /sync')
  await person($, 'carry on')
  expect(w.seen.submitted.at(-1)?.context.join('\n')).toContain('uncommitted changes: a commit from either session sweeps in the other')

  // Clean working tree: no more warning.
  w.git.status = '## main...origin/main\n'
  await w.clock.advance(30_000)
  peerSession(w)
  await w.clock.advance(10_000)
  expect(w.seen.statuses.at(-1)).toBe('⇆ 1 other session on this repo · /sync')
})

test('hand-off: /handoff-to writes the note (worktree advice when overlap is heavy) and a hand-off received runs once idle', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  peerSession(w, { touched: [{ path: 'src/api/auth.ts', at: NOW }, { path: 'src/api/user.ts', at: NOW }] })
  await edit($, '/work/shop/src/api/auth.ts')
  await edit($, '/work/shop/src/api/user.ts')

  const sent = String((await command($, 'handoff-to', 'b2c3 finish the API tests')).text)
  expect(sent).toContain('Hand-off sent to shop#b2c3')
  expect(sent).toContain('Released your 2 leases')
  const [note] = inboxOf(w, PEER)
  expect(note).toMatchObject({ kind: 'handoff', from: { session: ME, label: 'shop#a1b2' } })
  expect(note?.text).toContain('finish the API tests')
  expect(note?.text).toContain('Files it changed lately: src/api/auth.ts, src/api/user.ts.')
  expect(note?.text).toContain('isolation: "worktree"')
  expect(Object.keys(leases(w).leases)).toEqual([])

  expect(String((await command($, 'sync', 'ask shop#b2c3 may I take routes.ts?')).text)).toContain('Sent to shop#b2c3')
  expect(inboxOf(w, PEER).at(-1)).toMatchObject({ kind: 'ask', text: 'may I take routes.ts?' })
  const status = String((await command($, 'sync')).text)
  expect(status).toContain('this session shop#a1b2 on main, uncommitted changes')
  expect(status).toContain('shop#b2c3 (main, uncommitted, same checkout) · "Add the login form"')
  expect(String((await command($, 'handoff-to', 'nobody')).text)).toContain('No live session "nobody"')
  const byModel = await $.command.run({ command: 'handoff-to', args: 'b2c3 take it all', origin: { kind: 'unclassified' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(String(byModel.text)).toContain('only when you type the command yourself')

  // The other way: a hand-off for this session waits for the running turn, then runs as the person's prompt.
  await $.turn.start({ text: 'working', turnId: 't1' })
  const handoff: SyncMessage = { id: 'h1', at: w.clock.now(), kind: 'handoff', from: { session: PEER, label: 'shop#b2c3', branch: 'main' }, text: 'Hand-off from shop#b2c3: finish the login form.' }
  w.files.set(`${DIR}/inbox/${ME}.jsonl`, { text: `${JSON.stringify(handoff)}\n`, at: w.clock.now() })
  await w.clock.advance(3_000)
  expect(w.seen.toasts).toContain('⇆ Hand-off from shop#b2c3: it runs when Claude is idle.')
  expect(w.seen.submitted.filter(entry => entry.asUser)).toEqual([])
  await $.turn.complete(ended('t1'))
  await w.clock.settle()
  expect(w.seen.submitted.filter(entry => entry.asUser)).toEqual([{ text: 'Hand-off from shop#b2c3: finish the login form.', context: [], asUser: true }])
  await w.clock.advance(3_000)
  expect(w.seen.submitted.filter(entry => entry.asUser)).toHaveLength(1)
})

test('its section in Mission Control: under the cockpit on every surface; with mods-hub, in the Mission Control tab only', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  peerSession(w)
  peerLease(w, 'src/api/auth.ts')
  await w.clock.advance(10_000)

  for (const surface of ['terminal', 'desktop', 'mobile', 'vscode'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-sync', surface, component: 'Pane', requestId: 'mission-control', props: PANE })
    expect(await ui.find({ type: 'Text', text: 'MISSION BOARD' })).toBeDefined()
    expect(await ui.find({ key: 'session-sync' })).toBeDefined()
    expect(await ui.find({ key: `sync-${PEER}` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  leases: src/api/auth.ts' })).toBeDefined()
    await ui.unmount()
  }
  // No hub: the hub's pane is never drawn on.
  const panel = await $.ui.mount({ plugin: 'session-sync', surface: 'terminal', component: 'Pane', requestId: 'claude-mods', props: PANE })
  expect(await panel.find({ key: 'session-sync' })).toBeUndefined()
  await panel.unmount()
})

/** mods-hub reduced to its tab state and notify; each notify is reported as a toast `hub:notify <title>`. */
const hub: Plugin = {
  name: 'mods-hub',
  register(on) {
    const answer = async () => ({}) as never
    on('engine.create', async ($, e, next) => ({ ...(await next(e)), mods: { hello: answer, registerTab: answer, notify: answer, publish: answer, showTab: answer } as never }))
    on('mods.hello', async ($, e) => {
      await $.state.set({ plugin: 'mods-hub', key: 'tab' }, 'mission')
      return { value: {} as never }
    })
    on('mods.notify', async ($, e) => {
      $.ui.toast(`hub:notify ${e.title}`)
      return { value: { id: 'n1', targets: ['toast'], held: false } }
    })
    on('mods.publish', async ($, e) => {
      $.ui.toast(`hub:publish ${e.topic}`)
      return { value: { id: 'e1' } }
    })
  },
}

test('with mods-hub: warnings go through the hub, conflicts are published, the section joins the Mission Control tab', { plugins: [hub] }, async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  peerSession(w)
  peerLease(w, 'src/api/user.ts')
  await edit($, '/work/shop/src/api/user.ts')
  expect(w.seen.toasts).toContain('hub:publish x.session-sync.conflict')
  await edit($, '/work/shop/src/api/routes.ts')
  expect(w.seen.toasts.some(text => text.startsWith('hub:notify ⇆ shop#b2c3 (main) is also changing src/api/'))).toBe(true)
  expect(w.seen.toasts.some(text => text.startsWith('⇆ shop#b2c3'))).toBe(false)

  await w.clock.advance(10_000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-sync', surface, component: 'Pane', requestId: 'claude-mods', props: { ...PANE, title: 'Claude Mods' } })
    expect(await ui.find({ key: 'session-sync' })).toBeDefined()
    await ui.unmount()
  }
})

test('outside a git repository it stays out of the way', async ($, on) => {
  const w = world(on, { isRepo: false })
  await start($)
  await w.clock.settle()
  expect(String((await edit($, '/tmp/notes.md') as { result?: unknown }).result)).toBe('ok')
  expect(String((await command($, 'sync')).text)).toContain('inside a git repository')
  expect(String((await command($, 'handoff-to', 'x')).text)).toContain('inside a git repository')
  expect([...w.files.keys()]).toEqual([])
})
