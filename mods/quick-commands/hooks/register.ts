import type { EngineInterface, PluginOptions, Register, ToolCallResult } from 'claude-code'

import { checkCountsOf, toolOf } from './results'
import { isTestCommand, summarizeRun } from './shared/test-runners'

type Kind = 'test' | 'lint' | 'build' | 'typecheck'
type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

type KindSpec = {
  option: string
  noun: string
  fix: string
  scripts: readonly string[]
  makeTargets: readonly string[]
  cargo: string
  go: string
}

const KINDS: Record<Kind, KindSpec> = {
  test: {
    option: 'testCommand',
    noun: 'test suite',
    fix: 'fix any failures',
    scripts: ['test'],
    makeTargets: ['test', 'tests'],
    cargo: 'cargo test',
    go: 'go test ./...',
  },
  lint: {
    option: 'lintCommand',
    noun: 'linter',
    fix: 'fix every issue it reports',
    scripts: ['lint'],
    makeTargets: ['lint'],
    cargo: 'cargo clippy --all-targets',
    go: 'go vet ./...',
  },
  build: {
    option: 'buildCommand',
    noun: 'build',
    fix: 'fix any errors',
    scripts: ['build'],
    makeTargets: ['build'],
    cargo: 'cargo build',
    go: 'go build ./...',
  },
  typecheck: {
    option: 'typecheckCommand',
    noun: 'type checker',
    fix: 'fix every type error',
    scripts: ['typecheck', 'type-check', 'check-types', 'tsc', 'types'],
    makeTargets: ['typecheck', 'type-check', 'types'],
    cargo: 'cargo check',
    go: 'go vet ./...',
  },
}

const LOCKFILES: readonly (readonly [string, PackageManager])[] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
]
const EXEC: Record<PackageManager, string> = { npm: 'npx', pnpm: 'pnpm exec', yarn: 'yarn', bun: 'bunx' }
/** What `npm init` writes as the test script; it is a placeholder, not a test suite. */
const PLACEHOLDER_SCRIPT = /no test specified/
/** A command asked for this long ago and never run is forgotten. */
const PENDING_MS = 30 * 60_000
const MAX_EVENT_COMMAND = 200

/** The command each kind asked Claude to run, waiting for the Bash call that runs it (mods-hub reports its result). */
type Pending = Map<Kind, { command: string; at: number }>

const exists = async ($: EngineInterface, cwd: string, name: string): Promise<boolean> => {
  try {
    return await $.fs.exists(`${cwd}/${name}`)
  } catch {
    return false
  }
}

const readText = async ($: EngineInterface, cwd: string, name: string): Promise<string | undefined> => {
  try {
    const text = await $.fs.read(`${cwd}/${name}`)
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

const packageManager = async ($: EngineInterface, cwd: string): Promise<PackageManager> => {
  for (const [file, manager] of LOCKFILES) {
    if (await exists($, cwd, file)) {
      return manager
    }
  }
  return 'npm'
}

const scriptsOf = (packageJson: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(packageJson)
    const scripts =
      typeof parsed === 'object' && parsed !== null && 'scripts' in parsed ? parsed.scripts : undefined
    return typeof scripts === 'object' && scripts !== null ? { ...scripts } : {}
  } catch {
    return {}
  }
}

const fromPackageJson = async ($: EngineInterface, cwd: string, kind: Kind): Promise<string | undefined> => {
  const packageJson = await readText($, cwd, 'package.json')
  if (packageJson === undefined) {
    return undefined
  }

  const manager = await packageManager($, cwd)
  const scripts = scriptsOf(packageJson)
  const script = KINDS[kind].scripts.find(name => {
    const body = scripts[name]
    return typeof body === 'string' && !PLACEHOLDER_SCRIPT.test(body)
  })

  if (script !== undefined) {
    return `${manager} run ${script}`
  }

  return kind === 'typecheck' && (await exists($, cwd, 'tsconfig.json')) ? `${EXEC[manager]} tsc --noEmit` : undefined
}

const fromMakefile = async ($: EngineInterface, cwd: string, kind: Kind): Promise<string | undefined> => {
  const makefile = await readText($, cwd, 'Makefile')
  const target = KINDS[kind].makeTargets.find(name => makefile !== undefined && new RegExp(`^${name}\\s*:`, 'm').test(makefile))

  return target === undefined ? undefined : `make ${target}`
}

const fromPython = async ($: EngineInterface, cwd: string, kind: Kind): Promise<string | undefined> => {
  const pyproject = await readText($, cwd, 'pyproject.toml')
  const has = (section: string): boolean => pyproject?.includes(section) === true

  switch (kind) {
    case 'test':
      return pyproject !== undefined || (await exists($, cwd, 'pytest.ini')) ? 'pytest' : undefined
    case 'lint':
      return has('[tool.ruff') ? 'ruff check .' : undefined
    case 'build':
      return has('[build-system]') ? 'python -m build' : undefined
    case 'typecheck':
      if (has('[tool.pyright') || (await exists($, cwd, 'pyrightconfig.json'))) {
        return 'pyright'
      }
      return has('[tool.mypy') || (await exists($, cwd, 'mypy.ini')) ? 'mypy .' : undefined
  }
}

const detect = async ($: EngineInterface, cwd: string, kind: Kind): Promise<string | undefined> => {
  const fromJs = await fromPackageJson($, cwd, kind)
  if (fromJs !== undefined) {
    return fromJs
  }

  const fromMake = await fromMakefile($, cwd, kind)
  if (fromMake !== undefined) {
    return fromMake
  }

  if (await exists($, cwd, 'Cargo.toml')) {
    return KINDS[kind].cargo
  }

  const fromPy = await fromPython($, cwd, kind)
  if (fromPy !== undefined) {
    return fromPy
  }

  return (await exists($, cwd, 'go.mod')) ? KINDS[kind].go : undefined
}

const commandFor = async (
  $: EngineInterface,
  options: PluginOptions,
  kind: Kind,
): Promise<string | undefined> => {
  const configured = options[KINDS[kind].option]

  if (typeof configured === 'string' && configured.trim() !== '') {
    return configured.trim()
  }

  return detect($, await $.session.cwd(), kind)
}

const promptFor = (kind: Kind, command: string, focus: string): string => {
  const { noun, fix } = KINDS[kind]
  const scope = focus === '' ? '' : ` Limit it to: ${focus}.`

  return `Run the ${noun} with \`${command}\` and ${fix}.${scope}`
}

// ── mods-hub: the result of the command quick-commands asked for, on the bus ────────────────────────

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
const ownVersion = async ($: EngineInterface): Promise<string> => {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Says hello to mods-hub when it is installed. */
const greetHub = async ($: EngineInterface): Promise<void> => {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: ['test.result', 'build.result', 'lint.result', 'typecheck.result'], consumes: [] })
}

/** What Bash printed, stdout and stderr. */
const outputOf = (ran: ToolCallResult): string => {
  const result = ran.result as { stdout?: unknown; stderr?: unknown } | undefined
  if (result !== undefined && result !== null && typeof result === 'object' && typeof result.stdout === 'string') {
    return `${result.stdout}\n${typeof result.stderr === 'string' ? result.stderr : ''}`
  }
  return typeof ran.text === 'string' ? ran.text : ''
}

/**
 * The result of a check Claude ran because of /t, /l, /b or /tc, on the hub's bus: `build.result`, `lint.result`,
 * `typecheck.result` (errors and warnings read from the output), and `test.result` for a test command the hub's
 * own sensor does not recognize (a custom `testCommand`); the hub reports the usual runners itself.
 */
const publishResult = async ($: EngineInterface, asked: { kind: Kind; command: string }, command: string, output: string, hasFailed: boolean, durationMs: number): Promise<void> => {
  const { kind } = asked
  const tool = toolOf(asked.command)
  const short = command.slice(0, MAX_EVENT_COMMAND)
  const outcome = hasFailed ? 'failed' : 'passed'
  if (kind === 'test') {
    if (isTestCommand(command)) return
    const summary = summarizeRun(command, output, hasFailed)
    await hubPublish($, { topic: 'test.result', data: { runner: summary.runner ?? tool, outcome: summary.outcome, passed: summary.passed, failed: summary.failed, durationMs, command: short } })
  } else if (kind === 'build') {
    const { errors } = checkCountsOf(output, hasFailed)
    await hubPublish($, { topic: 'build.result', data: { tool, outcome, durationMs, command: short, errors } })
  } else if (kind === 'lint') {
    await hubPublish($, { topic: 'lint.result', data: { tool, ...checkCountsOf(output, hasFailed) } })
  } else {
    await hubPublish($, { topic: 'typecheck.result', data: { tool, errors: checkCountsOf(output, hasFailed).errors } })
  }
}

/** The asked-for command this Bash call runs (`cd web && npm run lint` runs `npm run lint`), taken off the waiting list. */
const takePending = (pending: Pending, command: string, now: number): { kind: Kind; command: string } | undefined => {
  for (const [kind, asked] of pending) {
    if (now - asked.at > PENDING_MS) pending.delete(kind)
    else if (command.includes(asked.command)) {
      pending.delete(kind)
      return { kind, command: asked.command }
    }
  }
  return undefined
}

const run = async (
  $: EngineInterface,
  options: PluginOptions,
  kind: Kind,
  focus: string,
  pending: Pending,
): Promise<{ text: string }> => {
  const command = await commandFor($, options, kind)

  if (command === undefined) {
    return {
      text: `No ${KINDS[kind].noun} command found. Set "${KINDS[kind].option}" in this mod's settings, or add a script or Makefile target.`,
    }
  }

  if ((await hubMode($)) !== undefined) pending.set(kind, { command, at: await $.clock.now() })

  // Queued from a timer, after this command's own dispatch has ended: the prompt then starts a turn of its own.
  $.clock.after(1, () => {
    $.prompt.submit({ text: promptFor(kind, command, focus), asUser: true }).catch(() => undefined)
  })

  return { text: `Running the ${KINDS[kind].noun}: ${command}` }
}

export const register: Register = (on, options) => {
  const pending: Pending = new Map()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 't',
      description: 'Run the test suite and fix failures',
      argumentHint: '[what to test]',
    })
    await $.command.register({
      name: 'l',
      description: 'Run the linter and fix what it reports',
      argumentHint: '[what to lint]',
    })
    await $.command.register({
      name: 'b',
      description: 'Run the build and fix errors',
      argumentHint: '[what to build]',
    })
    await $.command.register({
      name: 'tc',
      description: 'Run the type checker and fix type errors',
      argumentHint: '[what to check]',
    })
    await greetHub($)

    return next(e)
  })

  on('command.run', { command: 't' }, ($, e) => run($, options, 'test', e.args.trim(), pending))
  on('command.run', { command: 'l' }, ($, e) => run($, options, 'lint', e.args.trim(), pending))
  on('command.run', { command: 'b' }, ($, e) => run($, options, 'build', e.args.trim(), pending))
  on('command.run', { command: 'tc' }, ($, e) => run($, options, 'typecheck', e.args.trim(), pending))

  // With mods-hub only (nothing waits otherwise): the Bash call that runs an asked-for command, and its result.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (pending.size === 0) return next(e)
    const startedAt = await $.clock.now()
    const ran = await next(e)
    const asked = ran.deny === undefined ? takePending(pending, e.command, startedAt) : undefined
    if (asked === undefined) return ran
    const durationMs = (await $.clock.now()) - startedAt
    const command = e.command
    const output = outputOf(ran)
    const hasFailed = ran.isError === true
    $.clock.after(0, () => void publishResult($, asked, command, output, hasFailed, durationMs))
    return ran
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
