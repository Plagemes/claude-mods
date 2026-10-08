import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ProfileView } from '../types'
import {
  COMPACT_CPUPROFILE_SCRIPT,
  PSTATS_SCRIPT,
  aggregateCpuProfile,
  busyMicros,
  formatMs,
  optimisable,
  optimisePrompt,
  parsePprofTop,
  parsePstatsDump,
  planProfile,
  sortFunctions,
} from './profiles'
import type { Profile, ProfilePlan } from './profiles'

type Settings = { timeoutMs: number; rows: number }
type Memory = { isBusy: boolean }
type Running = Exclude<ProfilePlan, { profiler: 'none' }>

const PANE = 'profile'
const PROFILE_DIR = '.claude/profiles'
const MAX_READ_BYTES = 4 * 1024 * 1024
const DEFAULT_TIMEOUT_SECONDS = 300
const MAX_TIMEOUT_SECONDS = 600
const DEFAULT_ROWS = 15
const TOOL_TIMEOUT_MS = 60_000
const OUTPUT_TAIL = 2_500
const KEPT_FUNCTIONS = 60
const NAME_COLUMNS = 28
const BAR_CELLS = 10
const NARROW_COLUMNS = 78
const VENV_PYTHONS = ['.venv/bin/python', 'venv/bin/python', '.venv/Scripts/python.exe']
const EMPTY: ProfileView = {
  phase: 'idle',
  command: '',
  profiler: null,
  startedAt: 0,
  functions: [],
  sortBy: 'self',
  coveredMs: 0,
  detail: '',
  message: '',
  output: '',
}
const USAGE =
  'Usage: /profile <command>: runs it under a profiler and shows the hottest functions. ' +
  'node and JS tools (npm, npx, vitest…) use --cpu-prof, python and pytest use cProfile, go test uses -cpuprofile.'

const view = atom({ plugin: 'profile-run', key: 'view' } as const, EMPTY)

const tail = (text: string): string => (text.length > OUTPUT_TAIL ? `…${text.slice(-OUTPUT_TAIL)}` : text).trim()

async function projectRoot($: EngineInterface): Promise<string> {
  try {
    const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { timeoutMs: 10_000 })
    if (top.exitCode === 0 && top.stdout.trim() !== '') return top.stdout.trim()
  } catch {
    // Not a repository: profile from the session's folder.
  }
  return $.session.cwd()
}

async function pythonOf($: EngineInterface, root: string): Promise<string> {
  for (const candidate of VENV_PYTHONS) if (await $.fs.exists(`${root}/${candidate}`).catch(() => false)) return `${root}/${candidate}`
  return 'python3'
}

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  const text = await $.fs.read(path).catch(() => undefined)
  return typeof text === 'string' ? text : undefined
}

async function cpuProfileNames($: EngineInterface, dir: string): Promise<Set<string>> {
  return new Set((await $.fs.list(dir).catch(() => [])).filter(entry => entry.name.endsWith('.cpuprofile')).map(entry => entry.name))
}

/** A .cpuprofile as data: read whole, or compacted by node first when it is too large to read. */
async function loadCpuProfile($: EngineInterface, path: string): Promise<unknown> {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat !== undefined && stat.size < MAX_READ_BYTES) {
    const text = await readText($, path)
    if (text !== undefined) return JSON.parse(text)
  }
  const compact = await $.process.run(['node', '-e', COMPACT_CPUPROFILE_SCRIPT, path], { timeoutMs: TOOL_TIMEOUT_MS })
  if (compact.exitCode !== 0) throw new Error(compact.stderr.trim() || 'could not read the CPU profile')
  return JSON.parse(compact.stdout)
}

/** The profile node wrote: of several processes (npm and the script it runs), the busiest one. */
async function nodeProfile($: EngineInterface, dir: string, before: ReadonlySet<string>, root: string): Promise<{ profile: Profile; detail: string }> {
  const created = [...(await cpuProfileNames($, dir))].filter(name => !before.has(name))
  if (created.length === 0) throw new Error('node wrote no .cpuprofile: was the command a node program?')
  let best: { data: unknown; busy: number; name: string } | undefined
  for (const name of created) {
    const data = await loadCpuProfile($, `${dir}/${name}`)
    const busy = busyMicros(data)
    if (best === undefined || busy > best.busy) best = { data, busy, name }
  }
  const chosen = best as { data: unknown; name: string }
  const processes = created.length === 1 ? '1 process' : `${created.length} processes, the busiest shown`
  return { profile: aggregateCpuProfile(chosen.data, root), detail: `${processes} · ${PROFILE_DIR}/${chosen.name}` }
}

/** Reads what the profiler wrote into a profile. */
async function readProfile($: EngineInterface, plan: Running, dir: string, before: ReadonlySet<string>, root: string): Promise<{ profile: Profile; detail: string }> {
  if (plan.profiler === 'node') return nodeProfile($, dir, before, root)
  if (plan.profiler === 'python') {
    const python = plan.argv[0] ?? 'python3'
    const dump = await $.process.run([python, '-c', PSTATS_SCRIPT, plan.statsFile], { cwd: root, timeoutMs: TOOL_TIMEOUT_MS })
    if (dump.exitCode !== 0) throw new Error(dump.stderr.trim().split('\n').at(-1) ?? 'could not read the cProfile stats')
    return { profile: parsePstatsDump(dump.stdout, root), detail: `cProfile · ${plan.statsFile.slice(root.length + 1)}` }
  }
  const top = await $.process.run(['go', 'tool', 'pprof', '-top', '-filefunctions', '-nodecount=80', plan.profileFile], { cwd: root, timeoutMs: TOOL_TIMEOUT_MS })
  if (top.exitCode !== 0) throw new Error(top.stderr.trim().split('\n').at(-1) ?? 'go tool pprof failed')
  return { profile: parsePprofTop(top.stdout, root), detail: `pprof · ${plan.profileFile.slice(root.length + 1)}` }
}

async function execute($: EngineInterface, settings: Settings, memory: Memory, plan: Running, root: string): Promise<void> {
  const dir = `${root}/${PROFILE_DIR}`
  try {
    const before = await cpuProfileNames($, dir)
    let output: string
    let exitCode: number
    try {
      const ran = await $.process.run(plan.argv, { cwd: root, timeoutMs: settings.timeoutMs, env: plan.profiler === 'node' ? plan.env : {} })
      output = `${ran.stdout}\n${ran.stderr}`
      exitCode = ran.exitCode
    } catch (error) {
      const text = String(error)
      const message = /failed to start|ENOENT/i.test(text)
        ? `${plan.argv[0]} is not installed or not on PATH.`
        : /still running/i.test(text)
          ? `Stopped after ${settings.timeoutMs / 1000}s; profile something shorter, or raise timeoutSeconds.`
          : text
      await update($, view, (current): ProfileView => ({ ...current, phase: 'error', message, output: '' }))
      return
    }

    // A failing run (a red test suite) still leaves a profile worth reading.
    try {
      const { profile, detail } = await readProfile($, plan, dir, before, root)
      await update($, view, (current): ProfileView => ({
        ...current,
        phase: 'done',
        functions: profile.functions.slice(0, KEPT_FUNCTIONS),
        coveredMs: profile.coveredMs,
        detail,
        message: '',
        output: '',
      }))
      const hottest = optimisable(profile.functions)[0]
      $.ui.toast(hottest === undefined ? 'Profile ready (/profile).' : `Hottest: ${hottest.name} · ${formatMs(hottest.selfMs)} self (${hottest.selfPercent.toFixed(0)}%)`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const message = exitCode === 0 ? `No profile to show: ${reason}` : `The command failed (exit ${exitCode}) and left no profile: ${reason}`
      await update($, view, (current): ProfileView => ({ ...current, phase: 'error', message, output: tail(output) }))
    }
  } finally {
    memory.isBusy = false
  }
}

/** Plans and starts a profile in the background; answers what the person is told. */
async function startProfile($: EngineInterface, settings: Settings, memory: Memory, command: string): Promise<string> {
  if (memory.isBusy) return 'A profile is already running; it shows in the /profile pane when done.'
  const root = await projectRoot($)
  const now = await $.clock.now()
  const stamp = `profile-${new Date(now).toISOString().replace(/[:.]/g, '-')}`
  const nodeOptions = (await $.env.get('NODE_OPTIONS').catch(() => undefined)) ?? ''
  const plan = planProfile(command, `${root}/${PROFILE_DIR}`, stamp, await pythonOf($, root), nodeOptions)
  const base: ProfileView = { ...EMPTY, command, startedAt: now }
  if (plan.profiler === 'none') {
    await update($, view, (): ProfileView => ({ ...base, phase: 'error', message: plan.message }))
    await $.ui.open({ id: PANE, title: 'Profile' }).catch(() => undefined)
    return plan.message
  }
  memory.isBusy = true
  await update($, view, (): ProfileView => ({ ...base, phase: 'running', profiler: plan.profiler }))
  await $.ui.open({ id: PANE, title: 'Profile' }).catch(() => undefined)
  $.clock.after(0, () => void execute($, settings, memory, plan, root))
  return `Profiling \`${command}\` with ${plan.profiler === 'node' ? 'node --cpu-prof' : plan.profiler === 'python' ? 'cProfile' : 'go test -cpuprofile'}…`
}

async function pressAgain($: EngineInterface, settings: Settings, memory: Memory): Promise<void> {
  const { command } = await read($, view)
  const said = await startProfile($, settings, memory, command)
  if (!said.startsWith('Profiling')) $.ui.toast(said)
}

async function askToOptimise($: EngineInterface): Promise<void> {
  const current = await read($, view)
  if (current.profiler === null || optimisable(current.functions).length === 0) return
  const text = optimisePrompt(current.command, current.profiler, current.functions, current.coveredMs)
  $.clock.after(1, () => void $.prompt.submit({ text, asUser: true }).catch(() => undefined))
  $.ui.toast('Asked Claude to optimise the top 3 functions.')
}

const cell = (text: string, width: number): string => (text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width))

export const register: Register = (on, options) => {
  const seconds = Number(options.timeoutSeconds) > 0 ? Number(options.timeoutSeconds) : DEFAULT_TIMEOUT_SECONDS
  const rows = Number(options.rows) > 0 ? Math.min(Math.round(Number(options.rows)), KEPT_FUNCTIONS) : DEFAULT_ROWS
  const settings: Settings = { timeoutMs: Math.min(seconds, MAX_TIMEOUT_SECONDS) * 1000, rows }
  const memory: Memory = { isBusy: false }

  on('session.start', async ($, e, next) => {
    await registerCommand($, { name: 'profile', description: 'Run a command under a profiler and show the hottest functions', argumentHint: '<command>' })
    return next(e)
  })

  on('command.run', { command: 'profile' }, async ($, e) => {
    const command = e.args.trim()
    if (command === '') {
      const current = await read($, view)
      if (current.phase === 'idle') return { text: USAGE }
      await $.ui.open({ id: PANE, title: 'Profile' }).catch(() => undefined)
      return { text: 'Profile pane opened.' }
    }
    return { text: await startProfile($, settings, memory, command) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Code, Text } = $.ui.resolve(e)
    const current = await read($, view)
    const close = <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
    if (current.phase === 'idle') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>No profile yet</Text>
          <Text dimColor>{USAGE}</Text>
          {close}
        </Box>
      )
    }
    if (current.phase === 'running') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold color="suggestion">
            ⧗ Profiling {current.command}…
          </Text>
          <Text dimColor>The table fills in when the command ends.</Text>
          {close}
        </Box>
      )
    }
    if (current.phase === 'error') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold color="error">
            ✗ {current.message}
          </Text>
          {current.command !== '' && <Text dimColor>{current.command}</Text>}
          {current.output !== '' && <Code source={current.output} />}
          <Box key="actions" flexDirection="row" gap={1}>
            {current.profiler !== null && <Button key="again" label="Run again" hotkey="r" onPress={() => void pressAgain($, settings, memory)} />}
            {close}
          </Box>
        </Box>
      )
    }

    const columns = e.props.bodyColumns
    const isNarrow = columns < NARROW_COLUMNS
    const locationWidth = Math.max(12, columns - NAME_COLUMNS - 3 - 9 - 8 - 8 - (isNarrow ? 0 : BAR_CELLS + 1) - 6)
    const functions = sortFunctions(current.functions, current.sortBy).slice(0, settings.rows)
    const most = Math.max(1e-9, ...functions.map(fn => fn.selfPercent))
    const canOptimise = optimisable(current.functions).length > 0
    return (
      <Box flexDirection="column" gap={1}>
        <Box key="header" flexDirection="column">
          <Text bold>
            🔥 Profile · {current.command}
          </Text>
          <Text dimColor wrap="truncate-end">
            {formatMs(current.coveredMs)} sampled · {current.profiler} · {current.detail}
          </Text>
        </Box>
        <Box key="table" flexDirection="column">
          <Text bold>
            {' #'} {cell('Function', NAME_COLUMNS)} {cell('Location', locationWidth)} {'Self ms'.padStart(9)} {'Self'.padStart(7)} {'Total'.padStart(7)}
          </Text>
          {functions.map((fn, index) => (
            <Box key={`fn:${index}`} flexDirection="row" gap={1}>
              <Text dimColor>{String(index + 1).padStart(2)}</Text>
              <Text bold={index < 3}>{cell(fn.name, NAME_COLUMNS)}</Text>
              <Text dimColor>{cell(fn.location, locationWidth)}</Text>
              <Text>{fn.selfMs.toFixed(1).padStart(9)}</Text>
              <Text color={fn.selfPercent >= 20 ? 'error' : fn.selfPercent >= 5 ? 'warning' : undefined}>{`${fn.selfPercent.toFixed(1)}%`.padStart(7)}</Text>
              <Text dimColor>{`${fn.totalPercent.toFixed(1)}%`.padStart(7)}</Text>
              {!isNarrow && <Text color="error">{'█'.repeat(Math.max(fn.selfPercent > 0 ? 1 : 0, Math.round((fn.selfPercent / most) * BAR_CELLS)))}</Text>}
            </Box>
          ))}
        </Box>
        <Box key="actions" flexDirection="row" gap={1}>
          {canOptimise && <Button key="optimise" label="Ask Claude to optimise top 3" hotkey="o" variant="primary" onPress={() => void askToOptimise($)} />}
          <Button
            key="sort"
            label={current.sortBy === 'self' ? 'Sort by total' : 'Sort by self'}
            hotkey="s"
            onPress={() => void update($, view, (latest): ProfileView => ({ ...latest, sortBy: latest.sortBy === 'self' ? 'total' : 'self' }))}
          />
          <Button key="again" label="Run again" hotkey="r" onPress={() => void pressAgain($, settings, memory)} />
          {close}
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
