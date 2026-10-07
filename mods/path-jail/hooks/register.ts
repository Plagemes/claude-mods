import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { writeTargets } from './bash'
import { redactSummary } from './shared/secrets'

/** `isLiteral`: a tool's own path field (Edit, Write): no shell reads it, so `$` and backticks are plain characters. */
type Target = { path: string; via: string; cdChain: readonly string[]; isLiteral?: boolean }
type Jail = { roots: string[]; sep: string; cwd: string; home: string | undefined; tmp: string | undefined }
type Placed = { real: string } | { problem: string }

const PLUGIN = 'path-jail'
const GUARDED_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit|Bash)$/
const MAX_NORMALIZE_PASSES = 3
const addedRoots = atom({ plugin: 'path-jail', key: 'addedRoots' } as const, [])

const splitPath = (path: string): string[] => path.split(/[\\/]+/)
const isAbsolute = (path: string): boolean => /^(?:[A-Za-z]:)?[\\/]/.test(path)
const listOption = (value: unknown): string[] =>
  typeof value === 'string' ? value.split(',').map(part => part.trim()).filter(part => part !== '') : []

/** Folds `.` and `..` lexically; only used on parts below a real path that do not exist yet. */
const normalize = (parts: readonly string[]): string[] => {
  const out: string[] = []
  for (const part of parts) {
    if (part === '.' || (part === '' && out.length > 0)) continue
    if (part === '..') {
      if (out.length > 1) out.pop()
      continue
    }
    out.push(part)
  }
  return out
}

/** Re-joins split parts, keeping a POSIX `/` or a drive root (`C:\`) as a root. */
const joinParts = (parts: readonly string[], sep: string): string => {
  const joined = parts.join(sep)
  if (joined === '') return sep
  return /^[A-Za-z]:$/.test(joined) ? joined + sep : joined
}

const isInside = (real: string, root: string, sep: string): boolean =>
  real === root || real.startsWith(root.endsWith(sep) ? root : root + sep)

/** Where an absolute path lands: the real path of its deepest existing ancestor, plus the parts not created yet. */
const placeAbsolute = async ($: EngineInterface, path: string, sep: string, pass = 0): Promise<Placed> => {
  const parts = splitPath(path)
  for (let cut = parts.length; cut > 0; cut -= 1) {
    const head = joinParts(parts.slice(0, cut), sep)
    const stat = await $.fs.stat(head, { resolve: true }).catch(() => undefined)
    if (stat === undefined) continue
    if (stat.realPath === undefined) return { problem: `${head} is a link that leads nowhere` }
    const rest = parts.slice(cut).filter(part => part !== '' && part !== '.')
    if (rest.length === 0) return { real: stat.realPath }
    if (!rest.includes('..')) return { real: joinParts([...splitPath(stat.realPath), ...rest], sep) }
    // `missing/..` folds back into existing folders, which may be links: resolve the folded path again.
    if (pass >= MAX_NORMALIZE_PASSES) return { problem: 'too many `..` steps to follow' }
    return placeAbsolute($, joinParts(normalize([...splitPath(stat.realPath), ...rest]), sep), sep, pass + 1)
  }
  return { problem: 'no part of it exists' }
}

/** Expands what a shell would before writing (`~`, `$HOME`, `$PWD`, `$TMPDIR`); undefined when it cannot. */
const expand = (path: string, jail: Jail, cwd: string, isLiteral = false): string | undefined => {
  let result = path
  if (result === '~' || result.startsWith('~/')) {
    if (jail.home === undefined) return undefined
    result = jail.home + result.slice(1)
  }
  // `app/routes/$slug.tsx` (Remix, TanStack Router) written with Edit/Write is a real file name, not an expansion.
  if (isLiteral) return result
  result = result
    .replace(/\$\{?HOME\}?(?![\w])/g, () => jail.home ?? '$HOME')
    .replace(/\$\{?PWD\}?(?![\w])/g, cwd)
    .replace(/\$\{?TMPDIR\}?(?![\w])/g, () => jail.tmp ?? '$TMPDIR')
  return /[$`]|^~/.test(result) ? undefined : result
}

/** A glob is checked by the folder it expands in; `..` after a glob cannot be followed. */
const withoutGlob = (path: string): string | undefined => {
  const index = path.search(/[*?[]/)
  if (index === -1) return path
  if (splitPath(path.slice(index)).includes('..')) return undefined
  const folderEnd = Math.max(path.lastIndexOf('/', index), path.lastIndexOf('\\', index))
  return `${folderEnd === -1 ? '.' : path.slice(0, folderEnd)}/*`
}

const placeTarget = async ($: EngineInterface, target: Target, jail: Jail): Promise<Placed> => {
  let cwd = jail.cwd
  for (const step of target.cdChain) {
    const directory: string | undefined = step === '-' ? undefined : expand(step, jail, cwd)
    if (directory === undefined) return { problem: `it follows a \`cd ${step}\` the jail cannot follow` }
    cwd = isAbsolute(directory) ? directory : `${cwd}${jail.sep}${directory}`
  }
  const expanded = expand(target.path, jail, cwd, target.isLiteral === true)
  if (expanded === undefined) return { problem: 'it uses a shell expansion the jail cannot check' }
  const literal = withoutGlob(expanded)
  if (literal === undefined) return { problem: 'it climbs out of a glob with `..`' }
  return placeAbsolute($, isAbsolute(literal) ? literal : `${cwd}${jail.sep}${literal}`, jail.sep)
}

const targetsOf = (e: { tool: string; [field: string]: unknown }): Target[] => {
  const tool = String(e.tool)
  const field = tool === 'NotebookEdit' ? e.notebook_path : tool === 'Bash' ? undefined : e.file_path
  if (typeof field === 'string') return [{ path: field, via: tool, cdChain: [], isLiteral: true }]
  if (tool === 'Bash' && typeof e.command === 'string') return writeTargets(e.command)
  return []
}

const orNext = (value: string | undefined, fallback: string | undefined): string | undefined =>
  value === undefined || value === '' ? fallback : value

/** The home folder: HOME, else USERPROFILE (Windows sets no HOME by default). */
const homeOf = async ($: EngineInterface): Promise<string | undefined> =>
  orNext(await $.env.get('HOME').catch(() => undefined), await $.env.get('USERPROFILE').catch(() => undefined))

/** The temp folder: TMPDIR, else TEMP (Windows). */
const tmpOf = async ($: EngineInterface): Promise<string | undefined> =>
  orNext(await $.env.get('TMPDIR').catch(() => undefined), await $.env.get('TEMP').catch(() => undefined))

const resolveRoot = async ($: EngineInterface, path: string, home: string | undefined): Promise<string | undefined> => {
  const expanded = path === '~' || path.startsWith('~/') || path.startsWith('~\\') ? (home === undefined ? undefined : home + path.slice(1)) : path
  if (expanded === undefined) return undefined
  const stat = await $.fs.stat(expanded, { resolve: true }).catch(() => undefined)
  return stat?.kind === 'dir' ? stat.realPath : undefined
}

/** The project root and every allowed folder, each resolved the way targets are. */
const loadJail = async ($: EngineInterface, extraRoots: readonly string[]): Promise<Jail> => {
  const [root, cwd, home, tmp, settings, added] = await Promise.all([
    $.session.root(),
    $.session.cwd(),
    homeOf($),
    tmpOf($),
    $.settings.read().catch(() => ({})),
    read($, addedRoots),
  ])
  const permissions = (settings as { permissions?: { additionalDirectories?: unknown } }).permissions
  const additional = Array.isArray(permissions?.additionalDirectories)
    ? permissions.additionalDirectories.filter((dir): dir is string => typeof dir === 'string')
    : []
  const candidates = [root, ...extraRoots, ...additional, ...added]
  const resolved = await Promise.all(candidates.map(path => resolveRoot($, path, home)))
  const roots = [...new Set(resolved.filter((path): path is string => path !== undefined))]
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  return { roots, sep, cwd, home, tmp }
}

/**
 * Claude Code's own folders that plan mode and auto memory write with Write and Edit: `<config>/plans`
 * and `<config>/projects/<project>/memory` (config: CLAUDE_CONFIG_DIR, else ~/.claude), plus a custom
 * `autoMemoryDirectory` from settings. Each is the real path of its folder; missing ones are left out.
 */
const claudeFolders = async ($: EngineInterface, jail: Jail): Promise<{ plans?: string; projects?: string; memory?: string }> => {
  const [configured, settings] = await Promise.all([
    $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined),
    $.settings.read().catch(() => ({})),
  ])
  const dir = configured !== undefined && configured !== '' ? configured : jail.home === undefined ? undefined : `${jail.home}${jail.sep}.claude`
  const config = dir === undefined ? undefined : await resolveRoot($, dir, jail.home)
  const custom = (settings as { autoMemoryDirectory?: unknown }).autoMemoryDirectory
  const memory = typeof custom === 'string' && custom !== '' ? await resolveRoot($, custom, jail.home) : undefined
  return {
    ...(config === undefined ? {} : { plans: `${config}${jail.sep}plans`, projects: `${config}${jail.sep}projects` }),
    ...(memory === undefined ? {} : { memory }),
  }
}

/** Whether a real path is a plan file or an auto-memory file of Claude Code itself. */
const isClaudeFile = (real: string, folders: { plans?: string; projects?: string; memory?: string }, sep: string): boolean => {
  if (folders.plans !== undefined && isInside(real, folders.plans, sep)) return true
  if (folders.memory !== undefined && isInside(real, folders.memory, sep)) return true
  if (folders.projects === undefined || !isInside(real, folders.projects, sep)) return false
  const [project, folder] = splitPath(real.slice(folders.projects.length)).filter(part => part !== '')
  return project !== undefined && folder === 'memory'
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

/** Says hello to mods-hub when it is installed. */
async function greetHub($: EngineInterface): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: ['risk.blocked'], consumes: [] })
}

/** What a deny tells mods-hub: `rule` is `outside-jail` or `unverifiable-write`. */
type Block = { rule: string; severity: 'medium' | 'high'; reason: string; tool: string; path: string; command?: string }

/** Tells mods-hub (when installed) what was blocked, path and command masked and cut short. The deny never waits on it. */
async function reportBlock($: EngineInterface, block: Block): Promise<void> {
  await hubPublish($, {
    topic: 'risk.blocked',
    data: {
      guard: PLUGIN,
      tool: block.tool,
      reason: `${block.rule}: ${block.reason}`,
      severity: block.severity,
      path: redactSummary(block.path),
      ...(block.command === undefined ? {} : { command: redactSummary(block.command) }),
    },
  })
}

export const register: Register = (on, options) => {
  const extraRoots = listOption(options.allowedRoots)
  const isStrict = options.blockUncheckable !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'jail', description: 'path-jail: list the folders writes are allowed in' })
    await greetHub($)
    return next(e)
  })

  on('command.run', { command: 'jail' }, async $ => {
    const jail = await loadJail($, extraRoots)
    const folders = await claudeFolders($, jail)
    const lines = jail.roots.map((root, index) => `  ${index === 0 ? '●' : '○'} ${root}`)
    const own = [folders.plans, folders.memory, folders.projects === undefined ? undefined : `${folders.projects}${jail.sep}*${jail.sep}memory`]
      .filter((path): path is string => path !== undefined)
      .map(path => `  ◦ ${path} (Claude Code's plans and memory)`)
    return { text: `Writes are allowed under\n${[...lines, ...own].join('\n')}` }
  })

  on('classic.DirectoryAdded', async ($, e, next) => {
    await update($, addedRoots, (list: string[]) => (list.includes(e.directory) ? list : [...list, e.directory]))
    return next(e)
  })

  on('tool.call', { tool: GUARDED_TOOLS }, async ($, e, next) => {
    const targets = targetsOf(e)
    if (targets.length === 0) return next(e)

    const jail = await loadJail($, extraRoots)
    const folders = await claudeFolders($, jail)
    const tool = String(e.tool)
    const command = 'command' in e && typeof e.command === 'string' ? e.command : undefined
    for (const target of targets) {
      const placed = await placeTarget($, target, jail)
      if ('problem' in placed) {
        if (!isStrict && tool === 'Bash') continue
        await reportBlock($, { rule: 'unverifiable-write', severity: 'medium', reason: `${target.via}: ${placed.problem}`, tool, path: target.path, command })
        return { deny: `${PLUGIN}: blocked ${target.via} on "${target.path}": ${placed.problem}. Use a literal path inside the project.` }
      }
      if (!jail.roots.some(root => isInside(placed.real, root, jail.sep)) && !isClaudeFile(placed.real, folders, jail.sep)) {
        await reportBlock($, { rule: 'outside-jail', severity: 'high', reason: `${target.via} resolves to ${placed.real}, outside the allowed folders`, tool, path: target.path, command })
        return {
          deny:
            `${PLUGIN}: blocked ${target.via} on "${target.path}": it resolves to ${placed.real}, outside the allowed folders ` +
            `(${jail.roots.join(', ')}). Ask the user before writing elsewhere.`,
        }
      }
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${PLUGIN}: could not verify where this writes, so it was blocked.` }))
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
