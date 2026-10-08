import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'
import type { On, RenderPropsOf, TurnCompleteInput } from 'claude-code'

import { dayKey } from '../hooks/model'
import type { MissionCommand, MissionHeartbeat } from '../types'

/** Wednesday 7 October 2026, noon local time. */
const NOW = new Date(2026, 9, 7, 12, 0, 0).getTime()
const MINUTE = 60_000
const ME = 'a1b2c3d4-0000-4000-8000-000000000001'
const PEER = 'b2c3d4e5-0000-4000-8000-000000000002'
const DIR = '/home/me/.claude/claude-mods/mission'
const PANE: RenderPropsOf['Pane'] = { title: 'Mission Control', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }

type World = ReturnType<typeof world>

/** Stands for the engine and the machine: files with their times, the session, the screen, the prompt. */
function world(on: On) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/me' })
  const files = new Map<string, { text: string; at: number }>()
  const seen = {
    toasts: [] as string[],
    statuses: [] as (string | undefined)[],
    submitted: [] as { text: string; context: readonly string[]; asUser: boolean }[],
    dropped: [] as string[],
    aborted: [] as string[],
    opened: [] as string[],
    panes: new Set<string>(),
    logs: [] as string[],
  }
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
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: ME }))
  on('session.cwd', () => ({ value: '/work/shop' }))
  on('session.repo', () => ({ value: { root: '/work/shop', remote: null, internal: false, name: null } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'feature/login\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('prompt.submit', ($, e) => {
    const origin = e.origin
    seen.submitted.push({ text: e.text, context: e.context ?? [], asUser: origin.kind === 'plugin' && origin.asUser === true })
    return { text: e.text }
  })
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.abort', ($, e) => {
    seen.aborted.push(e.turnId)
    return { value: undefined }
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('classic.PermissionRequest', () => ({}))
  on('classic.Notification', () => ({}))
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    seen.opened.push(e.id)
    seen.panes.add(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    seen.panes.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...seen.panes].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  return { clock, files, seen }
}

const start = ($: Engine) => $.session.start({ cwd: '/work/shop', surface: 'terminal', isInteractive: true })
const mission = ($: Engine, args = '') => $.command.run({ command: 'mission', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
const myBeat = (w: World): MissionHeartbeat => JSON.parse(w.files.get(`${DIR}/sessions/${ME}.json`)?.text ?? '{}') as MissionHeartbeat
const inboxOf = (w: World, id: string, from = ME): MissionCommand[] =>
  (w.files.get(`${DIR}/inbox/${id}/${from}.jsonl`)?.text ?? '')
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as MissionCommand)
const ended = (turnId: string, reason: 'answer' | 'aborted' | 'error' = 'answer'): TurnCompleteInput => ({
  answer: 'Done.',
  durationMs: 60_000,
  isAborted: reason === 'aborted',
  turnId,
  reason,
  usage: { input_tokens: 10_000, output_tokens: 2_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, model: 'claude-opus-5-5' },
})

/** A second session, simulated by its files: its heartbeat as it would write it. */
function peerBeat(w: World, patch: Partial<MissionHeartbeat> = {}): void {
  const beat: MissionHeartbeat = {
    v: 1,
    id: PEER,
    label: 'api#b2c3',
    project: 'api',
    root: '/work/api',
    cwd: '/work/api',
    branch: 'main',
    model: 'claude-sonnet-5',
    surface: 'desktop',
    state: 'waiting-permission',
    stateSince: w.clock.now() - 5 * MINUTE,
    task: 'Publish the 2.0 release',
    turnStartedAt: w.clock.now() - 8 * MINUTE,
    startedAt: w.clock.now() - 60 * MINUTE,
    updatedAt: w.clock.now(),
    turns: 4,
    tokens: 80_000,
    usd: 1.2,
    isUsdEstimate: false,
    spend: { day: dayKey(w.clock.now()), usd: 1.2 },
    subagents: 1,
    lastError: null,
    blocked: 'Approve Bash: npm publish',
    paused: false,
    priority: 'normal',
    acked: [],
    ended: false,
    ...patch,
  }
  w.files.set(`${DIR}/sessions/${PEER}.json`, { text: JSON.stringify(beat), at: w.clock.now() })
}

function sendToMe(w: World, commands: Partial<MissionCommand>[]): void {
  const lines = commands.map((command, index) => JSON.stringify({ id: `c${index}`, at: w.clock.now(), from: { session: PEER, label: 'api#b2c3' }, ...command }))
  w.files.set(`${DIR}/inbox/${ME}.jsonl`, { text: `${lines.join('\n')}\n`, at: w.clock.now() })
}

test('the heartbeat follows the session: working, waiting on approval, working again, idle with its cost, ended', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  expect(myBeat(w)).toMatchObject({ id: ME, label: 'shop#a1b2', project: 'shop', branch: 'feature/login', state: 'idle', model: 'claude-opus-5-5', ended: false })

  await $.turn.start({ text: 'Fix the login bug\nwith tests', turnId: 't1' })
  expect(myBeat(w)).toMatchObject({ state: 'working', task: 'Fix the login bug', turnStartedAt: NOW })

  await w.clock.advance(30_000)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })
  expect(myBeat(w)).toMatchObject({ state: 'waiting-permission', blocked: 'Approve Bash: rm -rf build', stateSince: NOW + 30_000 })

  await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  expect(myBeat(w)).toMatchObject({ state: 'working', blocked: null })

  await $.turn.complete(ended('t1'))
  const idle = myBeat(w)
  expect(idle).toMatchObject({ state: 'idle', turns: 1, turnStartedAt: null })
  expect(idle.usd).toBeGreaterThan(0)
  expect(idle.spend).toEqual({ day: dayKey(NOW), usd: idle.usd })

  // Unchanged, it is still rewritten inside the 30 s a heartbeat stays live.
  const before = w.files.get(`${DIR}/sessions/${ME}.json`)?.at ?? 0
  await w.clock.advance(15_000)
  expect((w.files.get(`${DIR}/sessions/${ME}.json`)?.at ?? 0) - before).toBeGreaterThan(0)
  expect(w.clock.now() - myBeat(w).updatedAt).toBeLessThan(30_000)

  await $.session.end({ reason: 'prompt_input_exit', sessionId: ME, resume: { id: ME } } as never)
  expect(myBeat(w).ended).toBe(true)
})

test('inbox commands from another session: priority, a note as your words when idle, pause, stop and resume', async ($, on) => {
  const w = world(on)
  const session = mock.session(on)
  await start($)
  await w.clock.settle()

  sendToMe(w, [
    { kind: 'priority', priority: 'high' },
    { kind: 'note', text: 'Please rebase on main first.' },
    { id: 'old', kind: 'stop', at: w.clock.now() - 11 * MINUTE },
  ])
  await w.clock.advance(2_000)
  expect(w.seen.submitted).toEqual([{ text: 'Please rebase on main first.', context: [], asUser: true }])
  expect(JSON.parse(w.files.get(`${DIR}/priority.json`)?.text ?? '{}').sessions[ME]).toMatchObject({ priority: 'high', label: 'shop#a1b2' })
  expect(myBeat(w)).toMatchObject({ priority: 'high', acked: ['c0', 'c1'] })

  // Handled once: the same file read again runs nothing more.
  await w.clock.advance(2_000)
  expect(w.seen.submitted).toHaveLength(1)

  await $.turn.start({ text: 'Please rebase on main first.', turnId: 't2' })
  sendToMe(w, [{ id: 'p1', kind: 'pause' }])
  await w.clock.advance(2_000)
  // Claude is asked to stop after its step by a row appended to the running turn (the kit's session stores it).
  expect(w.seen.logs).toEqual([])
  expect(session.appended()).toHaveLength(1)
  expect(myBeat(w).paused).toBe(true)
  expect(w.seen.statuses).toContain('⏸ paused from Mission Control · /mission resume')

  // No automatic prompts while paused; the person's own still go through.
  const auto = await $.prompt.submit({ text: 'nightly check', wait: false, origin: { kind: 'scheduled-trigger' } })
  expect(auto.drop).toContain('paused from Mission Control')
  const typed = await $.prompt.submit({ text: 'and fix the typo', wait: false, origin: { kind: 'composer' } })
  expect(typed.drop).toBeUndefined()

  sendToMe(w, [{ id: 's1', kind: 'stop' }])
  await w.clock.advance(2_000)
  expect(w.seen.aborted).toEqual(['t2'])
  await $.turn.complete(ended('t2', 'aborted'))

  sendToMe(w, [{ id: 'r1', kind: 'resume' }])
  await w.clock.advance(2_000)
  expect(myBeat(w).paused).toBe(false)
  expect(w.seen.submitted.at(-1)).toMatchObject({ text: 'Resume: carry on where you paused.', asUser: true })
})

test('two sessions: the cockpit lists the other one, its blocker and today\'s spend, and every button writes to its inbox', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  peerBeat(w)
  w.files.set(`${DIR}/sessions/c3d4e5f6-gone.json`, { text: JSON.stringify({ v: 1, id: 'c3d4e5f6-gone', project: 'docs', ended: true, updatedAt: NOW - MINUTE, spend: { day: dayKey(NOW), usd: 0.5 } }), at: NOW - MINUTE })

  expect(String((await mission($)).text)).toBe('Mission Control is open.')
  expect(w.seen.opened).toEqual(['mission-control'])
  const status = String((await mission($, 'status')).text)
  expect(status).toContain('2 sessions · 0 working · 1 waiting · $1.70 today')
  expect(status).toContain('api#b2c3 (main) · needs approval 5m00s')

  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    w.files.delete(`${DIR}/inbox/${PEER}/${ME}.jsonl`)
    const ui = await $.ui.mount({ plugin: 'mission-control', surface, component: 'Pane', requestId: 'mission-control', props: PANE })
    expect(await ui.find({ type: 'Text', text: 'Mission Control' })).toBeDefined()
    expect(await ui.find({ key: `card-${PEER}` })).toBeDefined()
    expect(await ui.find({ key: `card-${ME}` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  ⚠ Approve Bash: npm publish' })).toBeDefined()

    await ui.press({ key: `pause-${PEER}` })
    await ui.press({ key: `prio-${PEER}` })
    await ui.press({ key: `stop-${PEER}` })
    await ui.press({ key: `note-${PEER}` })
    await ui.input({ key: 'note-input', text: 'Wait for my migration before publishing.' })
    const sent = inboxOf(w, PEER)
    expect(sent.map(command => command.kind)).toEqual(['pause', 'priority', 'stop', 'note'])
    expect(sent[1]).toMatchObject({ priority: 'high', from: { session: ME, label: 'shop#a1b2' } })
    expect(sent[3]?.text).toBe('Wait for my migration before publishing.')
    expect(await ui.find({ key: 'note-input' })).toBeUndefined()

    await ui.press({ key: 'filter' })
    expect(await ui.find({ key: `card-${ME}` })).toBeUndefined()
    await ui.press({ key: 'filter' })
    await ui.press({ key: 'filter' })
    await ui.press({ key: 'filter' })
    await ui.unmount()
  }

  // A surface with no text field points at the command instead.
  const phone = await $.ui.mount({ plugin: 'mission-control', surface: 'mobile', component: 'Pane', requestId: 'mission-control', props: PANE })
  await phone.press({ key: `note-${PEER}` })
  expect(await phone.find({ type: 'Text', text: '  Send it with /mission note api#b2c3 <text>' })).toBeDefined()
  await phone.unmount()

  expect(String((await mission($, 'note api please wait')).text)).toContain('Note sent to api#b2c3')
  const byModel = await $.command.run({ command: 'mission', args: 'stop api', origin: { kind: 'unclassified' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(String(byModel.text)).toContain('only when you type the command or press a button yourself')
  expect(inboxOf(w, PEER).at(-1)).toMatchObject({ kind: 'note', text: 'please wait' })
})

test('without mods-hub: the other session waiting too long is announced where you typed last, and counted in the status line', async ($, on) => {
  const w = world(on)
  await start($)
  await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } })
  await w.clock.settle()
  peerBeat(w, { stateSince: NOW - MINUTE })
  await w.clock.advance(5_000)
  peerBeat(w, { stateSince: NOW - MINUTE })
  expect(w.seen.statuses).toContain('⏳ 1 session waiting for you · /mission')
  expect(w.seen.toasts.some(text => text.startsWith('⏳ api#b2c3'))).toBe(false)

  await w.clock.advance(2 * MINUTE)
  peerBeat(w, { stateSince: NOW - MINUTE })
  await w.clock.advance(5_000)
  expect(w.seen.toasts.filter(text => text.startsWith('⏳ api#b2c3 has waited 3m'))).toHaveLength(1)
  peerBeat(w, { stateSince: NOW - MINUTE })
  await w.clock.advance(5_000)
  expect(w.seen.toasts.filter(text => text.startsWith('⏳ api#b2c3'))).toHaveLength(1)

  // This session's own long wait: a toast here when there is no hub to route it.
  await $.turn.start({ text: 'deploy', turnId: 't1' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'kubectl apply -f prod.yaml' } })
  await w.clock.advance(3 * MINUTE + 5_000)
  expect(w.seen.toasts.some(text => text.includes('shop#a1b2 has waited') && text.includes('kubectl apply'))).toBe(true)
})

/**
 * mods-hub, reduced to what mission-control uses: hello, tabs, notify, publish, share. Each call is reported as a
 * toast `hub:<method> <input>` (an inline plugin runs in its own environment: it shares no memory with the test).
 */
const hub: Plugin = {
  name: 'mods-hub',
  register(on) {
    const answer = async () => ({}) as never
    on('engine.create', async ($, e, next) => ({
      ...(await next(e)),
      mods: { hello: answer, registerTab: answer, showTab: answer, notify: answer, publish: answer, share: answer, recent: answer, stop: answer } as never,
    }))
    // The hub's control.* events a test raises, from /hub/controls.json.
    on('mods.recent', async ($, e) => {
      const raised = JSON.parse(await $.fs.read('/hub/controls.json').catch(() => '[]')) as { topic: string; at: number }[]
      return { value: raised.filter(event => event.at > (e.since ?? 0) && (e.prefix === undefined || event.topic.startsWith(e.prefix))) as never }
    })
    on('mods.stop', async ($, e) => {
      $.ui.toast(`hub:stop ${JSON.stringify(e)}`)
      return { value: {} as never }
    })
    on('mods.hello', async ($, e) => {
      $.ui.toast(`hub:hello ${JSON.stringify(e)}`)
      return { value: {} as never }
    })
    on('mods.registerTab', async ($, e) => {
      $.ui.toast(`hub:registerTab ${JSON.stringify(e)}`)
      return { value: { tabs: [] } }
    })
    on('mods.notify', async ($, e) => {
      $.ui.toast(`hub:notify ${JSON.stringify(e)}`)
      return { value: { id: 'n1', targets: ['toast'], held: false } }
    })
    on('mods.publish', async ($, e) => {
      $.ui.toast(`hub:publish ${JSON.stringify(e)}`)
      return { value: { id: 'e1' } }
    })
    on('mods.share', async ($, e) => {
      $.ui.toast(`hub:share ${JSON.stringify(e)}`)
      return { value: {} as never }
    })
    on('mods.showTab', async ($, e) => {
      $.ui.toast(`hub:showTab ${JSON.stringify(e)}`)
      await $.state.set({ plugin: 'mods-hub', key: 'tab' }, e.id)
      return { value: { isPlaced: true } }
    })
  },
}

const hubCall = (w: World, method: string): unknown[] =>
  w.seen.toasts.filter(text => text.startsWith(`hub:${method} `)).map(text => JSON.parse(text.slice(`hub:${method} `.length)) as unknown)

test('with mods-hub: a Mission Control tab, long waits routed by the hub, facts shared', { plugins: [hub] }, async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.advance(1_500) // the hello waits for session.start to return (afterStart)
  expect(hubCall(w, 'registerTab')).toEqual([{ id: 'mission', title: 'Mission Control', order: 30, command: 'mission' }])

  expect(String((await mission($)).text)).toBe('Mission Control is open in the Claude Mods panel.')
  expect(w.seen.opened).toEqual([])
  peerBeat(w)
  await mission($, 'status')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'mission-control', surface, component: 'Pane', requestId: 'claude-mods', props: { ...PANE, title: 'Claude Mods' } })
    expect(await ui.find({ key: `card-${PEER}` })).toBeDefined()
    await ui.unmount()
  }

  sendToMe(w, [{ kind: 'priority', priority: 'low' }])
  await w.clock.advance(2_000)
  expect(hubCall(w, 'share')).toContainEqual({ name: 'priority', value: 'low' })
  expect(hubCall(w, 'publish')).toContainEqual({ topic: 'x.mission-control.command', data: { kind: 'priority', from: 'api#b2c3', session: 'shop#a1b2' } })

  await $.turn.start({ text: 'deploy', turnId: 't1' })
  await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Which region?', header: 'Region', options: [], multiSelect: false }] } as never)
  await $.classic.Notification({ message: 'An MCP server needs input', notification_type: 'elicitation_dialog' })
  expect(myBeat(w)).toMatchObject({ state: 'waiting-input', blocked: 'An MCP server asks for input' })
  await w.clock.advance(3 * MINUTE + 5_000)
  const notice = hubCall(w, 'notify')[0] as { level: string; title: string } | undefined
  expect(notice?.level).toBe('warning')
  expect(notice?.title).toContain('shop#a1b2 has waited 3m')
  expect(w.seen.toasts.some(text => !text.startsWith('hub:') && text.includes('shop#a1b2 has waited'))).toBe(false)
})

test('two cockpits at once never lose a click: each sending session writes its own inbox file, and the target runs both', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  peerBeat(w)
  // Two clicks of this cockpit racing each other.
  await Promise.all([mission($, 'note api first'), mission($, 'note api second')])
  expect(inboxOf(w, PEER).map(command => command.text).sort()).toEqual(['first', 'second'])

  // The other session's cockpit and this one both send to this session: both commands run here.
  w.files.set(`${DIR}/inbox/${ME}/${PEER}.jsonl`, { text: `${JSON.stringify({ id: 'p1', at: w.clock.now(), kind: 'priority', priority: 'high', from: { session: PEER, label: 'api#b2c3' } })}\n`, at: w.clock.now() })
  await mission($, 'note shop#a1b2 from myself')
  await w.clock.advance(2_000)
  expect(myBeat(w)).toMatchObject({ priority: 'high' })
  expect(w.seen.submitted.map(one => one.text)).toContain('from myself')
})

test('with mods-hub: a Pause from a cockpit pauses the automatic work here too; the hub\'s pause holds notes, resume runs them, stop drops them', { plugins: [hub] }, async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  sendToMe(w, [{ kind: 'pause' }, { kind: 'resume' }])
  await w.clock.advance(2_000)
  expect(hubCall(w, 'stop')).toEqual([
    expect.objectContaining({ action: 'pause', scope: 'session' }),
    expect.objectContaining({ action: 'resume', scope: 'session' }),
  ])

  const raise = (topic: string, at: number): void => {
    const raised = JSON.parse(w.files.get('/hub/controls.json')?.text ?? '[]') as unknown[]
    raised.push({ id: `c${at}`, topic, data: { id: `c${at}`, scope: 'all', reason: 'lunch', by: 'owner via whatsapp', session: 'other' }, source: 'whatsapp-bridge', at, session: 'other', scope: 'session' })
    w.files.set('/hub/controls.json', { text: JSON.stringify(raised), at: w.clock.now() })
  }
  raise('control.pause', w.clock.now() + 1)
  await w.clock.advance(2_000)
  w.files.set(`${DIR}/inbox/${ME}/${PEER}.jsonl`, { text: `${JSON.stringify({ id: 'n1', at: w.clock.now(), kind: 'note', text: 'run the migration', from: { session: PEER, label: 'api#b2c3' } })}\n`, at: w.clock.now() })
  await w.clock.advance(4_000)
  expect(w.seen.submitted.map(one => one.text)).not.toContain('run the migration')
  raise('control.resume', w.clock.now() + 1)
  await w.clock.advance(4_000)
  expect(w.seen.submitted.map(one => one.text)).toContain('run the migration')

  raise('control.stop', w.clock.now() + 1)
  await $.turn.start({ text: 'busy', turnId: 't1' })
  w.files.set(`${DIR}/inbox/${ME}/${PEER}.jsonl`, { text: `${JSON.stringify({ id: 'n2', at: w.clock.now(), kind: 'note', text: 'and deploy', from: { session: PEER, label: 'api#b2c3' } })}\n`, at: w.clock.now() })
  await w.clock.advance(2_000)
  raise('control.stop', w.clock.now() + 1)
  await w.clock.advance(2_000)
  await $.turn.complete(ended('t1'))
  await w.clock.advance(4_000)
  expect(w.seen.submitted.map(one => one.text)).not.toContain('and deploy')
})
