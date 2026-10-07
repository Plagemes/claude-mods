import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BenchBaseline, BenchView } from '../types'
import { compareRuns, detectBenchCommand, formatChange, formatResult, parseBenchOutput, splitCommand, stripAnsi, verdictLine } from './bench'
import type { BenchResult, BenchRow } from './bench'

type Settings = { threshold: number; timeoutMs: number; command: string }
/** Where a run happens: the project root and the branch and commit checked out. */
type Place = { root: string; branch: string; commit: string }
/** The last compared run, so the pane can save it as the baseline. */
type Memory = { isBusy: boolean; last: (Place & { command: string; results: BenchResult[] }) | undefined }
type Action = { kind: 'run' | 'baseline'; command: string } | { kind: 'clear' } | { kind: 'help' }

const PANE = 'bench'
const DEFAULT_THRESHOLD = 5
const DEFAULT_TIMEOUT_SECONDS = 600
const MAX_TIMEOUT_SECONDS = 600
const GIT_TIMEOUT_MS = 10_000
const OUTPUT_TAIL = 3_000
const RUN_ENV = { CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' }
const VALUE_COLUMNS = 13
const CHANGE_COLUMNS = 15
const VENV_PYTHONS = ['.venv/bin/python', 'venv/bin/python']
const EMPTY: BenchView = { phase: 'idle', mode: 'compare', command: '', branch: '', startedAt: 0, baseline: null, rows: [], message: '', output: '' }
const VERDICT_COLOR: Record<BenchRow['verdict'], string | undefined> = {
  slower: 'error',
  faster: 'success',
  same: undefined,
  new: 'suggestion',
  gone: 'inactive',
}
const USAGE = [
  'Usage: /bench [baseline|clear] [command]',
  '  /bench baseline [command]  run the benchmarks and keep the numbers as the baseline for this branch',
  '  /bench [command]           run them again and compare with the baseline',
  '  /bench clear               forget this branch\'s baseline',
  'Without a command it uses the baseline\'s, or finds one: a bench script in package.json, vitest bench, go test -bench, cargo bench, pytest-benchmark.',
].join('\n')

const view = atom({ plugin: 'benchmark-compare', key: 'view' } as const, EMPTY)

const parseAction = (args: string): Action => {
  const text = args.trim()
  const [first = '', ...rest] = text.split(/\s+/)
  if (first === 'help' || first === '--help') return { kind: 'help' }
  if (first === 'clear' && rest.length === 0) return { kind: 'clear' }
  if (first === 'baseline') return { kind: 'baseline', command: text.slice('baseline'.length).trim() }
  return { kind: 'run', command: text }
}

const baselineKey = (place: Pick<Place, 'root' | 'branch'>): string => `baseline:${place.root}:${place.branch}`

async function git($: EngineInterface, cwd: string | undefined, args: readonly string[]): Promise<string | undefined> {
  try {
    const run = await $.process.run(['git', ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS })
    return run.exitCode === 0 ? run.stdout.trim() : undefined
  } catch {
    return undefined
  }
}

/** The project root (git's, else the session's folder), the branch and the short commit. */
async function placeOf($: EngineInterface): Promise<Place> {
  const root = (await git($, undefined, ['rev-parse', '--show-toplevel'])) ?? (await $.session.cwd())
  const branch = (await git($, root, ['rev-parse', '--abbrev-ref', 'HEAD'])) ?? 'no-git'
  const commit = (await git($, root, ['rev-parse', '--short', 'HEAD'])) ?? ''
  return { root, branch: branch === 'HEAD' ? `detached ${commit}` : branch, commit }
}

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  const text = await $.fs.read(path).catch(() => undefined)
  return typeof text === 'string' ? text : undefined
}

/** A benchmark command from the project's own files. */
async function detect($: EngineInterface, root: string): Promise<string | undefined> {
  const names = new Set((await $.fs.list(root).catch(() => [])).map(entry => entry.name))
  const pythonFiles = ['pyproject.toml', 'requirements.txt', 'requirements-dev.txt', 'setup.cfg'].filter(name => names.has(name))
  const pythonManifests = (await Promise.all(pythonFiles.map(name => readText($, `${root}/${name}`)))).join('\n')
  let venvPython: string | undefined
  for (const python of VENV_PYTHONS) if (venvPython === undefined && (await $.fs.exists(`${root}/${python}`).catch(() => false))) venvPython = python
  return detectBenchCommand({
    names,
    packageJson: names.has('package.json') ? await readText($, `${root}/package.json`) : undefined,
    pythonManifests,
    venvPython,
  })
}

async function readBaseline($: EngineInterface, key: string): Promise<BenchBaseline | undefined> {
  const value: unknown = await $.store.get(key).catch(() => undefined)
  if (typeof value !== 'object' || value === null || !Array.isArray((value as BenchBaseline).results)) return undefined
  return value as BenchBaseline
}

/** This branch's baseline, else the newest one of the project (another branch's), else none. */
async function findBaseline($: EngineInterface, place: Place): Promise<BenchBaseline | undefined> {
  const own = await readBaseline($, baselineKey(place))
  if (own !== undefined) return own
  const prefix = `baseline:${place.root}:`
  const keys = (await $.store.keys().catch(() => [])).filter(key => key.startsWith(prefix))
  const others = (await Promise.all(keys.map(key => readBaseline($, key)))).filter((one): one is BenchBaseline => one !== undefined)
  return others.sort((a, b) => b.at - a.at)[0]
}

/** A baseline without its numbers, as the pane shows it. */
const headOf = (baseline: BenchBaseline): Omit<BenchBaseline, 'results'> => ({
  command: baseline.command,
  at: baseline.at,
  branch: baseline.branch,
  commit: baseline.commit,
})

const describeBaseline = (baseline: Omit<BenchBaseline, 'results'>): string =>
  `${baseline.branch}${baseline.commit === '' ? '' : ` @ ${baseline.commit}`}`

/** What a comparison found, for mods that follow benchmarks; nothing happens without mods-hub. */
async function publishResult($: EngineInterface, rows: readonly BenchRow[], run: { command: string; branch: string; baselineBranch: string; summary: string }): Promise<void> {
  const count = (verdict: BenchRow['verdict']): number => rows.filter(row => row.verdict === verdict).length
  await hubPublish($, {
    topic: 'x.benchmark-compare.result',
    data: { ...run, benchmarks: rows.length, slower: count('slower'), faster: count('faster'), same: count('same'), isNew: count('new') },
  })
}

/** Runs the command, reads its numbers, and saves them as the baseline or compares them with it. */
async function execute($: EngineInterface, settings: Settings, memory: Memory, kind: 'run' | 'baseline', command: string, place: Place): Promise<void> {
  try {
    const argv = splitCommand(command) ?? ['sh', '-c', command]
    let output: string
    let exitCode: number
    try {
      const ran = await $.process.run(argv, { cwd: place.root, timeoutMs: settings.timeoutMs, env: RUN_ENV })
      output = stripAnsi(`${ran.stdout}\n${ran.stderr}`)
      exitCode = ran.exitCode
    } catch (error) {
      const text = String(error)
      const message = /failed to start|ENOENT/i.test(text)
        ? `${argv[0]} is not installed or not on PATH.`
        : /still running/i.test(text)
          ? `Stopped after ${settings.timeoutMs / 1000}s (raise timeoutSeconds for longer suites).`
          : text
      await update($, view, (current): BenchView => ({ ...current, phase: 'error', message }))
      return
    }

    const results = parseBenchOutput(output)
    const tail = output.length > OUTPUT_TAIL ? `…${output.slice(-OUTPUT_TAIL)}` : output
    if (results.length === 0) {
      const message = exitCode === 0 ? 'The command ran but printed no benchmark results this mod can read.' : `The command failed (exit ${exitCode}).`
      await update($, view, (current): BenchView => ({ ...current, phase: 'error', message, output: tail.trim() }))
      return
    }

    const now = await $.clock.now()
    if (kind === 'baseline') {
      const baseline: BenchBaseline = { command, results, at: now, branch: place.branch, commit: place.commit }
      await $.store.set(baselineKey(place), baseline)
      const rows = results.map((result): BenchRow => ({ name: result.name, before: result, after: null, speedup: null, verdict: 'same' }))
      const message = `Baseline saved: ${results.length} benchmark${results.length === 1 ? '' : 's'} on ${describeBaseline(baseline)}.`
      await update($, view, (current): BenchView => ({ ...current, phase: 'done', mode: 'baseline', baseline: headOf(baseline), rows, message, output: '' }))
      $.ui.toast(message)
      return
    }

    memory.last = { ...place, command, results }
    const baseline = await findBaseline($, place)
    if (baseline === undefined) {
      const rows = compareRuns([], results, settings.threshold)
      const message = `No baseline for ${place.branch} yet: save this run as the baseline, change the code, then run /bench again.`
      await update($, view, (current): BenchView => ({ ...current, phase: 'done', mode: 'compare', baseline: null, rows, message, output: '' }))
      return
    }
    const rows = compareRuns(baseline.results, results, settings.threshold)
    const summary = verdictLine(rows)
    const fromOther = baseline.branch === place.branch ? '' : ` (baseline from ${baseline.branch})`
    await update($, view, (current): BenchView => ({
      ...current,
      phase: 'done',
      mode: 'compare',
      baseline: headOf(baseline),
      rows,
      message: `${summary}${fromOther}`,
      output: '',
    }))
    const slower = rows.filter(row => row.verdict === 'slower').length
    $.ui.status(slower > 0 ? `⏱ bench: ${slower} slower` : undefined)
    $.ui.toast(`Benchmarks: ${summary}${fromOther}`)
    await publishResult($, rows, { command, branch: place.branch, baselineBranch: baseline.branch, summary })
  } finally {
    memory.isBusy = false
  }
}

/** Starts a run in the background and shows it in the pane; answers what the person is told. */
async function start($: EngineInterface, settings: Settings, memory: Memory, kind: 'run' | 'baseline', asked: string): Promise<string> {
  if (memory.isBusy) return 'A benchmark run is already going; it shows in the /bench pane when done.'
  const place = await placeOf($)
  const remembered = kind === 'run' ? (await findBaseline($, place))?.command : undefined
  const command = asked || settings.command || remembered || (await detect($, place.root))
  if (command === undefined) {
    return 'No benchmark command found. Pass one, e.g. /bench baseline npm run bench, or set it in the mod\'s settings.'
  }
  memory.isBusy = true
  const startedAt = await $.clock.now()
  await update($, view, (current): BenchView => ({ ...current, phase: 'running', mode: kind === 'baseline' ? 'baseline' : 'compare', command, branch: place.branch, startedAt, output: '' }))
  await $.ui.open({ id: PANE, title: 'Benchmarks' }).catch(() => undefined)
  $.clock.after(0, () => void execute($, settings, memory, kind, command, place))
  return kind === 'baseline' ? `Running \`${command}\` for the ${place.branch} baseline…` : `Running \`${command}\` to compare with the baseline…`
}

async function saveLast($: EngineInterface, memory: Memory): Promise<void> {
  const last = memory.last
  if (last === undefined) return
  const baseline: BenchBaseline = { command: last.command, results: last.results, at: await $.clock.now(), branch: last.branch, commit: last.commit }
  await $.store.set(baselineKey(last), baseline)
  const rows = last.results.map((result): BenchRow => ({ name: result.name, before: result, after: null, speedup: null, verdict: 'same' }))
  await update($, view, (current): BenchView => ({ ...current, mode: 'baseline', baseline: headOf(baseline), rows, message: `Saved as the baseline for ${describeBaseline(baseline)}.` }))
  $.ui.status(undefined)
  $.ui.toast(`Saved as the baseline for ${last.branch}.`)
}

async function pressRun($: EngineInterface, settings: Settings, memory: Memory, command: string): Promise<void> {
  const said = await start($, settings, memory, 'run', command)
  if (!said.startsWith('Running')) $.ui.toast(said)
}

const ago = (now: number, at: number): string => {
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}

const cell = (text: string, width: number, alignEnd = false): string =>
  text.length > width ? `${text.slice(0, width - 1)}…` : alignEnd ? text.padStart(width) : text.padEnd(width)

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Says hello to mods-hub when it is installed. */
async function greetHub($: EngineInterface): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: ['x.benchmark-compare.result'], consumes: [] })
}

export const register: Register = (on, options) => {
  const seconds = Number(options.timeoutSeconds) > 0 ? Number(options.timeoutSeconds) : DEFAULT_TIMEOUT_SECONDS
  const percent = Number(options.regressionPercent)
  const settings: Settings = {
    threshold: Number.isFinite(percent) && percent >= 0 ? percent : DEFAULT_THRESHOLD,
    timeoutMs: Math.min(seconds, MAX_TIMEOUT_SECONDS) * 1000,
    command: typeof options.command === 'string' ? options.command.trim() : '',
  }
  const memory: Memory = { isBusy: false, last: undefined }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'bench',
      description: 'Run benchmarks and compare with a saved baseline (baseline, clear, or a command)',
      argumentHint: '[baseline|clear] [command]',
    })
    await greetHub($)
    return next(e)
  })

  on('command.run', { command: 'bench' }, async ($, e) => {
    const action = parseAction(e.args)
    if (action.kind === 'help') return { text: USAGE }
    if (action.kind === 'clear') {
      const place = await placeOf($)
      await $.store.delete(baselineKey(place)).catch(() => undefined)
      await update($, view, (current): BenchView => ({ ...current, baseline: null, rows: [], phase: 'idle', message: '' }))
      return { text: `Forgot the benchmark baseline for ${place.branch}.` }
    }
    return { text: await start($, settings, memory, action.kind, action.command) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Code, Text } = $.ui.resolve(e)
    const current = await read($, view)
    const now = await $.clock.now()
    const close = <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />

    if (current.phase === 'idle') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>No benchmark run yet</Text>
          <Text dimColor>/bench baseline saves the numbers before a change; /bench after it compares.</Text>
          {close}
        </Box>
      )
    }
    if (current.phase === 'running') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold color="suggestion">
            ⧗ Running {current.command}…
          </Text>
          <Text dimColor>
            {current.mode === 'baseline' ? `Baseline for ${current.branch}` : `Comparing on ${current.branch}`} · started {ago(now, current.startedAt)}.
            The pane fills in when the run ends.
          </Text>
          {close}
        </Box>
      )
    }

    const actions = (
      <Box key="actions" flexDirection="row" gap={1}>
        {current.mode === 'compare' && current.phase === 'done' && (
          <Button key="save" label="Save as baseline" hotkey="s" onPress={() => void saveLast($, memory)} />
        )}
        <Button key="again" label="Run again" hotkey="r" variant="primary" onPress={() => void pressRun($, settings, memory, current.command)} />
        {close}
      </Box>
    )
    if (current.phase === 'error') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold color="error">
            ✗ {current.message}
          </Text>
          <Text dimColor>{current.command}</Text>
          {current.output !== '' && <Code source={current.output} />}
          {actions}
        </Box>
      )
    }

    const isBaseline = current.mode === 'baseline'
    const columns = e.props.bodyColumns
    const valueColumns = isBaseline ? 1 : 2
    const nameWidth = Math.max(12, columns - valueColumns * (VALUE_COLUMNS + 1) - (isBaseline ? 0 : CHANGE_COLUMNS + 1) - 2)
    const hasSlower = current.rows.some(row => row.verdict === 'slower')
    return (
      <Box flexDirection="column" gap={1}>
        <Box key="header" flexDirection="column">
          <Text bold>
            ⏱ Benchmarks · {current.branch}
            {!isBaseline && current.baseline !== null ? ` vs ${describeBaseline(current.baseline)} (${ago(now, current.baseline.at)})` : ''}
          </Text>
          <Text dimColor wrap="truncate-end">
            {current.command} · slower or faster beyond {settings.threshold}% counts
          </Text>
        </Box>
        <Box key="table" flexDirection="column">
          <Text bold>
            {cell('Benchmark', nameWidth)} {isBaseline ? cell('Baseline', VALUE_COLUMNS, true) : `${cell('Baseline', VALUE_COLUMNS, true)} ${cell('Now', VALUE_COLUMNS, true)} ${cell('Change', CHANGE_COLUMNS, true)}`}
          </Text>
          {current.rows.map(row => (
            <Box key={`row:${row.name}`} flexDirection="row">
              <Text color={isBaseline ? undefined : VERDICT_COLOR[row.verdict]} dimColor={!isBaseline && row.verdict === 'same'}>
                {cell(row.name, nameWidth)} {cell(row.before === null ? '—' : formatResult(row.before), VALUE_COLUMNS, true)}
                {isBaseline ? '' : ` ${cell(row.after === null ? '—' : formatResult(row.after), VALUE_COLUMNS, true)} ${cell(formatChange(row), CHANGE_COLUMNS, true)}`}
              </Text>
            </Box>
          ))}
        </Box>
        <Text key="verdict" bold={hasSlower} color={hasSlower ? 'error' : isBaseline ? 'success' : undefined}>
          {current.message}
        </Text>
        {actions}
      </Box>
    )
  })
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
