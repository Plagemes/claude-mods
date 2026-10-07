import type { EngineInterface, Register } from 'claude-code'

import { simpleCommands } from './shared/shell'
import { everywhere, findPackage, packageJsonGlobs, packageOf, pnpmGlobs, scopeCommand } from './workspace'
import type { Manager, Package } from './workspace'

const MAX_LEVELS = 10
const MAX_DEPTH = 4
const MAX_PACKAGES = 300
const DEFAULT_SCRIPTS = 'test,lint,build,typecheck,check'
const NX_GLOBS = ['apps/*', 'libs/*', 'libs/*/*', 'packages/*']
const LERNA_GLOBS = ['packages/*']
const SKIPPED_DIR = /^(?:node_modules|\..*|dist|build|coverage)$/
const MANIFESTS = /(?:^|\/)(?:package\.json|pnpm-workspace\.yaml|project\.json|lerna\.json|nx\.json|turbo\.json)$/

/** The monorepo: its root, the package manager whose filters scope scripts, and its packages. */
type Workspace = { root: string; manager: Manager; packages: Package[] }

type Settings = { isRewriting: boolean; scripts: Set<string> }

/** What this load of the mod holds: the workspace (undefined until scanned), the current package, and the mode. */
type Host = { workspace: Workspace | null | undefined; current: Package | undefined; isPinned: boolean; isOff: boolean; isHubbed: boolean }

const parseJson = (text: string | undefined): Record<string, unknown> | undefined => {
  if (text === undefined) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const keysOf = (value: unknown): string[] => (typeof value === 'object' && value !== null ? Object.keys(value) : [])
const label = (pkg: Package): string => (pkg.name !== '' ? pkg.name : pkg.dir)
const relative = (root: string, path: string): string => (path === root ? '' : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path)

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  const text = await $.fs.read(path).catch(() => undefined)
  return typeof text === 'string' ? text : undefined
}

async function subdirs($: EngineInterface, dir: string): Promise<string[]> {
  const entries = await $.fs.list(dir).catch(() => [])
  return entries.filter(entry => entry.kind === 'dir' && !SKIPPED_DIR.test(entry.name)).map(entry => entry.name)
}

/** The folders a workspace glob names (`apps/*`, `packages/**`, `tools/cli`), relative to the root. */
async function expand($: EngineInterface, root: string, glob: string): Promise<string[]> {
  let found = ['']
  for (const segment of glob.replace(/^\.\//, '').replace(/\/$/, '').split('/')) {
    const next: string[] = []
    for (const base of found) {
      const dir = base === '' ? root : `${root}/${base}`
      if (segment === '**') {
        const walk = async (path: string, depth: number) => {
          next.push(path)
          if (depth >= MAX_DEPTH) return
          for (const name of await subdirs($, path === '' ? root : `${root}/${path}`)) await walk(path === '' ? name : `${path}/${name}`, depth + 1)
        }
        await walk(base, 0)
      } else if (/[*?]/.test(segment)) {
        const pattern = new RegExp(`^${segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
        for (const name of await subdirs($, dir)) if (pattern.test(name)) next.push(base === '' ? name : `${base}/${name}`)
      } else {
        next.push(base === '' ? segment : `${base}/${segment}`)
      }
    }
    found = next
  }
  return found.filter(path => path !== '')
}

/** A package from its folder's package.json and Nx project.json; undefined when the folder has neither. */
async function readPackage($: EngineInterface, root: string, dir: string): Promise<Package | undefined> {
  const manifest = parseJson(await readText($, `${root}/${dir}/package.json`))
  const project = parseJson(await readText($, `${root}/${dir}/project.json`))
  if (manifest === undefined && project === undefined) return undefined
  const name = typeof manifest?.name === 'string' ? manifest.name : ''
  const nx = manifest?.nx
  const nxName = typeof nx === 'object' && nx !== null && typeof (nx as { name?: unknown }).name === 'string' ? (nx as { name: string }).name : undefined
  const projectName = typeof project?.name === 'string' ? project.name : (nxName ?? (name.split('/').pop() || dir.split('/').pop() || dir))
  return { name, dir, scripts: [...new Set([...keysOf(manifest?.scripts), ...keysOf(project?.targets)])], project: projectName }
}

/** Finds the monorepo the session is in: the nearest folder up from `start` with a workspace marker. */
async function discover($: EngineInterface, start: string): Promise<Workspace | null> {
  let dir = start
  for (let level = 0; level < MAX_LEVELS; level += 1) {
    const names = new Set((await $.fs.list(dir).catch(() => [])).map(entry => entry.name))
    const manifest = names.has('package.json') ? (parseJson(await readText($, `${dir}/package.json`)) ?? {}) : {}
    const pnpm = names.has('pnpm-workspace.yaml') ? pnpmGlobs((await readText($, `${dir}/pnpm-workspace.yaml`)) ?? '') : []
    const lerna = names.has('lerna.json') ? parseJson(await readText($, `${dir}/lerna.json`)) : undefined
    const globs = pnpm.length > 0 ? pnpm : packageJsonGlobs(manifest).length > 0 ? packageJsonGlobs(manifest) : lerna !== undefined ? (Array.isArray(lerna.packages) ? lerna.packages.map(String) : LERNA_GLOBS) : names.has('nx.json') || names.has('turbo.json') ? NX_GLOBS : []
    if (globs.length > 0) {
      const declared = typeof manifest.packageManager === 'string' ? manifest.packageManager.split('@')[0] : undefined
      const manager: Manager =
        declared === 'pnpm' || declared === 'yarn' || declared === 'bun' || declared === 'npm'
          ? declared
          : names.has('pnpm-workspace.yaml') || names.has('pnpm-lock.yaml')
            ? 'pnpm'
            : names.has('yarn.lock')
              ? 'yarn'
              : names.has('bun.lock') || names.has('bun.lockb')
                ? 'bun'
                : 'npm'
      const dirs = [...new Set((await Promise.all(globs.map(glob => expand($, dir, glob)))).flat())].slice(0, MAX_PACKAGES)
      const packages = (await Promise.all(dirs.map(path => readPackage($, dir, path)))).filter((pkg): pkg is Package => pkg !== undefined)
      return packages.length === 0 ? null : { root: dir, manager, packages: packages.sort((a, b) => a.dir.localeCompare(b.dir)) }
    }
    if (names.has('.git')) return null
    const parent = dir.slice(0, Math.max(1, dir.lastIndexOf('/')))
    if (parent === dir) return null
    dir = parent
  }
  return null
}

async function workspaceOf($: EngineInterface, host: Host): Promise<Workspace | null> {
  if (host.workspace === undefined) host.workspace = await discover($, await $.session.cwd()).catch(() => null)
  return host.workspace
}

async function showStatus($: EngineInterface, host: Host): Promise<void> {
  $.ui.status(host.isOff || host.current === undefined ? undefined : `📦 ${label(host.current)}${host.isPinned ? ' (pinned)' : ''}`)
  if (host.isHubbed) await shareScope($, host)
}

/** The fact `monorepo-scope.package` on the hub's blackboard: which package test, lint and build are scoped to (null when scoping is off or none is known yet). */
async function shareScope($: EngineInterface, host: Host): Promise<void> {
  const pkg = host.isOff ? undefined : host.current
  try {
    await $.mods.share({
      name: 'package',
      value: pkg === undefined ? null : { name: label(pkg), dir: pkg.dir, isPinned: host.isPinned, manager: host.workspace?.manager ?? null },
    })
  } catch {
    // No hub: the status line is all there is.
  }
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

/** With mods-hub installed: hello (this mod shares the fact `monorepo-scope.package`). */
async function greetHub($: EngineInterface, host: Host): Promise<void> {
  if ((await hubMode($)) === undefined) return
  host.isHubbed = await hubHello($, { version: await ownVersion($), publishes: [], consumes: [] })
}

/** Follows the package of a file Claude edited, unless one is pinned. */
async function follow($: EngineInterface, host: Host, file: string): Promise<void> {
  if (MANIFESTS.test(file)) host.workspace = undefined
  const workspace = await workspaceOf($, host)
  if (workspace === null || host.isPinned) return
  const pkg = packageOf(workspace.packages, relative(workspace.root, file))
  if (pkg === undefined || pkg.dir === host.current?.dir) return
  host.current = pkg
  await showStatus($, host)
}

function describe(workspace: Workspace, host: Host): string {
  const now = host.isOff
    ? 'Scoping is off.'
    : host.current === undefined
      ? 'No package yet: it follows the files Claude edits.'
      : `📦 ${label(host.current)} (${host.current.dir}) · ${host.isPinned ? 'pinned' : 'following your edits'}`
  const listed = workspace.packages.slice(0, 40).map(pkg => `  ${label(pkg)}  ${pkg.dir}`)
  const more = workspace.packages.length > 40 ? [`  … and ${workspace.packages.length - 40} more`] : []
  return [
    now,
    `Workspace ${workspace.root} (${workspace.manager}), ${workspace.packages.length} packages:`,
    ...listed,
    ...more,
    '/scope-pkg <name> pins a package · /scope-pkg auto follows edits · /scope-pkg off stops scoping',
  ].join('\n')
}

export const register: Register = (on, options) => {
  const scripts = String(options.scripts ?? DEFAULT_SCRIPTS)
    .split(',')
    .map(script => script.trim())
    .filter(Boolean)
  const settings: Settings = { isRewriting: options.autoScope !== false, scripts: new Set(scripts.length > 0 ? scripts : DEFAULT_SCRIPTS.split(',')) }
  const host: Host = { workspace: undefined, current: undefined, isPinned: false, isOff: false, isHubbed: false }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'scope-pkg', description: 'Show or set the monorepo package test/lint/build are scoped to', argumentHint: '[package | auto | off]' })
    await greetHub($, host)
    return next(e)
  })

  on('command.run', { command: 'scope-pkg' }, async ($, e) => {
    host.workspace = undefined
    const workspace = await workspaceOf($, host)
    if (workspace === null) return { text: 'No monorepo workspace here (pnpm-workspace.yaml, package.json workspaces, lerna.json, nx.json or turbo.json).' }
    const arg = e.args.trim()
    if (arg === 'off') {
      host.isOff = true
      await showStatus($, host)
      return { text: 'Scoping is off for this session. /scope-pkg auto turns it back on.' }
    }
    if (arg === 'auto') {
      host.isOff = false
      host.isPinned = false
      await showStatus($, host)
      return { text: 'Following the package of the files Claude edits.' }
    }
    if (arg !== '') {
      const pkg = findPackage(workspace.packages, arg)
      if (pkg === undefined) return { text: `No package "${arg}". ${describe(workspace, host)}` }
      host.current = pkg
      host.isPinned = true
      host.isOff = false
      await showStatus($, host)
      return { text: `Pinned to ${label(pkg)} (${pkg.dir}).` }
    }
    return { text: describe(workspace, host) }
  })

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const ran = await next(e)
    const file = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : ''
    if (ran.deny === undefined && ran.isError !== true && file !== '') await follow($, host, file).catch(() => undefined)
    return ran
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const pkg = host.current
    if (host.isOff || pkg === undefined) return next(e)
    const workspace = await workspaceOf($, host).catch(() => null)
    const cwd = await $.session.cwd().catch(() => '')
    if (workspace === null || cwd.replace(/\/$/, '') !== workspace.root) return next(e)
    // One simple command only: the shell reader sees a pipe, `&&`, a substitution or a nested script that the pattern check cannot rule out.
    if (simpleCommands(e.command).length !== 1) return next(e)
    const scoped = scopeCommand(e.command, pkg, workspace.manager, settings.scripts)
    if (scoped === undefined) return next(e)

    if (!settings.isRewriting) {
      const ran = await next(e)
      const hint = `monorepo-scope: the latest edits are in ${label(pkg)} (${pkg.dir}); \`${scoped.command}\` runs only that package.`
      return ran.deny !== undefined ? ran : { ...ran, context: [...(ran.context ?? []), hint] }
    }
    const all = /\bturbo\b/.test(scoped.command)
      ? `${e.command.trim()} --filter='*'`
      : /\bnx\b/.test(scoped.command)
        ? `nx run-many -t ${scoped.task} --all`
        : everywhere(workspace.manager, scoped.task)
    const ran = await next({ ...e, command: scoped.command })
    const note = `monorepo-scope: ran \`${scoped.command}\` instead of \`${e.command.trim()}\`, scoped to ${label(pkg)} (${pkg.dir}) where the latest edits are. For every package run \`${all}\`, or the user can turn this off with /scope-pkg off.`
    return ran.deny !== undefined ? ran : { ...ran, context: [...(ran.context ?? []), note] }
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
