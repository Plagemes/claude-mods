import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register, Timer } from 'claude-code'

import type { LogTailEntry as Entry, LogTailLine as Line, LogTailStatus as Status, LogTailView as View } from '../types'
import { compileFilter, kindOf, splitLines, targetOf, uniqueId, visible } from './lines'
import type { Target } from './lines'

const PANE_PREFIX = 'log-tail-'
const START_LINES = 200
const MAX_LINES = 1000
const MAX_LINE_CHARS = 2_000
/** How much text a pane draws, newest lines first, well inside a tree's 100,000 characters. */
const DRAWN_CHARS = 60_000
const SEND_LINES = 40
const FLUSH_MS = 200
const STOP_WAIT_MS = 5_000
const SPAWN_ENV = { NO_COLOR: '1' }
const USAGE = 'Usage: /tail <file> | docker:<container> | compose:<service>; /tail stop [id|all]; /tail lists the tails.'
const STATUS_LOOK: Record<Status, { glyph: string; label: string; color: string }> = {
  following: { glyph: '●', label: 'following', color: 'success' },
  ended: { glyph: '✗', label: 'ended', color: 'error' },
  stopped: { glyph: '■', label: 'stopped', color: 'subtle' },
  failed: { glyph: '✗', label: 'could not start', color: 'error' },
}
const LINE_COLOR: Record<Line['kind'], string | undefined> = { error: 'error', warning: 'warning', info: undefined }
const SOURCE_NAME: Record<View['source'], string> = { file: 'the log file', docker: 'the docker container', compose: 'the compose service' }

const tailsAtom = atom({ plugin: 'log-tail', key: 'tails' } as const, [])
const viewFamily = atom({ plugin: 'log-tail', key: 'view' } as const, null)
const linesFamily = atom({ plugin: 'log-tail', key: 'lines' } as const, [])

type Stream = HookStream<ProcessSpawnChunk, ProcessSpawnResult>

/** One followed target and what was read from it. */
type Tail = {
  id: string
  paneId: string
  target: Target
  stream: Stream
  lines: Line[]
  partial: Record<ProcessSpawnChunk['stream'], string>
  seq: number
  errors: number
  unseen: number
  isPaused: boolean
  isStopping: boolean
  isFollowing: boolean
  flush: Timer | undefined
  done: Promise<void>
}

/** What this load of the mod holds: its tails by id, and the status line last shown. */
type Host = { tails: Map<string, Tail>; status: string | undefined }

const plural = (count: number, word: string): string => `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`

const reasonOf = (error: unknown, executable: string): string => {
  const text = String(error instanceof Error ? error.message : error)
  if (/ENOENT|not found/i.test(text)) return `${executable} is not installed (or not on PATH).`
  return (/\$\.process\.spawn:\s*(.+)$/s.exec(text)?.[1] ?? text).trim()
}

/** A fence longer than any run of backticks in `text`. */
const fenced = (text: string): string => {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(run => run[0].length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}\n${text}\n${fence}`
}

const shortTarget = (view: Pick<View, 'source' | 'target'>): string =>
  view.source === 'file' ? view.target.slice(view.target.lastIndexOf('/') + 1) : `${view.source}:${view.target}`

/** The newest lines whose text fits in DRAWN_CHARS, oldest first. */
const drawable = (lines: readonly Line[]): Line[] => {
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

function refreshStatus($: EngineInterface, host: Host): void {
  const following = [...host.tails.values()].filter(tail => tail.isFollowing)
  const errors = following.reduce((sum, tail) => sum + tail.errors, 0)
  const only = following.length === 1 ? following[0] : undefined
  const what = only === undefined ? `${following.length} tails` : `tail ${shortTarget(only.target)}`
  const text = following.length === 0 ? undefined : errors > 0 ? `⇣ ${what} · ✗ ${plural(errors, 'error')}` : `⇣ ${what}`
  if (text === host.status) return
  host.status = text
  $.ui.status(text)
}

async function listTails($: EngineInterface, host: Host): Promise<void> {
  const entries: Entry[] = [...host.tails.values()].map(tail => ({
    id: tail.id,
    target: tail.target.target,
    source: tail.target.source,
    status: tail.isFollowing ? 'following' : tail.isStopping ? 'stopped' : 'ended',
  }))
  await update($, tailsAtom, () => entries)
  refreshStatus($, host)
}

function push(tail: Tail, text: string): void {
  tail.seq += 1
  const line: Line = { n: tail.seq, text: text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text, kind: kindOf(text) }
  if (line.kind === 'error') tail.errors += 1
  if (tail.isPaused) tail.unseen += 1
  tail.lines.push(line)
  if (tail.lines.length > MAX_LINES) tail.lines.splice(0, tail.lines.length - MAX_LINES)
}

async function publish($: EngineInterface, host: Host, tail: Tail): Promise<void> {
  if (host.tails.get(tail.id) !== tail) return
  if (!tail.isPaused) await update($, memberOf(linesFamily, { requestId: tail.paneId }), () => tail.lines.slice())
  await update($, memberOf(viewFamily, { requestId: tail.paneId }), (view: View | null) => (view === null ? view : { ...view, total: tail.seq, errors: tail.errors, unseen: tail.unseen }))
  refreshStatus($, host)
}

function scheduleFlush($: EngineInterface, host: Host, tail: Tail): void {
  if (tail.flush !== undefined) return
  tail.flush = $.clock.after(FLUSH_MS, () => {
    tail.flush = undefined
    void publish($, host, tail)
  })
}

async function finish($: EngineInterface, host: Host, tail: Tail, ended: ProcessSpawnResult | undefined, failure: string | undefined): Promise<void> {
  tail.flush?.cancel()
  tail.flush = undefined
  tail.isFollowing = false
  for (const stream of ['stdout', 'stderr'] as const) {
    if (tail.partial[stream] !== '') for (const text of splitLines('', `${tail.partial[stream]}\n`).lines) push(tail, text)
    tail.partial[stream] = ''
  }
  if (host.tails.get(tail.id) !== tail) return

  const status: Status = failure !== undefined ? 'failed' : tail.isStopping ? 'stopped' : 'ended'
  const code = ended?.code ?? null
  const note = failure ?? (status === 'stopped' ? 'Stopped.' : code !== null ? `Exited with code ${code}.` : `Ended by ${ended?.signal ?? 'a signal'}.`)
  tail.isPaused = false
  tail.unseen = 0
  await update($, memberOf(linesFamily, { requestId: tail.paneId }), () => tail.lines.slice())
  await update($, memberOf(viewFamily, { requestId: tail.paneId }), (view: View | null) =>
    view === null ? view : { ...view, status, note, isPaused: false, unseen: 0, total: tail.seq, errors: tail.errors },
  )
  await listTails($, host)
  if (status !== 'stopped') $.ui.toast(`tail ${shortTarget(tail.target)} ${status === 'failed' ? 'could not start' : 'ended'}: ${note}`)
}

/** Reads the followed output until the process ends: the loop is the child's life. */
async function pump($: EngineInterface, host: Host, tail: Tail): Promise<void> {
  let ended: ProcessSpawnResult | undefined
  let failure: string | undefined
  try {
    for (;;) {
      const step = await tail.stream.next()
      if (step.done === true) {
        ended = step.value ?? undefined
        break
      }
      const { lines, partial } = splitLines(tail.partial[step.value.stream], step.value.text)
      tail.partial[step.value.stream] = partial
      for (const text of lines) push(tail, text)
      scheduleFlush($, host, tail)
    }
  } catch (error) {
    failure = reasonOf(error, tail.target.argv[0] ?? 'the command')
  }
  try {
    await finish($, host, tail, ended, failure)
  } catch {
    // The session or this load of the mod ended first: nothing is left to tell.
  }
}

async function stopTail($: EngineInterface, tail: Tail): Promise<void> {
  if (!tail.isFollowing) return
  tail.isStopping = true
  try {
    await tail.stream.return({ code: null, signal: 'SIGTERM' })
  } catch {
    // Already ended: `done` settles either way.
  }
  await Promise.race([tail.done, $.clock.sleep(STOP_WAIT_MS)])
}

/** Starts following `target` under `id` (a new tail, or one that ended, in its own pane again). */
async function startTail($: EngineInterface, host: Host, target: Target, id: string, note: string | null): Promise<Tail> {
  const paneId = `${PANE_PREFIX}${id}`
  const previous = await read($, memberOf(viewFamily, { requestId: paneId }))
  const view: View = {
    id,
    source: target.source,
    target: target.target,
    command: target.argv.join(' '),
    status: 'following',
    note,
    filter: previous?.filter ?? '',
    isErrorsOnly: previous?.isErrorsOnly ?? false,
    isPaused: false,
    total: 0,
    errors: 0,
    unseen: 0,
  }
  await update($, memberOf(linesFamily, { requestId: paneId }), () => [])
  await update($, memberOf(viewFamily, { requestId: paneId }), () => view)
  const tail: Tail = {
    id,
    paneId,
    target,
    stream: $.process.spawn({ argv: target.argv, env: SPAWN_ENV }),
    lines: [],
    partial: { stdout: '', stderr: '' },
    seq: 0,
    errors: 0,
    unseen: 0,
    isPaused: false,
    isStopping: false,
    isFollowing: true,
    flush: undefined,
    done: Promise.resolve(),
  }
  host.tails.set(id, tail)
  tail.done = pump($, host, tail)
  await listTails($, host)
  return tail
}

async function openPane($: EngineInterface, tail: Tail): Promise<void> {
  await $.ui.open({ id: tail.paneId, title: `tail ${shortTarget(tail.target)}` })
  await $.ui.scroll({ in: tail.paneId, to: 'end' }).catch(() => undefined)
}

async function togglePause($: EngineInterface, host: Host, id: string): Promise<void> {
  const tail = host.tails.get(id)
  if (tail === undefined || !tail.isFollowing) return
  tail.isPaused = !tail.isPaused
  tail.unseen = 0
  await update($, memberOf(viewFamily, { requestId: tail.paneId }), (view: View | null) => (view === null ? view : { ...view, isPaused: tail.isPaused, unseen: 0 }))
  if (!tail.isPaused) await publish($, host, tail)
}

async function restartTail($: EngineInterface, host: Host, id: string): Promise<void> {
  const tail = host.tails.get(id)
  if (tail === undefined || tail.isFollowing) return
  await startTail($, host, tail.target, id, null)
}

/** Sends the person's selection, else the last lines shown, to Claude as a prompt. */
async function sendToClaude($: EngineInterface, paneId: string): Promise<void> {
  const view = await read($, memberOf(viewFamily, { requestId: paneId }))
  if (view === null) return
  const selection = await $.ui.selection().catch(() => undefined)
  const selected = selection?.text.trim() ?? ''
  const shown = visible(await read($, memberOf(linesFamily, { requestId: paneId })), compileFilter(view.filter), view.isErrorsOnly).slice(-SEND_LINES)
  const text = selected !== '' ? selected : shown.map(line => line.text).join('\n')
  if (text.trim() === '') {
    $.ui.toast('Nothing to send yet: select lines in the pane, or wait for output.')
    return
  }
  const filters = [view.filter.trim() === '' ? null : `filter "${view.filter.trim()}"`, view.isErrorsOnly ? 'errors only' : null].filter(part => part !== null)
  const which = selected !== '' ? 'These lines are' : `The last ${plural(shown.length, 'line')}${filters.length === 0 ? '' : ` (${filters.join(', ')})`} are`
  const prompt = [
    `${which} from ${SOURCE_NAME[view.source]} \`${view.target}\`:`,
    '',
    fenced(text),
    '',
    'Explain what they show. If they point to a problem in this project, find the cause.',
  ].join('\n')
  await $.prompt.submit({ text: prompt, asUser: true })
}

async function setView($: EngineInterface, paneId: string, change: (view: View) => View): Promise<void> {
  await update($, memberOf(viewFamily, { requestId: paneId }), (view: View | null) => (view === null ? view : change(view)))
}

function describe(host: Host): string {
  if (host.tails.size === 0) return `No tails. ${USAGE}`
  const rows = [...host.tails.values()].map(tail => {
    const state = tail.isFollowing ? 'following' : tail.isStopping ? 'stopped' : 'ended'
    return `${tail.id}  ${state}  ${tail.target.source === 'file' ? tail.target.target : `${tail.target.source}:${tail.target.target}`}`
  })
  return [...rows, '/tail stop <id> stops one; /tail stop all stops them all.'].join('\n')
}

async function stopCommand($: EngineInterface, host: Host, which: string): Promise<string> {
  const following = [...host.tails.values()].filter(tail => tail.isFollowing)
  if (which === 'all' || (which === '' && following.length <= 1)) {
    if (following.length === 0) return 'No tail is running.'
    for (const tail of following) await stopTail($, tail)
    return following.length === 1 ? `Stopped tail ${following[0]?.id ?? ''}.` : `Stopped ${following.length} tails.`
  }
  if (which === '') return `${following.length} tails run: name one (${following.map(tail => tail.id).join(', ')}) or all.`
  const tail = host.tails.get(which)
  if (tail === undefined) return `No tail named ${which}. ${describe(host)}`
  if (!tail.isFollowing) return `Tail ${which} is not running.`
  await stopTail($, tail)
  return `Stopped tail ${which}.`
}

export const register: Register = on => {
  const host: Host = { tails: new Map(), status: undefined }

  on('session.start', async ($, e, next) => {
    await registerCommand($, {
      name: 'tail',
      description: 'Follow a log file, docker:<container> or compose:<service> in a live pane (/tail stop)',
      argumentHint: '<file> | docker:<name> | compose:<service> | stop [id|all]',
    })
    // A fresh load of the mod: the tails of the previous load ended with it.
    for (const entry of await read($, tailsAtom)) {
      if (entry.status !== 'following' || host.tails.has(entry.id)) continue
      await setView($, `${PANE_PREFIX}${entry.id}`, view => ({ ...view, status: 'stopped', note: 'Stopped when the mod reloaded.', isPaused: false }))
    }
    await update($, tailsAtom, (entries: Entry[]) => entries.filter(entry => host.tails.has(entry.id)))
    return next(e)
  })

  on('command.run', { command: 'tail' }, async ($, e) => {
    const arg = e.args.trim().replace(/^(["'])(.*)\1$/, '$2')
    if (arg === '') return { text: describe(host) }
    const stop = /^stop(?:\s+(.+))?$/.exec(arg)
    if (stop !== null) return { text: await stopCommand($, host, stop[1]?.trim() ?? '') }

    const cwd = await $.session.cwd()
    const home = await $.env.get('HOME').catch(() => undefined)
    const target = targetOf(arg, cwd, home, START_LINES)
    if (target.target === '') return { text: USAGE }

    const same = [...host.tails.values()].find(tail => tail.target.source === target.source && tail.target.target === target.target)
    if (same?.isFollowing === true) {
      await openPane($, same)
      return { text: `Already following ${target.target} (tail ${same.id}).` }
    }

    let note: string | null = null
    if (target.source === 'file') {
      const stat = await $.fs.stat(target.target).catch(() => undefined)
      if (stat?.kind === 'dir') return { text: `${target.target} is a folder: name a file in it.` }
      if (stat === undefined) note = 'The file does not exist yet: it is followed as soon as it appears.'
    }
    const id = same?.id ?? uniqueId(target.id, new Set(host.tails.keys()))
    const tail = await startTail($, host, target, id, note)
    await openPane($, tail)
    return { text: `Following ${target.target} as tail ${id}. /tail stop ${id} stops it.` }
  })

  on('session.end', async ($, e, next) => {
    for (const tail of host.tails.values()) {
      if (!tail.isFollowing) continue
      tail.isStopping = true
      void tail.stream.return({ code: null, signal: 'SIGTERM' }).catch(() => undefined)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: /^log-tail-/ }, async ($, e, next) => {
    const view = await read($, memberOf(viewFamily, e))
    if (view === null) return next(e)
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // Every surface but mobile draws a text field.
    const Input = 'Input' in elements ? elements.Input : undefined
    const lines = await read($, memberOf(linesFamily, e))
    const paneId = e.requestId
    const filter = compileFilter(view.filter)
    const kept = visible(lines, filter, view.isErrorsOnly)
    const shown = drawable(kept)
    const look = STATUS_LOOK[view.status]
    const isFollowing = view.status === 'following'
    const isFiltered = view.isErrorsOnly || view.filter.trim() !== ''

    return (
      <Box flexDirection="column">
        <Box key="header" flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Text bold color={view.isPaused ? 'warning' : look.color}>
            {view.isPaused ? '⏸ paused' : `${look.glyph} ${look.label}`}
          </Text>
          <Text bold wrap="truncate-start">
            {view.source === 'file' ? view.target : `${view.source}:${view.target}`}
          </Text>
          <Text dimColor>· {plural(view.total, 'line')}</Text>
          {view.errors > 0 && <Text color="error">· {plural(view.errors, 'error')}</Text>}
          {view.unseen > 0 && <Text color="warning">· {view.unseen} new</Text>}
        </Box>
        <Box key="meta">
          <Text dimColor wrap="truncate-end">
            {[view.note, view.command].filter(part => part !== null).join(' · ')}
          </Text>
        </Box>
        {Input !== undefined && (
          <Box key="filter-row" marginTop={1}>
            <Input
              key="filter"
              label="Filter"
              placeholder="text or /regex/i"
              value={view.filter}
              submitLabel="filter"
              onInput={value => void setView($, paneId, current => ({ ...current, filter: value }))}
              onSubmit={value => void setView($, paneId, current => ({ ...current, filter: value }))}
            />
          </Box>
        )}
        {filter.error !== null && (
          <Box key="filter-error">
            <Text color="error">{filter.error}</Text>
          </Box>
        )}
        <Box key="actions" flexDirection="row" flexWrap="wrap" gap={1}>
          <Button
            key="errors"
            label={view.isErrorsOnly ? '✓ Errors only' : 'Errors only'}
            hotkey="e"
            variant={view.isErrorsOnly ? 'primary' : undefined}
            onPress={() => void setView($, paneId, current => ({ ...current, isErrorsOnly: !current.isErrorsOnly }))}
          />
          {isFollowing && <Button key="pause" label={view.isPaused ? 'Resume' : 'Pause'} hotkey="p" onPress={() => void togglePause($, host, view.id)} />}
          <Button key="send" label="Send to Claude" hotkey="c" onPress={() => void sendToClaude($, paneId)} />
          {isFollowing ? (
            <Button key="stop" label="Stop" hotkey="s" onPress={() => void stopCommand($, host, view.id)} />
          ) : (
            <Button key="restart" label="Follow again" hotkey="f" onPress={() => void restartTail($, host, view.id)} />
          )}
          <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: paneId })} />
        </Box>
        <Box key="lines" flexDirection="column" marginTop={1}>
          {isFiltered && (
            <Text dimColor>
              {`Showing ${plural(kept.length, 'line')} of ${lines.length.toLocaleString('en-US')}${view.isErrorsOnly ? ' · errors only' : ''}`}
            </Text>
          )}
          {kept.length > shown.length && <Text dimColor>{`(${kept.length - shown.length} older lines not drawn)`}</Text>}
          {shown.length === 0 ? (
            <Text dimColor>{lines.length === 0 ? (isFollowing ? 'Waiting for lines…' : 'No lines.') : 'No line matches.'}</Text>
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
