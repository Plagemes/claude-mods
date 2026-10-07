import type { EngineInterface, Register } from 'claude-code'

import { describe, formatSize, heavyKind, kindOf, limitsFrom } from './assets'
import type { Heavy, Limits } from './assets'
import { additionsOf } from './commands'
import type { Additions } from './commands'

const DEFAULT_DIRECTORIES = 'public,assets,static,src,images,img,media,fonts'
const GIT_TIMEOUT_MS = 5_000
/** A file this much older than the command's start was not written by it. */
const FRESH_SLACK_MS = 2_000
const MAX_LISTED = 5
const TOAST_MS = 8_000
/** Commands that can put a file on the disk; anything else is not parsed. */
const MAY_ADD_FILES = /\b(?:cp|mv|install|curl|wget|git)\b|>/

type Settings = { limits: Limits; directories: ReadonlySet<string> }

const readSettings = (options: Record<string, unknown>): Settings => ({
  limits: limitsFrom(options),
  directories: new Set(String(options.directories ?? DEFAULT_DIRECTORIES).split(',').map(name => name.trim().replace(/^\/+|\/+$/g, '')).filter(name => name !== '')),
})

const relativeTo = (root: string, path: string): string => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path)

/** True for a path inside the project that has one of the asset folders among its directories. */
const isInAssetFolder = (root: string, path: string, settings: Settings): boolean =>
  path.startsWith(`${root}/`) && relativeTo(root, path).split('/').slice(0, -1).some(part => settings.directories.has(part))

/** The file as a Heavy when it exists and is over its limit; `seen` keeps one warning per file and size. */
async function inspect($: EngineInterface, path: string, settings: Settings, seen: Set<string>): Promise<Heavy | undefined> {
  if (kindOf(path) === undefined) return undefined
  try {
    const stat = await $.fs.stat(path)
    const kind = stat.kind === 'file' ? heavyKind(path, stat.size, settings.limits) : undefined
    if (kind === undefined || seen.has(`${path}:${stat.size}`)) return undefined
    seen.add(`${path}:${stat.size}`)
    return { path, size: stat.size, kind }
  } catch {
    return undefined
  }
}

async function freshAssets($: EngineInterface, folder: string, startedAt: number): Promise<string[]> {
  try {
    const entries = await $.fs.list(folder)
    return entries.filter(entry => entry.kind === 'file' && entry.mtimeMs >= startedAt - FRESH_SLACK_MS).map(entry => `${folder}/${entry.name}`)
  } catch {
    return []
  }
}

/** Files that are newly staged or modified in the index, as absolute paths. */
async function stagedAssets($: EngineInterface, root: string): Promise<string[]> {
  try {
    const out = await $.process.run(['git', 'diff', '--cached', '--name-only', '--diff-filter=AM', '-z'], { cwd: root, timeoutMs: GIT_TIMEOUT_MS })
    return out.exitCode === 0 ? out.stdout.split('\0').filter(name => name !== '').map(name => `${root}/${name}`) : []
  } catch {
    return []
  }
}

/** Shows the toast and returns the note for Claude. */
function announce($: EngineInterface, heavy: readonly Heavy[], settings: Settings, root: string): string {
  const shown = heavy.slice(0, MAX_LISTED)
  const name = (item: Heavy): string => relativeTo(root, item.path)
  const first = heavy[0]
  $.ui.toast(
    heavy.length === 1 && first !== undefined
      ? `${name(first)} is ${formatSize(first.size)}, over the ${formatSize(settings.limits[first.kind])} ${first.kind} limit`
      : `${heavy.length} heavy assets added: ${shown.map(item => `${name(item)} ${formatSize(item.size)}`).join(', ')}`,
    { timeoutMs: TOAST_MS },
  )
  return [
    `heavy-asset-warn: ${heavy.length === 1 ? 'a heavy asset was' : `${heavy.length} heavy assets were`} added to the project.`,
    ...shown.map(item => `- ${describe(item, settings.limits, name(item))}`),
    ...(heavy.length > shown.length ? [`- and ${heavy.length - shown.length} more`] : []),
    'Tell the user, and compress or convert before committing unless the size is intended.',
  ].join('\n')
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)
  // A file warned about once is not warned about again at its size, however often it is copied or staged.
  const seen = new Set<string>()

  on('tool.call', { tool: ['Write', 'Bash'] }, async ($, e, next) => {
    // Cheap checks first: most Bash calls and Writes have nothing to do with assets.
    if (e._host !== undefined || (e.tool === 'Write' ? kindOf(e.file_path) === undefined : !MAY_ADD_FILES.test(e.command) || e.run_in_background === true)) return next(e)

    const cwd = (await $.session.cwd()).replace(/\/+$/, '')
    const additions: Additions = e.tool === 'Write' ? { files: [e.file_path], folders: [], isGitAdd: false } : additionsOf(e.command, cwd)
    if (additions.files.length === 0 && additions.folders.length === 0 && !additions.isGitAdd) return next(e)

    const startedAt = await $.clock.now()
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    const root = ((await $.session.repo())?.root ?? cwd).replace(/\/+$/, '')
    const isWrite = e.tool === 'Write'
    const paths = new Set(additions.files.filter(path => kindOf(path) !== undefined && (isWrite || isInAssetFolder(root, path, settings))))
    for (const folder of additions.folders) {
      for (const path of await freshAssets($, folder, startedAt)) if (kindOf(path) !== undefined && isInAssetFolder(root, path, settings)) paths.add(path)
    }
    if (additions.isGitAdd) for (const path of await stagedAssets($, root)) paths.add(path)

    const heavy: Heavy[] = []
    for (const path of paths) {
      const item = await inspect($, path, settings, seen)
      if (item !== undefined) heavy.push(item)
    }
    return heavy.length === 0 ? ran : { ...ran, context: [...(ran.context ?? []), announce($, heavy, settings, root)] }
  }).catch(($, e, next) => next(e))
}
