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

/** Tells the person (a notification through mods-hub, a toast without it) and the hub's bus, and returns the note for Claude. */
async function announce($: EngineInterface, heavy: readonly Heavy[], settings: Settings, root: string, tool: string): Promise<string> {
  const shown = heavy.slice(0, MAX_LISTED)
  const name = (item: Heavy): string => relativeTo(root, item.path)
  const first = heavy[0]
  const title =
    heavy.length === 1 && first !== undefined
      ? `${name(first)} is ${formatSize(first.size)}, over the ${formatSize(settings.limits[first.kind])} ${first.kind} limit`
      : `${heavy.length} heavy assets added: ${shown.map(item => `${name(item)} ${formatSize(item.size)}`).join(', ')}`
  if ((await hubMode($)) === undefined) $.ui.toast(title, { timeoutMs: TOAST_MS })
  else await hubNotify($, { level: 'warning', title })
  for (const item of shown) {
    await hubPublish($, {
      topic: 'risk.blocked',
      data: { guard: 'heavy-asset-warn', tool, reason: `${item.kind} of ${formatSize(item.size)} is over the ${formatSize(settings.limits[item.kind])} limit`, severity: 'low', path: item.path },
    })
  }
  return [
    `heavy-asset-warn: ${heavy.length === 1 ? 'a heavy asset was' : `${heavy.length} heavy assets were`} added to the project.`,
    ...shown.map(item => `- ${describe(item, settings.limits, name(item))}`),
    ...(heavy.length > shown.length ? [`- and ${heavy.length - shown.length} more`] : []),
    'Tell the user, and compress or convert before committing unless the size is intended.',
  ].join('\n')
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

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await greetHub($)
    return next(e)
  })

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
    return heavy.length === 0 ? ran : { ...ran, context: [...(ran.context ?? []), await announce($, heavy, settings, root, e.tool)] }
  }).catch(($, e, next) => next(e))
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
