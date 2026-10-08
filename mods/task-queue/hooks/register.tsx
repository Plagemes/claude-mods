import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, RenderElement, RenderInput, Timer } from 'claude-code'

import type { QueueFinished, QueueItem, QueueOutcome, QueueView } from '../types'
import { EMPTY_VIEW, fromStore, listText, moveItem, oneLine, parseQueueArgs, shortDuration, statusText } from './queue'

const PANE = 'queue'
const PANE_TITLE = 'Queue'
const PANE_ROWS = 18
const STORE_PREFIX = 'queue:'
const MAX_ITEMS = 50
const MAX_PROMPT_CHARS = 20_000
const RECENT_KEPT = 8
const RECENT_SHOWN = 4
const DEFAULT_MAX_RUNS = 20
const MAX_RUNS_CEILING = 100
/** Breathing room between a turn's end and the next queued prompt, so a prompt you typed meanwhile goes first. */
const SETTLE_MS = 1_500
/** How soon a prompt queued while Claude is idle starts. */
const START_DELAY_MS = 400
/** How often to look again while you have a draft in the prompt box. */
const DRAFT_RETRY_MS = 5_000
/** A submitted prompt whose turn never started by then is given up, so the queue cannot stall on it. */
const START_TIMEOUT_MS = 120_000
const PERSON_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])
/** The hub's shared panel, and this mod's Queue tab in it. */
const HUB_PANE = 'claude-mods'
const TAB = { id: 'queue', title: 'Queue', order: 220, command: 'queue' } as const
/** How often, with mods-hub installed, a stop, pause or resume (`control.*`) is looked for. */
const CONTROL_POLL_MS = 5_000
const TITLE_CHARS = 80
const TASK_OUTCOME: Record<QueueOutcome, 'ok' | 'failed' | 'cancelled'> = { done: 'ok', interrupted: 'cancelled', failed: 'failed', dropped: 'failed' }
const OUTCOME_GLYPHS: Record<QueueOutcome, { glyph: string; color: string }> = {
  done: { glyph: '✓', color: 'success' },
  interrupted: { glyph: '⏹', color: 'warning' },
  failed: { glyph: '✗', color: 'error' },
  dropped: { glyph: '✗', color: 'error' },
}

const viewAtom = atom({ plugin: 'task-queue', key: 'view' } as const, EMPTY_VIEW)

type Settings = { maxRuns: number }

/** What this load knows of the session beside the queue: whether a turn runs, and who is submitting. */
type Session = {
  root: string | undefined
  isTurnRunning: boolean
  /** Prompts the person submitted that have not started their turn yet. */
  personSubmitting: number
  /** This plugin's own `$.prompt.submit` is in flight. */
  isSubmitting: boolean
  timer: Timer | undefined
  /** mods-hub is installed (checked at session start). */
  hasHub: boolean
  /** How far the hub's `control.*` events were read, and whether a hub stop or pause paused the queue. */
  controlSeenAt: number
  isPausedByControl: boolean
}

function readSettings(options: PluginOptions): Settings {
  const raw = Math.round(Number(options.maxRuns))
  return { maxRuns: Number.isFinite(raw) && raw >= 1 ? Math.min(MAX_RUNS_CEILING, raw) : DEFAULT_MAX_RUNS }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

async function rootOf($: EngineInterface, session: Session): Promise<string> {
  if (session.root === undefined) session.root = await $.session.root().catch(() => '')
  return session.root
}

/** Applies `change` to the queue, then shows it on the status line and saves it for the project. */
async function commit($: EngineInterface, session: Session, change: (view: QueueView) => QueueView): Promise<QueueView> {
  const view = await update($, viewAtom, change)
  $.ui.status(statusText(view))
  try {
    const { items, isPaused, pauseReason, recent } = view
    await $.store.set(`${STORE_PREFIX}${await rootOf($, session)}`, { items, isPaused, pauseReason, recent })
  } catch (error) {
    $.ui.log(`task-queue: could not save the queue: ${messageOf(error)}`, { to: 'debug' })
  }
  return view
}

/** Loads the project's queue. Prompts left from an earlier session wait paused: they never start on their own. */
async function restore($: EngineInterface, session: Session): Promise<void> {
  const root = await rootOf($, session)
  const stored = fromStore(await $.store.get(`${STORE_PREFIX}${root}`).catch(() => undefined), { items: MAX_ITEMS, recent: RECENT_KEPT })
  const waiting = stored.items.length
  const view = await update($, viewAtom, () => ({
    ...EMPTY_VIEW,
    ...stored,
    isPaused: stored.isPaused || waiting > 0,
    pauseReason: waiting > 0 && !stored.isPaused ? 'left from your last session' : stored.pauseReason,
  }))
  $.ui.status(statusText(view))
  if (waiting > 0) $.ui.toast(`⏸ ${plural(waiting, 'queued prompt')} from last time · /queue resume runs them`)
}

function schedule($: EngineInterface, session: Session, settings: Settings, ms: number): void {
  session.timer?.cancel()
  session.timer = $.clock.after(ms, () => {
    session.timer = undefined
    void drain($, session, settings).catch(error => $.ui.log(`task-queue: ${messageOf(error)}`, { to: 'debug' }))
  })
}

// ── mods-hub: tasks on the bus, stop/pause/resume from anywhere, notices while you are away ────────

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** With mods-hub installed: hello, the Queue tab in its panel, and a watch on stop/pause/resume. */
async function greetHub($: EngineInterface, session: Session, settings: Settings): Promise<void> {
  session.hasHub = (await hubMode($)) !== undefined
  if (!session.hasHub) return
  session.controlSeenAt = await $.clock.now()
  await hubHello($, { version: await ownVersion($), publishes: ['task.queued', 'task.started', 'task.finished'], consumes: ['session.idle', 'control.stop', 'control.pause', 'control.resume'] }, TAB)
  $.clock.every(CONTROL_POLL_MS, () => void obeyControl($, session, settings).catch(() => undefined))
}

/**
 * A stop or pause raised through mods-hub (a STOP from the phone, mission-control, autopilot) pauses the queue;
 * the prompt already running finishes. A resume lifts a pause the hub caused, never one you made yourself.
 */
async function obeyControl($: EngineInterface, session: Session, settings: Settings): Promise<void> {
  if (!session.hasHub) return
  let events
  try {
    events = await $.mods.recent({ prefix: 'control.', since: session.controlSeenAt })
  } catch {
    return
  }
  for (const event of events) {
    session.controlSeenAt = Math.max(session.controlSeenAt, event.at)
    const { by, reason } = event.data as { by?: unknown; reason?: unknown }
    if (event.topic === 'control.stop' || event.topic === 'control.pause') {
      session.timer?.cancel()
      const what = `${event.topic === 'control.stop' ? 'stopped' : 'paused'} by ${String(by ?? event.source)}${typeof reason === 'string' && reason !== '' ? ` (${reason})` : ''}`
      await commit($, session, view => ({ ...view, isPaused: true, pauseReason: what }))
      session.isPausedByControl = true
    } else if (event.topic === 'control.resume' && session.isPausedByControl) {
      session.isPausedByControl = false
      await resume($, session, settings)
    }
  }
}

/** A queue event on the hub's bus (autopilot, workflow-studio, mission-control); nothing without the hub. */
async function publishTask($: EngineInterface, session: Session, input: { id: string; text: string; outcome?: QueueOutcome }, topic: 'task.queued' | 'task.started' | 'task.finished'): Promise<void> {
  if (!session.hasHub) return
  const title = oneLine(input.text, TITLE_CHARS)
  if (topic === 'task.finished') await hubPublish($, { topic, data: { id: input.id, title, outcome: TASK_OUTCOME[input.outcome ?? 'done'] } })
  else await hubPublish($, { topic, data: { id: input.id, title } })
}

/** Whether mods-hub says you are away from the keyboard (`session.idle` / `session.away`); false without it. */
async function isAway($: EngineInterface): Promise<boolean> {
  const mode = await hubMode($)
  return mode !== undefined && mode.presence !== 'here'
}

const isBusy = (session: Session): boolean => session.isTurnRunning || session.isSubmitting || session.personSubmitting > 0

/** Ends the running prompt with `outcome`; a `pauseReason` pauses the queue too. */
async function finish(
  $: EngineInterface,
  session: Session,
  id: string,
  outcome: QueueOutcome,
  pauseReason?: string,
  durationMs?: number,
): Promise<void> {
  const endedAt = await $.clock.now()
  const ran = (await read($, viewAtom)).running
  await commit($, session, view => {
    if (view.running?.id !== id) return view
    const done: QueueFinished = { id, text: view.running.text, outcome, endedAt, ...(durationMs === undefined ? {} : { durationMs }) }
    return {
      ...view,
      running: null,
      recent: [done, ...view.recent].slice(0, RECENT_KEPT),
      isPaused: view.isPaused || pauseReason !== undefined,
      pauseReason: pauseReason ?? view.pauseReason,
    }
  })
  if (ran?.id === id) await publishTask($, session, { id, text: ran.text, outcome }, 'task.finished')
}

/** Submits the next queued prompt, only while the session is idle and the queue may run. */
async function drain($: EngineInterface, session: Session, settings: Settings): Promise<void> {
  await obeyControl($, session, settings)
  const view = await read($, viewAtom)
  if (view.isPaused || view.running !== null || view.items.length === 0 || isBusy(session)) return

  if (view.streak >= settings.maxRuns) {
    const why = `${plural(settings.maxRuns, 'prompt')} ran in a row without you`
    await commit($, session, latest => ({ ...latest, isPaused: true, pauseReason: why }))
    await hubNotify($, { level: 'warning', title: `⏸ queue paused: ${why} · /queue resume to go on`, topic: 'task.finished' })
    return
  }

  const draft = await $.prompt.read().catch(() => ({ text: '', cursor: 0 }))
  if (draft.text.trim() !== '') {
    // Never take the turn from under a prompt you are typing.
    schedule($, session, settings, DRAFT_RETRY_MS)
    return
  }
  if (isBusy(session)) return

  const startedAt = await $.clock.now()
  const picked: { item?: QueueItem } = {}
  await commit($, session, latest => {
    const [first, ...rest] = latest.items
    picked.item = undefined
    if (latest.isPaused || latest.running !== null || first === undefined) return latest
    picked.item = first
    return { ...latest, items: rest, running: { ...first, startedAt }, streak: latest.streak + 1 }
  })
  const item = picked.item
  if (item === undefined) return

  session.isSubmitting = true
  try {
    const submitted = await $.prompt.submit({ text: item.text, asUser: true })
    if (submitted.drop === undefined) await publishTask($, session, item, 'task.started')
    if (submitted.drop !== undefined) await finish($, session, item.id, 'dropped', `a hook refused it: ${oneLine(submitted.drop, 80)}`)
  } catch (error) {
    await finish($, session, item.id, 'failed', `it could not be submitted: ${oneLine(messageOf(error), 80)}`)
  } finally {
    session.isSubmitting = false
  }
  $.clock.after(START_TIMEOUT_MS, () => void giveUpIfNeverStarted($, session, item.id))
}

async function giveUpIfNeverStarted($: EngineInterface, session: Session, id: string): Promise<void> {
  const { running } = await read($, viewAtom)
  if (running?.id === id && running.turnId === undefined && !session.isTurnRunning) {
    await finish($, session, id, 'failed', 'a queued prompt never started')
  }
}

async function add($: EngineInterface, session: Session, settings: Settings, text: string): Promise<string> {
  if (text.length > MAX_PROMPT_CHARS) return `That prompt is too long to queue (${text.length} characters, the limit is ${MAX_PROMPT_CHARS}).`
  if ((await read($, viewAtom)).items.length >= MAX_ITEMS) {
    return `The queue is full (${MAX_ITEMS} prompts). Make room with /queue remove <n> or /queue clear.`
  }
  const item: QueueItem = { id: crypto.randomUUID(), text, addedAt: await $.clock.now() }
  const view = await commit($, session, latest => ({ ...latest, items: [...latest.items, item] }))
  await publishTask($, session, item, 'task.queued')
  const label = `#${view.items.findIndex(one => one.id === item.id) + 1}: ${oneLine(text, 60)}`
  if (view.isPaused) return `Queued ${label} · the queue is paused, /queue resume runs it.`
  if (isBusy(session) || view.running !== null) return `Queued ${label} · it runs when Claude is free.`
  schedule($, session, settings, START_DELAY_MS)
  return `Queued ${label} · starting now.`
}

async function remove($: EngineInterface, session: Session, position: number): Promise<string> {
  const target = (await read($, viewAtom)).items[position - 1]
  if (target === undefined) return `There is no #${position} in the queue. /queue list shows the numbers.`
  await commit($, session, view => ({ ...view, items: view.items.filter(one => one.id !== target.id) }))
  return `Removed #${position}: ${oneLine(target.text, 60)}`
}

async function removeById($: EngineInterface, session: Session, id: string): Promise<void> {
  await commit($, session, view => ({ ...view, items: view.items.filter(one => one.id !== id) }))
}

async function move($: EngineInterface, session: Session, id: string, by: number): Promise<void> {
  await commit($, session, view => ({ ...view, items: moveItem(view.items, view.items.findIndex(one => one.id === id), by) }))
}

async function clear($: EngineInterface, session: Session): Promise<string> {
  const before = (await read($, viewAtom)).items.length
  await commit($, session, view => ({ ...view, items: [] }))
  return before === 0 ? 'The queue was already empty.' : `Cleared ${plural(before, 'queued prompt')}.`
}

async function pause($: EngineInterface, session: Session): Promise<string> {
  session.timer?.cancel()
  const view = await commit($, session, latest => ({ ...latest, isPaused: true, pauseReason: 'paused by you' }))
  const current = view.running === null ? '' : ' The prompt already running finishes first.'
  return `Paused with ${plural(view.items.length, 'prompt')} waiting.${current} /queue resume to go on.`
}

async function resume($: EngineInterface, session: Session, settings: Settings): Promise<string> {
  session.isPausedByControl = false
  const view = await commit($, session, latest => ({ ...latest, isPaused: false, pauseReason: '', streak: 0 }))
  if (view.items.length === 0) return 'Resumed. The queue is empty: add prompts with /queue <prompt>.'
  if (isBusy(session) || view.running !== null) return `Resumed: ${plural(view.items.length, 'prompt')} waiting, the next runs when Claude is free.`
  schedule($, session, settings, START_DELAY_MS)
  return `Resumed: starting ${oneLine(view.items[0]?.text ?? '', 60)}`
}

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: PANE_TITLE, rows: PANE_ROWS })
}

async function runCommand($: EngineInterface, session: Session, settings: Settings, args: string): Promise<string> {
  const command = parseQueueArgs(args)
  switch (command.kind) {
    case 'open': {
      if (!(await hubShowTab($, TAB.id))) await openPane($)
      return listText(await read($, viewAtom))
    }
    case 'list':
      return listText(await read($, viewAtom))
    case 'add':
      return add($, session, settings, command.text)
    case 'remove':
      return remove($, session, command.position)
    case 'clear':
      return clear($, session)
    case 'pause':
      return pause($, session)
    case 'resume':
      return resume($, session, settings)
    case 'usage':
      return `Usage: ${command.why}`
  }
}

/** After a main-loop turn: settles the queued prompt it ran, pauses on an interruption or error, and lines up the next. */
async function afterTurn(
  $: EngineInterface,
  session: Session,
  settings: Settings,
  turn: { turnId: string; reason: string; durationMs: number },
): Promise<void> {
  const view = await read($, viewAtom)
  const { running } = view
  const isQueued = running !== null && (running.turnId === undefined || running.turnId === turn.turnId)
  const isClean = turn.reason === 'answer'
  const why = turn.reason === 'aborted' ? 'you interrupted a turn' : `a turn ended with ${turn.reason === 'error' ? 'an error' : 'a refusal'}`

  if (isQueued) {
    const outcome: QueueOutcome = isClean ? 'done' : turn.reason === 'aborted' ? 'interrupted' : 'failed'
    await finish($, session, running.id, outcome, isClean ? undefined : why, turn.durationMs)
  } else if (!isClean && view.items.length > 0 && !view.isPaused) {
    await commit($, session, latest => ({ ...latest, isPaused: true, pauseReason: why }))
  }

  const after = await read($, viewAtom)
  if (!isClean && after.items.length > 0) await hubNotify($, { level: 'warning', title: `⏸ queue paused: ${why} · /queue resume to go on`, topic: 'task.finished' })
  if (!after.isPaused && after.items.length > 0) schedule($, session, settings, SETTLE_MS)
  // With mods-hub, while you are away: the queue's last prompt is done (the notice reaches your channels).
  if (isQueued && isClean && after.items.length === 0 && (await isAway($))) {
    const ran = after.recent.filter(done => done.outcome === 'done').length
    await hubNotify($, { level: 'success', title: `✓ Queue done: ${plural(ran, 'prompt')} ran`, body: oneLine(running.text, TITLE_CHARS), topic: 'task.finished' })
  }
}

/** The queue: this mod's own pane, or its tab in the hub's panel (`isTab`, no Close button). */
async function drawQueue($: EngineInterface, e: RenderInput<'Pane'>, session: Session, settings: Settings, isTab: boolean): Promise<RenderElement> {
  const elements = $.ui.resolve(e)
  const { Box, Button, Text } = elements
  const Input = 'Input' in elements ? elements.Input : undefined
  const view = await read($, viewAtom)
  const now = await $.clock.now()
  const width = Math.max(20, e.props.bodyColumns)
  const rowText = Math.max(10, width - 14)
  const waiting = view.items.length
  const headline = view.isPaused
    ? `⏸ Paused${view.pauseReason ? `: ${view.pauseReason}` : ''}`
    : waiting === 0 && view.running === null
      ? 'Nothing queued'
      : `⏭ ${plural(waiting, 'prompt')} waiting · each runs when Claude is free`

  return (
    <Box flexDirection="column" gap={1}>
      <Box key="headline">
        <Text bold color={view.isPaused ? 'warning' : undefined} wrap="truncate-end">
          {headline}
        </Text>
      </Box>
      {view.running !== null && (
        <Box key="running" flexDirection="row" gap={1}>
          <Text color="suggestion">▶</Text>
          <Box flexGrow={1}>
            <Text wrap="truncate-end">{oneLine(view.running.text, rowText)}</Text>
          </Box>
          <Text dimColor>{shortDuration(now - view.running.startedAt)}</Text>
        </Box>
      )}
      {waiting > 0 && (
        <Box flexDirection="column">
          {view.items.map((item, index) => (
            <Box key={`item:${item.id}`} flexDirection="row" gap={1}>
              <Text dimColor>{String(index + 1).padStart(2)}</Text>
              <Box flexGrow={1}>
                <Text wrap="truncate-end">{oneLine(item.text, rowText)}</Text>
              </Box>
              <Button key={`up:${item.id}`} label="↑" plain dimColor={index === 0} onPress={() => void move($, session, item.id, -1)} />
              <Button key={`down:${item.id}`} label="↓" plain dimColor={index === waiting - 1} onPress={() => void move($, session, item.id, 1)} />
              <Button key={`remove:${item.id}`} label="✕" plain onPress={() => void removeById($, session, item.id)} />
            </Box>
          ))}
        </Box>
      )}
      {Input !== undefined && waiting < MAX_ITEMS && (
        <Input
          key="add"
          label="Add "
          placeholder="a prompt to run after the others"
          submitLabel="queue"
          onSubmit={value => {
            if (value.trim() !== '') void add($, session, settings, value.trim())
          }}
        />
      )}
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {view.isPaused ? (
          <Button key="resume" label="Resume" hotkey="r" variant="primary" onPress={() => void resume($, session, settings)} />
        ) : (
          <Button key="pause" label="Pause" hotkey="p" onPress={() => void pause($, session)} />
        )}
        {waiting > 0 && <Button key="clear" label="Clear" onPress={() => void clear($, session)} />}
        {!isTab && <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />}
      </Box>
      {view.recent.length > 0 && (
        <Box key="recent" flexDirection="column">
          <Text dimColor>Recent</Text>
          {view.recent.slice(0, RECENT_SHOWN).map(done => (
            <Box key={`done:${done.id}`} flexDirection="row" gap={1}>
              <Text color={OUTCOME_GLYPHS[done.outcome].color}>{OUTCOME_GLYPHS[done.outcome].glyph}</Text>
              <Box flexGrow={1}>
                <Text dimColor wrap="truncate-end">
                  {oneLine(done.text, rowText)}
                </Text>
              </Box>
              <Text dimColor>{done.durationMs === undefined ? done.outcome : shortDuration(done.durationMs)}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)
  const session: Session = {
    root: undefined,
    isTurnRunning: false,
    personSubmitting: 0,
    isSubmitting: false,
    timer: undefined,
    hasHub: false,
    controlSeenAt: 0,
    isPausedByControl: false,
  }

  on('session.start', async ($, e, next) => {
    await registerCommand($, {
      name: 'queue',
      description: 'Queue prompts that run one after another whenever Claude is free',
      argumentHint: '[<prompt> | list | remove <n> | clear | pause | resume]',
      immediate: true,
    })
    try {
      await restore($, session)
    } catch (error) {
      $.ui.log(`task-queue: could not load the queue: ${messageOf(error)}`, { to: 'debug' })
    }
    afterStart($, 'task-queue', () => greetHub($, session, settings))
    return next(e)
  })

  on('command.run', { command: 'queue' }, async ($, e) => {
    try {
      return { text: await runCommand($, session, settings, e.args) }
    } catch (error) {
      return { text: `The queue command failed: ${messageOf(error)}` }
    }
  })

  // A prompt you type resets the runaway count, and holds the queue back until its turn has started.
  on('prompt.submit', async ($, e, next) => {
    if (!PERSON_ORIGINS.has(e.origin.kind)) return next(e)
    session.personSubmitting += 1
    try {
      const entered = await next(e)
      if (entered.drop === undefined && (await read($, viewAtom)).streak > 0) await update($, viewAtom, view => ({ ...view, streak: 0 }))
      return entered
    } finally {
      session.personSubmitting -= 1
    }
  })

  on('turn.start', async ($, e, next) => {
    session.isTurnRunning = true
    session.timer?.cancel()
    const { running } = await read($, viewAtom)
    if (running !== null && running.turnId === undefined) {
      await update($, viewAtom, view =>
        view.running !== null && view.running.turnId === undefined ? { ...view, running: { ...view.running, turnId: e.turnId } } : view,
      )
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    session.isTurnRunning = false
    try {
      await afterTurn($, session, settings, e)
    } catch (error) {
      $.ui.log(`task-queue: ${messageOf(error)}`, { to: 'debug' })
    }
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawQueue($, e, session, settings, false))

  // The Queue tab: drawn beneath the hub's tab strip when it is the tab shown; any other tab passes through.
  on('ui.render', { component: 'Pane', requestId: HUB_PANE }, async ($, e, next) => {
    if (!(await hubTabIs($, TAB.id))) return next(e)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {await next(e)}
        {await drawQueue($, e, session, settings, true)}
      </Box>
    )
  })
}

/** Registers a slash command. A refused name (Claude Code's own, or another mod's) is reported as a notice, never thrown, so the rest of session.start still runs. */
async function registerCommand($: EngineInterface, spec: Parameters<EngineInterface['command']['register']>[0]): Promise<boolean> {
  try {
    await $.command.register(spec)
    return true
  } catch (error) {
    $.ui.log(`${$.plugin.name}: /${spec.name} was not registered (${error instanceof Error ? error.message : String(error)}).`)
    return false
  }
}

// #region @vendored shared/hub-client.ts sha256:6b153e2e759f: edit the source, then run `node scripts/sync-shared.mjs`.
// mods-hub client (docs/MOD_CONTRACT.md): uses the hub when it is installed, keeps working when it is not.

type HubMods = EngineInterface['mods']

/** Publishes an event on the hub's bus; false when there is no hub or it refused the event. */
async function hubPublish($: EngineInterface, input: Parameters<HubMods['publish']>[0]): Promise<boolean> {
  try {
    await $.mods.publish(input)
    return true
  } catch {
    return false
  }
}

/**
 * Routes a notification through the hub (channels, silent, night, presence), or shows it as a toast when there is
 * no hub: `title — body`, for `fallback.timeoutMs` when given (the toast's own option).
 */
async function hubNotify($: EngineInterface, input: Parameters<HubMods['notify']>[0], fallback: { timeoutMs?: number } = {}): Promise<void> {
  try {
    await $.mods.notify(input)
  } catch {
    const text = input.body === undefined || input.body === '' ? input.title : `${input.title} — ${input.body}`
    if (fallback.timeoutMs === undefined) $.ui.toast(text)
    else $.ui.toast(text, { timeoutMs: fallback.timeoutMs })
  }
}

/** The global mode (presence, silent, night, interaction), or undefined when there is no hub. */
async function hubMode($: EngineInterface): Promise<Awaited<ReturnType<HubMods['mode']>> | undefined> {
  try {
    return await $.mods.mode()
  } catch {
    return undefined
  }
}

/** Announces this mod to the hub, with its panel tab when it has one; call once from `session.start`. */
async function hubHello($: EngineInterface, hello: Parameters<HubMods['hello']>[0], tab?: Parameters<HubMods['registerTab']>[0]): Promise<boolean> {
  try {
    await $.mods.hello(hello)
    if (tab !== undefined) await $.mods.registerTab(tab)
    return true
  } catch {
    return false
  }
}

/** Opens the shared panel on this mod's tab; false when there is no hub (open your own pane then). */
async function hubShowTab($: EngineInterface, id: string): Promise<boolean> {
  try {
    return (await $.mods.showTab({ id })).isPlaced
  } catch {
    return false
  }
}

/**
 * Stops, pauses or resumes the automatic work (`control.stop` / `control.pause` / `control.resume`) in this session
 * or, with `scope: 'all'`, in every session; false when there is no hub (stop what you run yourself then).
 */
async function hubStop($: EngineInterface, input: Parameters<HubMods['stop']>[0]): Promise<boolean> {
  try {
    await $.mods.stop(input)
    return true
  } catch {
    return false
  }
}

/** Puts a fact on the hub's blackboard as `<this mod>.<name>`; false when there is no hub or it refused the fact. */
async function hubShareFact($: EngineInterface, input: Parameters<HubMods['share']>[0]): Promise<boolean> {
  try {
    await $.mods.share(input)
    return true
  } catch {
    return false
  }
}

/** A fact from the hub's blackboard by its full key (`stack-detector.stack`); undefined when there is no hub or no such fact. */
async function hubReadFact($: EngineInterface, key: string): Promise<Awaited<ReturnType<HubMods['read']>> | undefined> {
  try {
    return (await $.mods.read({ key })) ?? undefined
  } catch {
    return undefined
  }
}

/** Whether the shared panel shows tab `id` now; read while drawing, it subscribes the drawing. */
async function hubTabIs($: EngineInterface, id: string): Promise<boolean> {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
  return value === id
}
/**
 * Runs a mod's start-up work (the hub hello, a first scan, loading what it keeps) once `session.start` has returned,
 * after a short delay staggered by the mod's name (0.15–1.35 s), so ~200 mods sharing one hooks worker do not all wait
 * on the hub, a process or the disk inside the session.start chain (`ran past its 10s budget`). A failure is logged
 * to the debug log. Call it from `session.start` in place of `await work()`; never await the hub there
 * (scripts/check-startup.mjs).
 */
function afterStart($: EngineInterface, mod: string, work: () => Promise<unknown>): void {
  let hash = 7
  for (let i = 0; i < mod.length; i += 1) hash = (hash * 31 + mod.charCodeAt(i)) % 1_200
  $.clock.after(150 + hash, () => {
    void work().catch(error => $.ui.log(`${mod}: start-up work failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' }))
  })
}
// #endregion @vendored shared/hub-client.ts
