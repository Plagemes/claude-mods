import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput, Timer, ToolCallInput, ToolCallResult } from 'claude-code'

import type { TestWatchPlan, TestWatchRun } from '../types'
import { basename, dirname, extension, hasPackage, isAbsolute, isNotInstalled, join, relativeTo } from './project'
import type { Level, Project } from './project'
import { PYTHON_EXTENSIONS, SCRIPT_EXTENSIONS, commandFor, pythonTestLookups, scriptTestLookups, statusOf, stemOf } from './runners'
import type { Lookup, Runner } from './runners'
import { countsOf, isTestFile, stripAnsi } from './shared/test-runners'

const PANE = 'tests-last'
const COMMAND = 'tests-last'
/** The hub's shared panel, and this mod's tab in it (order 100: Tests, per the platform's tab order). */
const HUB_PANE = 'claude-mods'
const TAB = { id: 'tests', title: 'Tests', order: 100, command: COMMAND } as const
/** How much of a command line goes into a `test.result` event. */
const MAX_EVENT_COMMAND = 200
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
const SKIPPED_PATH = /(^|\/)(node_modules|\.git)\//
const MAX_LEVELS = 40
const DEFAULT_DEBOUNCE_SECONDS = 3
const DEFAULT_TIMEOUT_SECONDS = 300
const MAX_TIMEOUT_SECONDS = 600
const MAX_OUTPUT_CHARS = 60_000
const RUN_ENV = { CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' }
const VITEST_CONFIGS = ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vitest.config.mjs']
const JEST_CONFIGS = ['jest.config.ts', 'jest.config.js', 'jest.config.mjs', 'jest.config.cjs', 'jest.config.json']
const PYTHON_ROOTS = ['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini', 'setup.py']
const LOCAL_BINS: Record<Runner, readonly string[]> = {
  vitest: ['node_modules/.bin'],
  jest: ['node_modules/.bin'],
  pytest: ['.venv/bin', 'venv/bin'],
  go: [],
  cargo: [],
}

const last = atom({ plugin: 'test-watch', key: 'last' } as const, null)
const isRunning = atom({ plugin: 'test-watch', key: 'isRunning' } as const, false)

type Settings = { debounceMs: number; timeoutMs: number }

/** One runner in one project, and the tests it should run there. */
type Group = { runner: Runner; cwd: string; project: Project; tests: Set<string> }

/** Files edited since the last run, waiting for the edits to settle. */
const pending = new Set<string>()
let debounce: Timer | undefined
let isBusy = false

export const register: Register = (on, options) => {
  const seconds = (value: unknown, fallback: number) =>
    Math.min(Number(value) > 0 ? Number(value) : fallback, MAX_TIMEOUT_SECONDS)
  const settings: Settings = {
    debounceMs: seconds(options.debounceSeconds, DEFAULT_DEBOUNCE_SECONDS) * 1000,
    timeoutMs: seconds(options.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS) * 1000,
  }

  on('session.start', async ($, e, next) => {
    await registerCommand($, { name: 'tests-last', description: 'Show the output of the last test-watch run' })
    afterStart($, 'test-watch', () => greetHub($))
    return next(e)
  })

  on('command.run', { command: 'tests-last' }, async $ => {
    if (!(await hubShowTab($, TAB.id))) await $.ui.open({ id: PANE, title: 'Tests' })
    return {}
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const target = editedFile(e, ran)
    if (target === undefined) return ran

    const root = await $.session.cwd().catch(() => '/')
    const file = isAbsolute(target) ? target : join(root, target)
    if (SKIPPED_PATH.test(file)) return ran

    pending.add(file)
    debounce?.cancel()
    debounce = $.clock.after(settings.debounceMs, () => void flush($, settings))
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawTests($, e, settings, false))

  // The Tests tab: drawn beneath the hub's tab strip when it is the tab shown; any other tab passes through.
  on('ui.render', { component: 'Pane', requestId: HUB_PANE }, async ($, e, next) => {
    if (!(await hubTabIs($, TAB.id))) return next(e)
    const { Box } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {await next(e)}
        {await drawTests($, e, settings, true)}
      </Box>
    )
  })
}

/** The last run: this mod's own pane, or its tab in the hub's panel (`isTab`, no Close button). */
const drawTests = async ($: EngineInterface, e: RenderInput<'Pane'>, settings: Settings, isTab: boolean): Promise<RenderElement> => {
  const { Box, Button, Code, Text } = $.ui.resolve(e)
  const run = await read($, last)
  const running = await read($, isRunning)

  const close = isTab ? null : <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
  if (run === null) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{running ? '⧗ Running tests…' : 'No test run yet'}</Text>
        <Text dimColor>
          Edit a file that has tests beside it (name.test.ts, test_name.py, name_test.go…) and they run{' '}
          {settings.debounceMs / 1000}s after the edits settle.
        </Text>
        {close}
      </Box>
    )
  }

  const color = run.outcome === 'passed' ? 'success' : 'error'
  const meta = `${run.plans.map(plan => plan.runner).join(', ')} · ${(run.durationMs / 1000).toFixed(1)}s`
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Text bold color={color}>
          {statusOf(run)}
        </Text>
        <Text dimColor>{running ? '⧗ running again…' : meta}</Text>
      </Box>
      <Text dimColor wrap="truncate-end">
        {run.targets.join(', ')}
      </Text>
      <Code source={run.output === '' ? '(no output)' : run.output} />
      <Box flexDirection="row" gap={2}>
        {!running && (
          <Button
            key="rerun"
            label="Run again"
            hotkey="r"
            variant="primary"
            onPress={() => void execute($, run.plans, run.targets, settings)}
          />
        )}
        {close}
      </Box>
    </Box>
  )
}

/** Runs the tests related to the files edited since the last run, unless a run is in flight. */
const flush = async ($: EngineInterface, settings: Settings): Promise<void> => {
  if (isBusy || pending.size === 0) return
  const files = [...pending]
  pending.clear()

  const groups = await planTests($, files)
  if (groups.length === 0) {
    $.ui.status(`○ tests: none related to ${files.map(basename).join(', ')}`)
  } else {
    const plans: TestWatchPlan[] = []
    for (const group of groups) {
      const executable = await resolveExecutable($, group.project, group.runner)
      plans.push({ runner: group.runner, cwd: group.cwd, argv: commandFor(group.runner, executable, argsOf(group)) })
    }
    await execute($, plans, groups.flatMap(targetsOf), settings)
  }

  if (pending.size > 0) await flush($, settings)
}

/** Runs each plan in turn, records the run for the pane and shows its verdict. */
const execute = async (
  $: EngineInterface,
  plans: readonly TestWatchPlan[],
  targets: readonly string[],
  settings: Settings,
): Promise<void> => {
  if (isBusy) return
  isBusy = true
  try {
    await update($, isRunning, () => true)
    $.ui.status(`⧗ tests: running ${targets.map(basename).join(', ')}…`)
    const startedAt = await $.clock.now()
    const outputs: string[] = []
    let passed: number | null = null
    let failed: number | null = null
    let hasFailed = false
    let reason: string | undefined

    for (const plan of plans) {
      const header = `$ ${plan.argv.map(arg => relativeTo(plan.cwd, arg)).join(' ')}`
      try {
        const ran = await $.process.run(plan.argv, { cwd: plan.cwd, timeoutMs: settings.timeoutMs, env: RUN_ENV })
        const text = stripAnsi([ran.stdout, ran.stderr].filter(Boolean).join('\n')).trim()
        outputs.push(`${header}\n${text}`)
        const counts = countsOf(plan.runner, text)
        if (counts.passed !== null) passed = (passed ?? 0) + counts.passed
        if (counts.failed !== null) failed = (failed ?? 0) + counts.failed
        if (ran.exitCode !== 0) hasFailed = true
      } catch (error) {
        reason = isNotInstalled(error) ? `${plan.runner} is not installed` : `stopped after ${settings.timeoutMs / 1000}s`
        outputs.push(`${header}\n${String(error)}`)
      }
    }

    const output = outputs.join('\n\n')
    const run: TestWatchRun = {
      plans: [...plans],
      targets: [...targets],
      outcome: reason !== undefined ? 'error' : hasFailed ? 'failed' : 'passed',
      passed,
      failed,
      reason,
      durationMs: (await $.clock.now()) - startedAt,
      output: output.length > MAX_OUTPUT_CHARS ? `…\n${output.slice(-MAX_OUTPUT_CHARS)}` : output,
    }
    await update($, last, () => run)
    $.ui.status(statusOf(run))
    await publishRun($, run)
  } finally {
    isBusy = false
    await update($, isRunning, () => false)
  }
}

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
const ownVersion = async ($: EngineInterface): Promise<string> => {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** With mods-hub installed: hello and the Tests tab in its panel. */
const greetHub = async ($: EngineInterface): Promise<void> => {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: ['test.result'], consumes: [] }, TAB)
}

/**
 * A finished run on the hub's bus: `test.result` (richer than the hub's own sensor, which only sees the
 * test commands Claude runs) and the fact `test-watch.plan` (what ran, where). Nothing happens without the hub.
 */
const publishRun = async ($: EngineInterface, run: TestWatchRun): Promise<void> => {
  const runners = [...new Set(run.plans.map(plan => plan.runner))]
  const isPublished = await hubPublish($, {
    topic: 'test.result',
    data: {
      runner: runners.join('+'),
      outcome: run.outcome,
      passed: run.passed,
      failed: run.failed,
      durationMs: run.durationMs,
      command: run.plans.map(plan => plan.argv.map(arg => relativeTo(plan.cwd, arg)).join(' ')).join(' ; ').slice(0, MAX_EVENT_COMMAND),
    },
  })
  if (!isPublished) return
  try {
    await $.mods.share({ name: 'plan', value: { runners, targets: run.targets, plans: run.plans.map(plan => ({ runner: plan.runner, cwd: plan.cwd })) } })
  } catch {
    // The hub refused the fact: the event is out, which is what matters.
  }
}

/** Groups the edited files' related tests by runner and project. */
const planTests = async ($: EngineInterface, files: readonly string[]): Promise<Group[]> => {
  const groups = new Map<string, Group>()
  const add = (runner: Runner, cwd: string, project: Project, test: string) => {
    const key = `${runner}:${cwd}`
    const group = groups.get(key) ?? { runner, cwd, project, tests: new Set<string>() }
    group.tests.add(test)
    groups.set(key, group)
  }

  for (const file of files) {
    const ext = extension(file)
    const project = await scanProject($, file)

    if (SCRIPT_EXTENSIONS.has(ext)) {
      const cwd = project.find('package.json') ?? dirname(file)
      const runner = await scriptRunner(project)
      if (runner === undefined) continue
      const tests = isTestFile(file) ? [file] : await existing($, scriptTestLookups(file, cwd))
      for (const test of tests) add(runner, cwd, project, relativeTo(cwd, test))
    } else if (PYTHON_EXTENSIONS.has(ext)) {
      const cwd = project.find(...PYTHON_ROOTS) ?? project.levels.at(-1)?.dir ?? dirname(file)
      const tests = isTestFile(file) ? [file] : await existing($, pythonTestLookups(file, cwd))
      for (const test of tests) add('pytest', cwd, project, relativeTo(cwd, test))
    } else if (ext === 'go') {
      const cwd = project.find('go.mod')
      const hasTests = [...(project.levels[0]?.names ?? [])].some(name => name.endsWith('_test.go'))
      if (cwd === undefined || !hasTests) continue
      const dir = relativeTo(cwd, dirname(file))
      add('go', cwd, project, dir === '' ? '.' : `./${dir}`)
    } else if (ext === 'rs') {
      const cwd = project.find('Cargo.toml')
      if (cwd === undefined) continue
      const isIntegrationTest = /^tests\/[^/]+\.rs$/.test(relativeTo(cwd, file))
      add('cargo', cwd, project, isIntegrationTest ? stemOf(file) : '')
    }
  }
  return [...groups.values()].filter(group => group.tests.size > 0)
}

/** The runner's arguments for a group: test paths, Go packages, or cargo's integration tests. */
const argsOf = (group: Group): string[] => {
  const tests = [...group.tests].sort()
  if (group.runner !== 'cargo') return tests
  return tests.includes('') ? [] : tests.flatMap(name => ['--test', name])
}

/** What a group runs, as the status line and the pane name it. */
const targetsOf = (group: Group): string[] => {
  if (group.runner !== 'cargo') return [...group.tests].sort()
  return group.tests.has('') ? [`${basename(group.cwd)} (crate)`] : [...group.tests].sort().map(name => `tests/${name}.rs`)
}

/** The JS test runner the project depends on, vitest first. */
const scriptRunner = async (project: Project): Promise<Runner | undefined> => {
  if (project.find(...VITEST_CONFIGS) !== undefined || (await hasPackage(project, 'vitest'))) return 'vitest'
  if (project.find(...JEST_CONFIGS) !== undefined || (await hasPackage(project, 'jest'))) return 'jest'
  return undefined
}

/** The candidate test files that exist, each lookup's directory listed once. */
const existing = async ($: EngineInterface, lookups: readonly Lookup[]): Promise<string[]> => {
  const found = new Set<string>()
  for (const lookup of lookups) {
    const entries = await $.fs.list(lookup.dir).catch(() => [])
    const names = new Set(entries.filter(entry => entry.kind !== 'dir').map(entry => entry.name))
    for (const name of lookup.names) if (names.has(name)) found.add(join(lookup.dir, name))
  }
  return [...found]
}

/**
 * Lists the file's directory and each parent, stopping at the first one that
 * holds `.git` (the repository root) or at the filesystem root.
 */
const scanProject = async ($: EngineInterface, file: string): Promise<Project> => {
  const levels: Level[] = []
  let dir = dirname(file)
  for (let depth = 0; depth < MAX_LEVELS; depth += 1) {
    const entries = await $.fs.list(dir).catch(() => [])
    const names = new Set(entries.map(entry => entry.name))
    levels.push({ dir, names })
    const parent = dirname(dir)
    if (names.has('.git') || parent === dir) break
    dir = parent
  }

  return {
    levels,
    find: (...names) => levels.find(level => names.some(name => level.names.has(name)))?.dir,
    readAll: async name => {
      const found: { dir: string; text: string }[] = []
      for (const level of levels) {
        if (!level.names.has(name)) continue
        const text = await $.fs.read(join(level.dir, name)).catch(() => undefined)
        if (text !== undefined) found.push({ dir: level.dir, text })
      }
      return found
    },
  }
}

/** The nearest local install of the runner (`node_modules/.bin`, a venv); its bare name, found on PATH, otherwise. */
const resolveExecutable = async ($: EngineInterface, project: Project, runner: Runner): Promise<string> => {
  for (const level of project.levels) {
    for (const folder of LOCAL_BINS[runner]) {
      if (!level.names.has(folder.split('/')[0] ?? folder)) continue
      const candidate = join(level.dir, folder, runner)
      if (await $.fs.exists(candidate).catch(() => false)) return candidate
    }
  }
  return runner
}

/** The file a successful Edit, Write or MultiEdit changed; undefined otherwise. */
const editedFile = (e: ToolCallInput, ran: ToolCallResult): string | undefined => {
  if (!EDIT_TOOLS.has(String(e.tool)) || ran.deny !== undefined || ran.isError === true) return undefined
  const path = 'file_path' in e ? e.file_path : undefined
  return typeof path === 'string' && path !== '' ? path : undefined
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
