import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register, RenderElement, RenderInput, Timer } from 'claude-code'

import type { DevServerLine as Line, DevServerRun as Run, DevServerStatus as Status } from '../types'
import { NESTED_PATHS, VENV_PYTHONS, detectCommand, shortCommand } from './detect'
import type { Detected, Project } from './detect'
import { findUrl, kindOf, lastErrorBlock, splitLines } from './output'

const PANE = 'dev-server'
const PANE_TITLE = 'Dev server'
/** The hub's shared panel, and this mod's tab in it (order 300: the last of the dashboards). The own pane stays for a full-size view. */
const HUB_PANE = 'claude-mods'
const TAB = { id: 'devserver', title: PANE_TITLE, order: 300, command: 'dev' } as const
/** At most one `build.result` for new errors per this long: a server that logs errors in a loop must not flood the bus. */
const REPORT_GAP_MS = 5_000
const COMMAND_CHARS = 200
const MAX_LINES = 500
const MAX_LINE_CHARS = 2_000
const MAX_PARTIAL_CHARS = 64_000
/** How much text the pane draws, newest lines first, well inside a tree's 100,000 characters. */
const DRAWN_CHARS = 60_000
const FLUSH_MS = 200
const STOP_WAIT_MS = 5_000
/** Keep servers from opening a browser, and their output plain. */
const SERVER_ENV = { BROWSER: 'none', FORCE_COLOR: '0' }
const IDLE: Run = {
  status: 'idle',
  command: null,
  source: null,
  cwd: null,
  url: null,
  startedAt: 0,
  endedAt: null,
  exitCode: null,
  signal: null,
  note: null,
  errors: 0,
}
const STATUS_LOOK: Record<Status, { glyph: string; label: string; color: string }> = {
  idle: { glyph: '○', label: 'not started', color: 'subtle' },
  running: { glyph: '●', label: 'running', color: 'success' },
  exited: { glyph: '✗', label: 'exited', color: 'error' },
  stopped: { glyph: '■', label: 'stopped', color: 'subtle' },
  failed: { glyph: '✗', label: 'could not start', color: 'error' },
}
const LINE_COLOR: Record<Line['kind'], string | undefined> = { error: 'error', warning: 'warning', info: undefined }

const runAtom = atom({ plugin: 'dev-server-pane', key: 'run' } as const, IDLE)
const linesAtom = atom({ plugin: 'dev-server-pane', key: 'lines' } as const, [])

type Stream = HookStream<ProcessSpawnChunk, ProcessSpawnResult>

/** One started server: its output stream and what was read from it. */
type Child = {
  stream: Stream
  lines: Line[]
  partial: Record<ProcessSpawnChunk['stream'], string>
  url: string | null
  errors: number
  isStopping: boolean
  flush: Timer | undefined
  done: Promise<void>
  /** What was told to the hub's bus: whether the server came up, how many errors were reported, and when last. */
  isReady: boolean
  reportedErrors: number
  lastReportAt: number
}

/** What this load of the mod holds: the running server, the latest one started, what the model was last told. */
type Host = { child: Child | undefined; latest: Child | undefined; configured: string; status: string | undefined; told: string; isHubbed: boolean }

const reasonOf = (error: unknown): string => {
  const text = String(error instanceof Error ? error.message : error)
  return (/\$\.process\.spawn:\s*(.+)$/s.exec(text)?.[1] ?? text).trim()
}

/** A fence longer than any run of backticks in `text`. */
const fenced = (text: string): string => {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(run => run[0].length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}\n${text}\n${fence}`
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

const hostOf = (url: string | null): string | null => url?.replace(/^https?:\/\//, '').replace(/\/$/, '') ?? null

/** The newest lines whose text fits in DRAWN_CHARS, oldest first. */
const visibleLines = (lines: readonly Line[]): Line[] => {
  let budget = DRAWN_CHARS
  let first = lines.length
  while (first > 0) {
    const size = (lines[first - 1]?.text.length ?? 0) + 1
    if (size > budget) break
    budget -= size
    first -= 1
  }
  return lines.slice(first)
}

function setStatus($: EngineInterface, host: Host, text: string | undefined): void {
  if (host.status === text) return
  host.status = text
  $.ui.status(text)
}

function runningStatus(child: Child, command: string): string {
  const where = hostOf(child.url) ?? shortCommand(command)
  return child.errors > 0 ? `▶ dev · ${where} · ✗ ${plural(child.errors, 'error')}` : `▶ dev · ${where}`
}

function push(child: Child, text: string, stream: Line['stream']): void {
  const line: Line = { text: text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text, stream, kind: kindOf(text) }
  if (line.kind === 'error') child.errors += 1
  if (child.url === null) child.url = findUrl(text) ?? null
  child.lines.push(line)
  if (child.lines.length > MAX_LINES) child.lines.splice(0, child.lines.length - MAX_LINES)
}

/** The lines read so far, an unfinished last line included as it stands. */
function snapshot(child: Child): Line[] {
  const tails = (['stdout', 'stderr'] as const)
    .filter(stream => child.partial[stream].trim() !== '')
    .map(stream => {
      const text = splitLines('', `${child.partial[stream]}\n`).lines[0] ?? ''
      return { text, stream, kind: kindOf(text) }
    })
  return [...child.lines, ...tails].slice(-MAX_LINES)
}

async function publish($: EngineInterface, host: Host, child: Child): Promise<void> {
  if (host.latest !== child) return
  await update($, linesAtom, () => snapshot(child))
  const run = await update($, runAtom, (latest: Run) => ({ ...latest, url: child.url ?? latest.url, errors: child.errors }))
  if (host.child === child && run.command !== null) setStatus($, host, runningStatus(child, run.command))
  if (host.child === child && run.command !== null) await reportBuild($, host, child, run.command)
}

/**
 * Tells mods-hub's bus (`build.result`) how the dev server stands: up (a URL appeared and no error so far), failing
 * (more errors than the last report, at most one report per few seconds), or dead. Nothing without the hub.
 */
async function reportBuild($: EngineInterface, host: Host, child: Child, command: string): Promise<void> {
  if (!host.isHubbed) return
  const tool = shortCommand(command)
  const now = await $.clock.now()
  if (child.errors > child.reportedErrors && now - child.lastReportAt >= REPORT_GAP_MS) {
    child.reportedErrors = child.errors
    child.lastReportAt = now
    await hubPublish($, { topic: 'build.result', data: { tool, outcome: 'failed', command: command.slice(0, COMMAND_CHARS), errors: child.errors } })
  } else if (!child.isReady && child.url !== null && child.errors === 0) {
    child.isReady = true
    await hubPublish($, { topic: 'build.result', data: { tool, outcome: 'passed', command: command.slice(0, COMMAND_CHARS) } })
  }
}

function scheduleFlush($: EngineInterface, host: Host, child: Child): void {
  if (child.flush !== undefined) return
  child.flush = $.clock.after(FLUSH_MS, () => {
    child.flush = undefined
    void publish($, host, child)
  })
}

/** Records how a server ended, and says so when it was not asked to stop. */
async function finish($: EngineInterface, host: Host, child: Child, ended: ProcessSpawnResult | undefined, failure: string | undefined): Promise<void> {
  child.flush?.cancel()
  child.flush = undefined
  for (const stream of ['stdout', 'stderr'] as const) {
    if (child.partial[stream] !== '') for (const text of splitLines('', `${child.partial[stream]}\n`).lines) push(child, text, stream)
    child.partial[stream] = ''
  }
  if (host.child === child) host.child = undefined
  if (host.latest !== child) return

  const code = ended?.code ?? null
  const signal = ended?.signal ?? null
  const status: Status = failure !== undefined ? 'failed' : child.isStopping ? 'stopped' : 'exited'
  const note =
    status === 'failed'
      ? `Could not start: ${failure}`
      : status === 'stopped'
        ? 'Stopped.'
        : code !== null
          ? `Exited with code ${code}.`
          : `Ended by ${signal ?? 'a signal'}.`
  const endedAt = await $.clock.now()
  await update($, linesAtom, () => snapshot(child))
  const run = await update($, runAtom, (latest: Run) => ({ ...latest, status, note, endedAt, exitCode: code, signal, url: child.url ?? latest.url, errors: child.errors }))

  if (status === 'stopped') {
    setStatus($, host, undefined)
    return
  }
  const what = status === 'failed' ? 'could not start' : code !== null ? `exited (${code})` : 'was killed'
  setStatus($, host, `✗ dev ${what} · /dev`)
  if (host.isHubbed && run.command !== null) {
    await hubPublish($, { topic: 'build.result', data: { tool: shortCommand(run.command), outcome: 'error', command: run.command.slice(0, COMMAND_CHARS), errors: child.errors } })
  }
  // An error notice through the hub (your phone channel while you are away); a toast without it.
  await hubNotify($, { level: 'error', title: `${shortCommand(run.command ?? 'dev server')} ${what}. /dev shows its output.` })
}

/** Reads the server's output until it ends: the loop is the child's life. */
async function pump($: EngineInterface, host: Host, child: Child): Promise<void> {
  let ended: ProcessSpawnResult | undefined
  let failure: string | undefined
  try {
    for (;;) {
      const step = await child.stream.next()
      if (step.done === true) {
        ended = step.value ?? undefined
        break
      }
      const { lines, partial } = splitLines(child.partial[step.value.stream], step.value.text)
      // A progress line redrawn with \r and never ended would grow without bound: only its latest text is shown.
      child.partial[step.value.stream] = partial.length > MAX_PARTIAL_CHARS ? partial.slice(-MAX_LINE_CHARS) : partial
      for (const text of lines) push(child, text, step.value.stream)
      scheduleFlush($, host, child)
    }
  } catch (error) {
    failure = reasonOf(error)
  }
  try {
    await finish($, host, child, ended, failure)
  } catch {
    // The session or this load of the mod ended first: nothing is left to tell.
  }
}

/** Stops the running server and waits for it to end; false when none runs. */
async function stop($: EngineInterface, host: Host): Promise<boolean> {
  const child = host.child
  if (child === undefined) return false
  child.isStopping = true
  try {
    await child.stream.return({ code: null, signal: 'SIGTERM' })
  } catch {
    // Already ended: `done` settles either way.
  }
  await Promise.race([child.done, $.clock.sleep(STOP_WAIT_MS)])
  return true
}

async function start($: EngineInterface, host: Host, chosen: Detected, cwd: string): Promise<void> {
  await stop($, host)
  const startedAt = await $.clock.now()
  await update($, linesAtom, () => [])
  await update($, runAtom, (): Run => ({ ...IDLE, status: 'running', command: chosen.command, source: chosen.source, cwd, startedAt }))
  const child: Child = {
    stream: $.process.spawn({ argv: ['sh', '-c', chosen.command], cwd, env: SERVER_ENV }),
    lines: [],
    partial: { stdout: '', stderr: '' },
    url: null,
    errors: 0,
    isStopping: false,
    flush: undefined,
    done: Promise.resolve(),
    isReady: false,
    reportedErrors: 0,
    lastReportAt: Number.NEGATIVE_INFINITY,
  }
  host.child = child
  host.latest = child
  child.done = pump($, host, child)
  setStatus($, host, runningStatus(child, chosen.command))
}

/** The project's dev command: the configured one, else what the working folder holds. */
async function chooseCommand($: EngineInterface, host: Host, cwd: string): Promise<Detected | undefined> {
  if (host.configured !== '') return { command: host.configured, source: 'the command setting' }
  const entries = await $.fs.list(cwd).catch(() => [])
  const names = new Set(entries.map(entry => entry.name))
  for (const path of [...NESTED_PATHS, ...VENV_PYTHONS]) {
    if (names.has(path.split('/')[0] ?? path) && (await $.fs.exists(`${cwd}/${path}`).catch(() => false))) names.add(path)
  }
  const readText = async (name: string) => (names.has(name) ? await $.fs.read(`${cwd}/${name}`).catch(() => undefined) : undefined)
  const project: Project = { names, packageJson: await readText('package.json'), gemfile: await readText('Gemfile') }
  return detectCommand(project)
}

/** `/dev` shows the output: in the Dev server tab of the hub's panel when the hub is installed, in this mod's own pane otherwise. */
async function openPane($: EngineInterface): Promise<void> {
  const isTab = await hubShowTab($, TAB.id)
  if (!isTab) await $.ui.open({ id: PANE, title: PANE_TITLE })
  await $.ui.scroll({ in: isTab ? HUB_PANE : PANE, to: 'end' }).catch(() => undefined)
}

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** With mods-hub installed: hello (this mod publishes `build.result`) and the Dev server tab in its panel. */
async function greetHub($: EngineInterface, host: Host): Promise<void> {
  if ((await hubMode($)) === undefined) return
  host.isHubbed = await hubHello($, { version: await ownVersion($), publishes: ['build.result'], consumes: [] }, TAB)
}

/** Starts the last command again (or the detected one), in the folder it ran in. */
async function restart($: EngineInterface, host: Host): Promise<string> {
  const run = await read($, runAtom)
  const cwd = run.cwd ?? (await $.session.cwd())
  const chosen = run.command !== null ? { command: run.command, source: run.source ?? 'the last run' } : await chooseCommand($, host, cwd)
  if (chosen === undefined) return 'No dev command found here. Run /dev <command>.'
  await start($, host, chosen, cwd)
  return `Restarted ${chosen.command}.`
}

async function askToFix($: EngineInterface, run: Run, block: string): Promise<void> {
  const where = run.url === null ? '' : ` (${run.url})`
  const after =
    run.status === 'running'
      ? 'It keeps running in the background and reloads on its own: do not start another one.'
      : 'It has stopped; I will restart it from the Dev server pane once it is fixed.'
  const text = [`My dev server \`${run.command ?? 'dev server'}\`${where} printed this error:`, '', fenced(block), '', `Find the cause in the code and fix it. ${after}`].join('\n')
  await $.prompt.submit({ text, asUser: true })
}

/** One line for the model when the server's state changed since it was last told: it should not start a second one. */
function noteFor(host: Host, run: Run): string | undefined {
  if (run.command === null) return undefined
  const isRunning = host.child !== undefined && run.status === 'running'
  const key = `${run.startedAt}|${isRunning ? (run.url ?? '') : run.status}`
  if (key === host.told || (!isRunning && host.told === '')) return undefined
  host.told = key
  const where = run.url === null ? '' : ` at ${run.url}`
  return isRunning
    ? `dev-server-pane: the dev server is already running in the background (\`${run.command}\` in ${run.cwd ?? 'the working folder'}${where}); the user watches its output in a pane. Don't start another one.`
    : `dev-server-pane: the background dev server (\`${run.command}\`) is no longer running (${(run.note ?? run.status).replace(/\.$/, '')}).`
}

export const register: Register = (on, options) => {
  const host: Host = { child: undefined, latest: undefined, configured: String(options.command ?? '').trim(), status: undefined, told: '', isHubbed: false }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'dev',
      description: 'Start the dev server in the background with a live pane (/dev stop, /dev restart)',
      argumentHint: '[command | stop | restart]',
    })
    await greetHub($, host)
    // A fresh load of the mod: whatever the previous load started ended with it.
    const run = await read($, runAtom)
    if (run.status === 'running' && host.child === undefined) {
      await update($, runAtom, (latest: Run): Run => ({ ...latest, status: 'stopped', note: 'Stopped when the mod reloaded.' }))
    }
    return next(e)
  })

  on('command.run', { command: 'dev' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'stop') return { text: (await stop($, host)) ? 'Dev server stopped.' : 'No dev server is running.' }
    if (arg === 'restart') {
      const text = await restart($, host)
      await openPane($)
      return { text }
    }
    const current = await read($, runAtom)
    if (arg === '' && host.child !== undefined) {
      await openPane($)
      return { text: `Dev server running: ${current.command ?? ''}${current.url === null ? '' : ` at ${current.url}`}` }
    }

    const cwd = await $.session.cwd()
    const chosen = arg !== '' ? { command: arg, source: '/dev argument' } : await chooseCommand($, host, cwd)
    if (chosen === undefined) {
      return { text: 'No dev command found here (package.json dev/start script, manage.py, Rails, Phoenix or Laravel). Run /dev <command>.' }
    }
    await start($, host, chosen, cwd)
    await openPane($)
    return { text: `Started ${chosen.command} (${chosen.source}). /dev stop stops it.` }
  })

  on('prompt.submit', async ($, e, next) => {
    const note = noteFor(host, await read($, runAtom))
    return next(note === undefined ? e : { ...e, context: [...(e.context ?? []), note] })
  })

  on('session.end', async ($, e, next) => {
    const child = host.child
    if (child !== undefined) {
      child.isStopping = true
      void child.stream.return({ code: null, signal: 'SIGTERM' }).catch(() => undefined)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawDevServer($, e, host, false))

  // The Dev server tab: drawn beneath the hub's tab strip when it is the tab shown; any other tab passes through.
  on('ui.render', { component: 'Pane', requestId: HUB_PANE }, async ($, e, next) => {
    if (!(await hubTabIs($, TAB.id))) return next(e)
    const { Box } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {await next(e)}
        {await drawDevServer($, e, host, true)}
      </Box>
    )
  })
}

/** The dev server view: this mod's own pane, or its Dev server tab in the hub's panel (`isTab`: no Close, a button to pop it out into its own pane). */
async function drawDevServer($: EngineInterface, e: RenderInput<'Pane'>, host: Host, isTab: boolean): Promise<RenderElement> {
  const { Box, Button, Link, Text } = $.ui.resolve(e)
  const run = await read($, runAtom)
  const lines = await read($, linesAtom)
  const close = isTab ? (
    <Button key="pane" label="Open as pane" onPress={() => void $.ui.open({ id: PANE, title: PANE_TITLE })} />
  ) : (
    <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
  )

  if (run.status === 'idle') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>No dev server yet</Text>
        <Text dimColor>/dev starts the project's dev command (package.json dev/start script, manage.py runserver, Rails, Phoenix, Laravel); /dev &lt;command&gt; runs your own.</Text>
        {close}
      </Box>
    )
  }

  const look = STATUS_LOOK[run.status]
  const isRunning = run.status === 'running'
  const label = run.status === 'exited' && run.exitCode !== null ? `${look.label} (${run.exitCode})` : look.label
  const block = lastErrorBlock(lines)
  const shown = visibleLines(lines)

  return (
    <Box flexDirection="column">
      <Box key="header" flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Text bold color={look.color}>
          {look.glyph} {label}
        </Text>
        <Text bold wrap="truncate-end">
          {run.command ?? ''}
        </Text>
        {run.url !== null &&
          (e.surface === 'terminal' ? <Link href={run.url} label={hostOf(run.url) ?? run.url} /> : <Text color="suggestion">{run.url}</Text>)}
        {run.errors > 0 && <Text color="error">{plural(run.errors, 'error')}</Text>}
      </Box>
      <Box key="meta">
        <Text dimColor wrap="truncate-end">
          {[run.note, run.source === null ? null : `from ${run.source}`, run.cwd].filter(part => part !== null).join(' · ')}
        </Text>
      </Box>
      <Box key="actions" flexDirection="row" flexWrap="wrap" gap={1} marginTop={1}>
        {isRunning ? (
          <Button key="stop" label="Stop" hotkey="s" onPress={() => void stop($, host)} />
        ) : (
          <Button key="start" label="Start" hotkey="s" variant="primary" onPress={() => void restart($, host)} />
        )}
        {isRunning && <Button key="restart" label="Restart" hotkey="r" onPress={() => void restart($, host)} />}
        {block !== undefined && (
          <Button key="fix" label="Ask Claude to fix" hotkey="f" variant={isRunning ? 'primary' : undefined} onPress={() => void askToFix($, run, block)} />
        )}
        {close}
      </Box>
      <Box key="output" flexDirection="column" marginTop={1}>
        {lines.length > shown.length && <Text dimColor>{`(${lines.length - shown.length} older lines not drawn)`}</Text>}
        {shown.length === 0 ? (
          <Text dimColor>{isRunning ? 'Waiting for output…' : 'No output.'}</Text>
        ) : (
          shown.map(line => (
            <Text color={LINE_COLOR[line.kind]} wrap={line.kind === 'error' ? 'wrap' : 'truncate-end'}>
              {line.text === '' ? ' ' : line.text}
            </Text>
          ))
        )}
      </Box>
    </Box>
  )
}

// #region @vendored shared/hub-client.ts sha256:0acb840d81b7: edit the source, then run `node scripts/sync-shared.mjs`.
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
// #endregion @vendored shared/hub-client.ts
