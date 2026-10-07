import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { writeTargets } from './bash'

type Target = { path: string; via: string; cdChain: readonly string[] }
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
const expand = (path: string, jail: Jail, cwd: string): string | undefined => {
  let result = path
  if (result === '~' || result.startsWith('~/')) {
    if (jail.home === undefined) return undefined
    result = jail.home + result.slice(1)
  }
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
  const expanded = expand(target.path, jail, cwd)
  if (expanded === undefined) return { problem: 'it uses a shell expansion the jail cannot check' }
  const literal = withoutGlob(expanded)
  if (literal === undefined) return { problem: 'it climbs out of a glob with `..`' }
  return placeAbsolute($, isAbsolute(literal) ? literal : `${cwd}${jail.sep}${literal}`, jail.sep)
}

const targetsOf = (e: { tool: string; [field: string]: unknown }): Target[] => {
  const tool = String(e.tool)
  const field = tool === 'NotebookEdit' ? e.notebook_path : tool === 'Bash' ? undefined : e.file_path
  if (typeof field === 'string') return [{ path: field, via: tool, cdChain: [] }]
  if (tool === 'Bash' && typeof e.command === 'string') return writeTargets(e.command)
  return []
}

const resolveRoot = async ($: EngineInterface, path: string, home: string | undefined): Promise<string | undefined> => {
  const expanded = path === '~' || path.startsWith('~/') ? (home === undefined ? undefined : home + path.slice(1)) : path
  if (expanded === undefined) return undefined
  const stat = await $.fs.stat(expanded, { resolve: true }).catch(() => undefined)
  return stat?.kind === 'dir' ? stat.realPath : undefined
}

/** The project root and every allowed folder, each resolved the way targets are. */
const loadJail = async ($: EngineInterface, extraRoots: readonly string[]): Promise<Jail> => {
  const [root, cwd, home, tmp, settings, added] = await Promise.all([
    $.session.root(),
    $.session.cwd(),
    $.env.get('HOME'),
    $.env.get('TMPDIR'),
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

export const register: Register = (on, options) => {
  const extraRoots = listOption(options.allowedRoots)
  const isStrict = options.blockUncheckable !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'jail', description: 'path-jail: list the folders writes are allowed in' })
    return next(e)
  })

  on('command.run', { command: 'jail' }, async $ => {
    const jail = await loadJail($, extraRoots)
    const lines = jail.roots.map((root, index) => `  ${index === 0 ? '●' : '○'} ${root}`)
    return { text: `path-jail: writes are allowed under\n${lines.join('\n')}` }
  })

  on('classic.DirectoryAdded', async ($, e, next) => {
    await update($, addedRoots, (list: string[]) => (list.includes(e.directory) ? list : [...list, e.directory]))
    return next(e)
  })

  on('tool.call', { tool: GUARDED_TOOLS }, async ($, e, next) => {
    const targets = targetsOf(e)
    if (targets.length === 0) return next(e)

    const jail = await loadJail($, extraRoots)
    for (const target of targets) {
      const placed = await placeTarget($, target, jail)
      if ('problem' in placed) {
        if (!isStrict && String(e.tool) === 'Bash') continue
        return { deny: `${PLUGIN}: blocked ${target.via} on "${target.path}": ${placed.problem}. Use a literal path inside the project.` }
      }
      if (!jail.roots.some(root => isInside(placed.real, root, jail.sep))) {
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
