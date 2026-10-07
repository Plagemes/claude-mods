import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register, Timer } from 'claude-code'

import type { DevServerLine as Line, DevServerRun as Run, DevServerStatus as Status } from '../types'
import { NESTED_PATHS, VENV_PYTHONS, detectCommand, shortCommand } from './detect'
import type { Detected, Project } from './detect'
import { findUrl, kindOf, lastErrorBlock, splitLines } from './output'

const PANE = 'dev-server'
const PANE_TITLE = 'Dev server'
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
}

/** What this load of the mod holds: the running server, the latest one started, what the model was last told. */
type Host = { child: Child | undefined; latest: Child | undefined; configured: string; status: string | undefined; told: string }

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
  $.ui.toast(`${shortCommand(run.command ?? 'dev server')} ${what}. /dev shows its output.`)
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

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: PANE_TITLE })
  await $.ui.scroll({ in: PANE, to: 'end' }).catch(() => undefined)
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
  const host: Host = { child: undefined, latest: undefined, configured: String(options.command ?? '').trim(), status: undefined, told: '' }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'dev',
      description: 'Start the dev server in the background with a live pane (/dev stop, /dev restart)',
      argumentHint: '[command | stop | restart]',
    })
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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const run = await read($, runAtom)
    const lines = await read($, linesAtom)
    const close = <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />

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
  })
}
