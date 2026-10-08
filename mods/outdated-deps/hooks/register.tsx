import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { OutdatedCheck, OutdatedView } from '../types'
import {
  kindLine,
  parseCargoOutdated,
  parseGoList,
  parseNpmOutdated,
  parsePipOutdated,
  parsePnpmOutdated,
  parseYarnOutdated,
  pyprojectNames,
  requirementNames,
  safeUpgrades,
  sortByRisk,
  upgradeCommand,
  upgradePrompt,
} from './outdated'
import type { Kind, Manager, Package } from './outdated'

type Settings = { timeoutMs: number; checkDeprecated: boolean }
type Memory = { isBusy: boolean }
/** How one manager's check runs: the command and its parser, or why it cannot run here. */
type Plan = { manager: Manager; tool: string; argv: string[]; parse: (text: string) => Package[] } | { manager: Manager; tool: string; note: string }

const PANE = 'outdated'
const EMPTY: OutdatedView = { phase: 'idle', running: null, checks: [], at: 0 }
const DEFAULT_TIMEOUT_SECONDS = 120
const MAX_TIMEOUT_SECONDS = 600
const FETCH_TIMEOUT_MS = 8_000
const MAX_DEPRECATION_LOOKUPS = 40
const LOOKUP_BATCH = 8
const MAX_ROWS = 60
const VERSION_COLUMNS = 12
const NARROW_COLUMNS = 80
const VENV_DIRS = ['.venv', 'venv', 'env']
const PYTHON_MANIFESTS = ['pyproject.toml', 'requirements.txt', 'requirements-dev.txt', 'requirements.in', 'setup.cfg', 'setup.py']
const RUN_ENV = { NO_COLOR: '1', FORCE_COLOR: '0', npm_config_update_notifier: 'false' }
const KIND_STYLE: Record<Kind, { label: string; color: string }> = {
  major: { label: 'MAJOR', color: 'error' },
  minor: { label: 'minor', color: 'warning' },
  patch: { label: 'patch', color: 'success' },
}

const view = atom({ plugin: 'outdated-deps', key: 'view' } as const, EMPTY)

const join = (...parts: string[]): string => parts.filter(part => part !== '').join('/').replace(/\/{2,}/g, '/')

async function exists($: EngineInterface, path: string): Promise<boolean> {
  return $.fs.exists(path).catch(() => false)
}

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  const text = await $.fs.read(path).catch(() => undefined)
  return typeof text === 'string' ? text : undefined
}

/** The project's virtualenv python, or the active one. */
async function venvPython($: EngineInterface, root: string): Promise<{ python: string; hasPip: boolean } | undefined> {
  const active = await $.env.get('VIRTUAL_ENV').catch(() => undefined)
  const venvs = [...VENV_DIRS.map(name => join(root, name)), ...(active === undefined || active === '' ? [] : [active])]
  for (const venv of venvs) {
    for (const [python, pip] of [
      [join(venv, 'bin', 'python'), join(venv, 'bin', 'pip')],
      [join(venv, 'Scripts', 'python.exe'), join(venv, 'Scripts', 'pip.exe')],
    ] as const) {
      if (await exists($, python)) return { python, hasPip: await exists($, pip) }
    }
  }
  return undefined
}

/** The checks that apply to the project, from its lockfiles, manifests and virtualenv. */
async function planChecks($: EngineInterface, root: string): Promise<Plan[]> {
  const names = new Set((await $.fs.list(root).catch(() => [])).map(entry => entry.name))
  const plans: Plan[] = []
  if (names.has('pnpm-lock.yaml')) {
    plans.push({ manager: 'pnpm', tool: 'pnpm outdated', argv: ['pnpm', 'outdated', '--format', 'json'], parse: parsePnpmOutdated })
  } else if (names.has('yarn.lock')) {
    const lock = await readText($, join(root, 'yarn.lock'))
    const isBerry = names.has('.yarnrc.yml') || /^__metadata:/m.test(lock ?? '')
    plans.push(
      isBerry
        ? { manager: 'yarn', tool: 'yarn', note: 'Yarn 2+ has no outdated command: run yarn upgrade-interactive.' }
        : { manager: 'yarn', tool: 'yarn outdated', argv: ['yarn', 'outdated', '--json'], parse: parseYarnOutdated },
    )
  } else if (names.has('package.json')) {
    plans.push({ manager: 'npm', tool: 'npm outdated', argv: ['npm', 'outdated', '--json', '--long'], parse: parseNpmOutdated })
  }

  if (PYTHON_MANIFESTS.some(name => names.has(name)) || VENV_DIRS.some(name => names.has(name))) {
    const venv = await venvPython($, root)
    const direct = new Set<string>()
    for (const name of PYTHON_MANIFESTS.filter(file => names.has(file) && file !== 'setup.cfg')) {
      const text = (await readText($, join(root, name))) ?? ''
      for (const found of name === 'pyproject.toml' ? pyprojectNames(text) : requirementNames(text)) direct.add(found)
    }
    const parse = (text: string): Package[] => parsePipOutdated(text, direct)
    if (venv === undefined) {
      plans.push({ manager: 'pip', tool: 'pip list', note: 'No virtualenv found (.venv, venv, env): pip list checks the project\'s own environment.' })
    } else if (venv.hasPip) {
      plans.push({ manager: 'pip', tool: 'pip list', argv: [venv.python, '-m', 'pip', 'list', '--outdated', '--format=json'], parse })
    } else {
      plans.push({ manager: 'pip', tool: 'uv pip list', argv: ['uv', 'pip', 'list', '--outdated', '--format', 'json', '--python', venv.python], parse })
    }
  }
  if (names.has('Cargo.toml')) {
    plans.push({ manager: 'cargo', tool: 'cargo outdated', argv: ['cargo', 'outdated', '--root-deps-only', '--format', 'json'], parse: parseCargoOutdated })
  }
  if (names.has('go.mod')) plans.push({ manager: 'go', tool: 'go list', argv: ['go', 'list', '-u', '-m', '-json', 'all'], parse: parseGoList })
  return plans
}

/** Why a check failed, in a few words. */
function failureOf(plan: { tool: string; argv: string[] }, error: unknown, stderr = ''): string {
  const text = `${String(error)}\n${stderr}`
  if (/no such (?:sub)?command:?\s*`?outdated/i.test(text)) return 'cargo-outdated is not installed (cargo install cargo-outdated)'
  if (/failed to start|ENOENT/i.test(text)) return `${plan.argv[0]} is not installed`
  if (/still running/i.test(text)) return 'timed out'
  const line = text
    .split('\n')
    .map(part => part.trim())
    .find(part => part !== '' && !/^(?:warning|npm warn|Error: undefined)/i.test(part))
  return (line ?? `${plan.tool} failed`).slice(0, 160)
}

async function runCheck($: EngineInterface, settings: Settings, root: string, plan: Plan): Promise<OutdatedCheck> {
  if ('note' in plan) return { manager: plan.manager, tool: plan.tool, packages: [], note: plan.note }
  await update($, view, (current): OutdatedView => ({ ...current, running: plan.tool }))
  try {
    const ran = await $.process.run(plan.argv, { cwd: root, timeoutMs: settings.timeoutMs, env: RUN_ENV })
    // The outdated commands exit 1 when something is outdated: what they print decides.
    if (ran.stdout.trim() === '' && ran.exitCode !== 0) return { manager: plan.manager, tool: plan.tool, packages: [], error: failureOf(plan, '', ran.stderr) }
    try {
      return { manager: plan.manager, tool: plan.tool, packages: plan.parse(ran.stdout) }
    } catch (error) {
      return { manager: plan.manager, tool: plan.tool, packages: [], error: failureOf(plan, error, ran.stderr) }
    }
  } catch (error) {
    return { manager: plan.manager, tool: plan.tool, packages: [], error: failureOf(plan, error) }
  }
}

async function fetchWithin($: EngineInterface, url: string): Promise<string | undefined> {
  let timer: { cancel: () => void } | undefined
  const deadline = new Promise<undefined>(resolve => {
    timer = $.clock.after(FETCH_TIMEOUT_MS, () => resolve(undefined))
  })
  try {
    const response = await Promise.race([$.http.fetch(url), deadline])
    return response?.ok === true ? response.text : undefined
  } catch {
    return undefined
  } finally {
    timer?.cancel()
  }
}

/** npm and yarn do not say what is deprecated: ask the registry about each installed version. */
async function markDeprecated($: EngineInterface, packages: Package[]): Promise<void> {
  const asked = packages.filter(pkg => (pkg.manager === 'npm' || pkg.manager === 'yarn') && pkg.deprecated === undefined).slice(0, MAX_DEPRECATION_LOOKUPS)
  for (let start = 0; start < asked.length; start += LOOKUP_BATCH) {
    await Promise.all(
      asked.slice(start, start + LOOKUP_BATCH).map(async pkg => {
        const text = await fetchWithin($, `https://registry.npmjs.org/${pkg.name.replace('/', '%2f')}/${encodeURIComponent(pkg.current)}`)
        if (text === undefined) return
        try {
          const manifest: unknown = JSON.parse(text)
          const notice = typeof manifest === 'object' && manifest !== null ? (manifest as Record<string, unknown>).deprecated : undefined
          if (typeof notice === 'string' && notice !== '') pkg.deprecated = notice
        } catch {
          // Not JSON: leave it unflagged.
        }
      }),
    )
  }
}

async function projectRoot($: EngineInterface): Promise<string> {
  try {
    const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { timeoutMs: 10_000 })
    if (top.exitCode === 0 && top.stdout.trim() !== '') return top.stdout.trim()
  } catch {
    // Not a repository: the session's folder is the project.
  }
  return $.session.cwd()
}

async function checkAll($: EngineInterface, settings: Settings, memory: Memory, root: string, plans: readonly Plan[]): Promise<void> {
  try {
    const checks: OutdatedCheck[] = []
    for (const plan of plans) {
      const check = await runCheck($, settings, root, plan)
      if (settings.checkDeprecated) await markDeprecated($, check.packages)
      checks.push(check)
    }
    const at = await $.clock.now()
    await update($, view, (): OutdatedView => ({ phase: 'done', running: null, checks, at }))
    const packages = checks.flatMap(check => check.packages)
    const hasAnswer = checks.some(check => check.error === undefined && check.note === undefined)
    $.ui.toast(
      packages.length > 0
        ? `${packages.length} outdated: ${kindLine(packages)}`
        : hasAnswer
          ? 'Dependencies are up to date.'
          : `Nothing could be checked: ${checks[0]?.error ?? checks[0]?.note ?? 'no package manager answered'}`,
    )
  } finally {
    memory.isBusy = false
  }
}

/** Starts the checks in the background; answers what the person is told. */
async function startChecks($: EngineInterface, settings: Settings, memory: Memory): Promise<string> {
  if (memory.isBusy) return 'Already checking; the /outdated pane fills in when done.'
  const root = await projectRoot($)
  const plans = await planChecks($, root)
  if (plans.length === 0) return 'Nothing to check here: no package.json, Python project, Cargo.toml or go.mod.'
  memory.isBusy = true
  await update($, view, (current): OutdatedView => ({ ...current, phase: 'checking', running: plans[0]?.tool ?? null }))
  await $.ui.open({ id: PANE, title: 'Outdated' }).catch(() => undefined)
  $.clock.after(0, () => void checkAll($, settings, memory, root, plans))
  return `Checking ${plans.map(plan => plan.tool).join(', ')}…`
}

async function pressRefresh($: EngineInterface, settings: Settings, memory: Memory): Promise<void> {
  const said = await startChecks($, settings, memory)
  if (!said.startsWith('Checking')) $.ui.toast(said)
}

async function askToUpgrade($: EngineInterface): Promise<void> {
  const packages = safeUpgrades((await read($, view)).checks.flatMap(check => check.packages))
  if (packages.length === 0) return
  const text = upgradePrompt(packages)
  $.clock.after(1, () => void $.prompt.submit({ text, asUser: true }).catch(() => undefined))
  $.ui.toast(`Asked Claude to upgrade ${packages.length} package${packages.length === 1 ? '' : 's'} (patch and minor).`)
}

async function copyCommand($: EngineInterface, pkg: Package, surface: Parameters<EngineInterface['ui']['copy']>[0]['surface']): Promise<void> {
  const command = upgradeCommand(pkg)
  const copied = await $.ui.copy({ text: command, surface })
  $.ui.toast(copied.isCopied ? `Copied: ${command}` : `Could not copy (${copied.reason}): ${command}`)
}

const cell = (text: string, width: number): string => (text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width))

export const register: Register = (on, options) => {
  const seconds = Number(options.timeoutSeconds) > 0 ? Number(options.timeoutSeconds) : DEFAULT_TIMEOUT_SECONDS
  const settings: Settings = { timeoutMs: Math.min(seconds, MAX_TIMEOUT_SECONDS) * 1000, checkDeprecated: options.checkDeprecated !== false }
  const memory: Memory = { isBusy: false }

  on('session.start', async ($, e, next) => {
    await registerCommand($, { name: 'outdated', description: 'Stale dependencies and how risky each upgrade is (npm, pnpm, yarn, pip, cargo, go)' })
    return next(e)
  })

  on('command.run', { command: 'outdated' }, async $ => ({ text: await startChecks($, settings, memory) }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const current = await read($, view)
    const close = <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
    if (current.phase !== 'done') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold color="suggestion">
            {current.phase === 'checking' ? `⧗ Running ${current.running ?? 'the checks'}…` : 'No check yet'}
          </Text>
          <Text dimColor>{current.phase === 'checking' ? 'Registries are asked over the network; this can take a little while.' : 'Run /outdated.'}</Text>
          {close}
        </Box>
      )
    }

    const packages = sortByRisk(current.checks.flatMap(check => check.packages))
    const upgrades = safeUpgrades(packages)
    const hasAnswer = current.checks.some(check => check.error === undefined && check.note === undefined)
    const headline = packages.length > 0 ? `${packages.length} outdated · ${kindLine(packages)}` : hasAnswer ? 'Everything is up to date' : 'Nothing could be checked'
    const isNarrow = e.props.bodyColumns < NARROW_COLUMNS
    const nameWidth = Math.min(32, Math.max(10, ...packages.map(pkg => pkg.name.length + (pkg.deprecated === undefined ? 0 : 2))))
    return (
      <Box flexDirection="column" gap={1}>
        <Box key="summary" flexDirection="column">
          <Text bold color={packages.length === 0 ? (hasAnswer ? 'success' : 'warning') : undefined}>
            📦 {headline}
          </Text>
          {current.checks.map(check => (
            <Text key={`check:${check.manager}`} dimColor={check.error === undefined && check.note === undefined} color={check.error !== undefined ? 'warning' : undefined} wrap="truncate-end">
              {check.tool}: {check.error ?? check.note ?? `${check.packages.length} outdated`}
            </Text>
          ))}
        </Box>
        {packages.length > 0 && (
          <Box key="table" flexDirection="column">
            {packages.slice(0, MAX_ROWS).map(pkg => {
              const style = KIND_STYLE[pkg.kind]
              const isIndirect = pkg.isDirect === false
              const name = `${pkg.name}${pkg.deprecated === undefined ? '' : ' ⚠'}`
              return (
                <Box key={`row:${pkg.manager}:${pkg.name}`} flexDirection="column">
                  <Box flexDirection="row" gap={1}>
                    <Text bold={!isIndirect} dimColor={isIndirect} color={pkg.deprecated === undefined ? undefined : 'warning'}>
                      {cell(name, nameWidth)}
                    </Text>
                    <Text dimColor>{cell(pkg.current, VERSION_COLUMNS)}</Text>
                    <Text>→ {cell(pkg.latest, VERSION_COLUMNS)}</Text>
                    <Text color={style.color} bold={pkg.kind === 'major'}>
                      {style.label.padEnd(5)}
                    </Text>
                    <Box flexGrow={1}>
                      {!isNarrow && (
                        <Text dimColor wrap="truncate-end">
                          {[pkg.kind === 'major' && pkg.safe !== undefined ? `${pkg.safe.kind} to ${pkg.safe.version}` : '', isIndirect ? 'indirect' : '', pkg.isDev === true ? 'dev' : '', pkg.manager]
                            .filter(part => part !== '')
                            .join(' · ')}
                        </Text>
                      )}
                    </Box>
                    <Button key={`copy:${pkg.manager}:${pkg.name}`} label="Copy" plain dimColor onPress={press => void copyCommand($, pkg, press.surface)} />
                  </Box>
                  {pkg.deprecated !== undefined && (
                    <Text color="warning" wrap="truncate-end">
                      {'  '}deprecated: {pkg.deprecated}
                    </Text>
                  )}
                </Box>
              )
            })}
            {packages.length > MAX_ROWS && <Text dimColor>…and {packages.length - MAX_ROWS} more.</Text>}
          </Box>
        )}
        <Box key="actions" flexDirection="row" gap={1}>
          {upgrades.length > 0 && (
            <Button key="upgrade" label={`Upgrade all patch/minor (${upgrades.length})`} hotkey="u" variant="primary" onPress={() => void askToUpgrade($)} />
          )}
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => void pressRefresh($, settings, memory)} />
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
