import type { EngineInterface, Register } from 'claude-code'

import { isAbsolutePath, matchRule, parseCodeowners, relativeTo } from './codeowners'
import type { Rule } from './codeowners'

type Cached = { mtimeMs: number; rules: Rule[] }
type State = { cache: Map<string, Cached>; lastPath?: string }
type Lookup = { location: string; rule: Rule | undefined }
type Reply = { text: string }

// The places GitHub reads CODEOWNERS from, first found wins.
const LOCATIONS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']

const repoRoot = async ($: EngineInterface): Promise<string> => (await $.session.repo())?.root ?? (await $.session.root())

// Reads and parses the CODEOWNERS file again only when its modification time changed.
const rulesFor = async ($: EngineInterface, state: State, root: string): Promise<{ location: string; rules: Rule[] } | undefined> => {
  for (const location of LOCATIONS) {
    const path = `${root.replace(/[\\/]+$/, '')}/${location}`
    if (!(await $.fs.exists(path))) continue

    const { mtimeMs } = await $.fs.stat(path)
    const cached = state.cache.get(path)
    if (cached?.mtimeMs === mtimeMs) return { location, rules: cached.rules }

    const rules = parseCodeowners(await $.fs.read(path))
    state.cache.set(path, { mtimeMs, rules })
    return { location, rules }
  }
  return undefined
}

const lookup = async ($: EngineInterface, state: State, root: string, path: string): Promise<Lookup | undefined> => {
  const found = await rulesFor($, state, root)
  return found === undefined ? undefined : { location: found.location, rule: matchRule(found.rules, path) }
}

// Shows the owners of a file Claude is about to change, or clears the line when it has none.
const showOwners = async ($: EngineInterface, state: State, file: string): Promise<void> => {
  try {
    state.lastPath = file
    const root = await repoRoot($)
    const path = relativeTo(root, file)
    const found = path === undefined ? undefined : await lookup($, state, root, path)
    const owners = found?.rule?.owners ?? []
    $.ui.status(owners.length === 0 ? undefined : `owners: ${owners.join(' ')} (${file.split(/[\\/]/).at(-1)})`)
  } catch {
    // A status line is never worth failing an edit for.
  }
}

const describeOwners = async ($: EngineInterface, state: State, args: string): Promise<Reply> => {
  const target = args.trim() === '' ? state.lastPath : args.trim()
  if (target === undefined) return { text: 'usage: /owners <path> (or edit a file first, then run /owners)' }

  const root = await repoRoot($)
  const absolute = isAbsolutePath(target) ? target : `${await $.session.cwd()}/${target}`
  const path = relativeTo(root, absolute)
  if (path === undefined) return { text: `${target} is outside the repository.` }

  const isDirectory = await $.fs.stat(absolute).then(
    stat => stat.kind === 'dir',
    () => false,
  )
  const found = await lookup($, state, root, isDirectory ? `${path}/` : path)
  if (found === undefined) {
    return { text: 'No CODEOWNERS file found (looked in .github/, the repository root and docs/).' }
  }

  const { location, rule } = found
  if (rule === undefined) return { text: `📋 ${path} has no owners: no rule in ${location} matches it.` }
  const where = `${location}:${rule.line}`
  if (rule.owners.length === 0) return { text: `📋 ${path} has no owners: the rule "${rule.pattern}" (${where}) clears them.` }
  return { text: `📋 ${path} is owned by ${rule.owners.join(' ')}\nrule: ${rule.pattern} (${where})` }
}

export const register: Register = on => {
  const state: State = { cache: new Map() }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'owners', description: 'Show who owns a file, from CODEOWNERS', argumentHint: '[path]' })
    return next(e)
  })

  // Before the edit runs, so the owners are on screen while the permission dialog is.
  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    await showOwners($, state, e.file_path)
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    $.ui.status(undefined)
    return next(e)
  })

  on('command.run', { command: 'owners' }, ($, e) => describeOwners($, state, e.args))
}
