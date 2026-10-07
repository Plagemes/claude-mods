import type { EngineInterface, FsEntry, Register } from 'claude-code'

import { KB, biggestChanges, bundleFiles, buildToolOf, formatDelta, formatSize, isCompressible, largest, leadingCd, snapshotOf, totalOf } from './sizes'
import type { FileInfo, Snapshot } from './sizes'

const DEFAULT_OUTPUT_DIRS = 'dist,build,.next/static,out,.output/public'
const DEFAULT_GROWTH_PERCENT = 5
const MAX_DEPTH = 8
const MAX_FILES = 4000
const GZIP_FILES = 10
const GZIP_TIMEOUT_MS = 8_000
/** A folder whose newest file is older than the command's start was not written by it. */
const CLOCK_SLACK_MS = 2_000
const TOAST_MS = 10_000
const MIN_GROWTH_BYTES = KB

type Settings = { growthPercent: number; outputDirs: string[]; isGzipOn: boolean }

const readSettings = (options: Record<string, unknown>): Settings => ({
  growthPercent: typeof options.growthPercent === 'number' && options.growthPercent >= 0 ? options.growthPercent : DEFAULT_GROWTH_PERCENT,
  outputDirs: String(options.outputDirs ?? DEFAULT_OUTPUT_DIRS).split(',').map(dir => dir.trim().replace(/^\.?\/+|\/+$/g, '')).filter(dir => dir !== ''),
  isGzipOn: options.gzip !== false,
})

/** Every file under `dir` (relative names), to a bounded depth and count. */
async function listFiles($: EngineInterface, dir: string, prefix: string, depth: number, found: FileInfo[]): Promise<void> {
  let entries: FsEntry[]
  try {
    entries = await $.fs.list(dir)
  } catch {
    return
  }
  const folders: string[] = []
  for (const entry of entries) {
    if (entry.kind === 'file' && found.length < MAX_FILES) found.push({ path: `${prefix}${entry.name}`, size: entry.size, mtimeMs: entry.mtimeMs })
    if (entry.kind === 'dir' && depth < MAX_DEPTH) folders.push(entry.name)
  }
  for (const name of folders) await listFiles($, `${dir}/${name}`, `${prefix}${name}/`, depth + 1, found)
}

/** The output folder this build wrote to: the one holding the newest file, if that file is newer than the build's start. */
async function findOutput($: EngineInterface, base: string, settings: Settings, startedAt: number): Promise<{ dir: string; files: FileInfo[] } | undefined> {
  let best: { dir: string; files: FileInfo[]; newest: number } | undefined
  for (const dir of settings.outputDirs) {
    const files: FileInfo[] = []
    await listFiles($, `${base}/${dir}`, '', 0, files)
    const newest = Math.max(0, ...files.map(file => file.mtimeMs))
    if (files.length > 0 && (best === undefined || newest > best.newest)) best = { dir, files, newest }
  }
  return best !== undefined && best.newest >= startedAt - CLOCK_SLACK_MS ? best : undefined
}

/** Gzipped size of the largest compressible files: an estimate of what users download. */
async function gzipEstimate($: EngineInterface, base: string, dir: string, files: readonly FileInfo[]): Promise<number | undefined> {
  const sizes = await Promise.all(
    largest(files.filter(file => isCompressible(file.path)), GZIP_FILES).map(async file => {
      try {
        const out = await $.process.run(['sh', '-c', 'gzip -c "$1" | wc -c', 'sh', `${base}/${dir}/${file.path}`], { timeoutMs: GZIP_TIMEOUT_MS })
        const bytes = Number.parseInt(out.stdout.trim(), 10)
        return out.exitCode === 0 && Number.isFinite(bytes) ? bytes : undefined
      } catch {
        return undefined
      }
    }),
  )
  const known = sizes.filter((size): size is number => size !== undefined)
  return known.length === 0 ? undefined : known.reduce((sum, size) => sum + size, 0)
}

async function measure($: EngineInterface, command: string, startedAt: number, settings: Settings): Promise<void> {
  try {
    const cwd = (await $.session.cwd()).replace(/\/+$/, '')
    const project = (await $.session.repo())?.root ?? cwd
    const cd = leadingCd(command)
    const base = cd === undefined ? cwd : cd.startsWith('/') ? cd.replace(/\/+$/, '') : `${cwd}/${cd.replace(/^\.\//, '')}`.replace(/\/+$/, '')

    const output = await findOutput($, base, settings, startedAt)
    if (output === undefined) return
    const files = bundleFiles(output.files)
    const current = snapshotOf(files, output.dir, startedAt)

    const key = `last:${project}:${output.dir}`
    const previous = (await $.store.get(key)) as Snapshot | undefined
    await $.store.set(key, current)

    const delta = previous === undefined ? undefined : current.total - previous.total
    $.ui.status(`📦 ${formatSize(current.total)}${delta === undefined ? '' : ` (${formatDelta(delta)})`}`)

    if (previous === undefined || delta === undefined || delta < MIN_GROWTH_BYTES || previous.total === 0) return
    const percent = (delta / previous.total) * 100
    if (percent <= settings.growthPercent) return

    const gzip = settings.isGzipOn ? await gzipEstimate($, base, output.dir, files) : undefined
    const changes = biggestChanges(previous, current)
    // A warning through the hub (your phone channel while you are away); the same toast, for the same time, without it.
    await hubNotify(
      $,
      {
        level: 'warning',
        title:
          `bundle grew ${formatDelta(delta)} (+${percent.toFixed(1)}%) to ${formatSize(current.total)}` +
          (gzip === undefined ? '' : ` (≈ ${formatSize(gzip)} gzipped, largest files)`) +
          (changes.length === 0 ? '' : `. Biggest changes: ${changes.join(', ')}`),
      },
      { timeoutMs: TOAST_MS },
    )
  } catch {
    // Measuring is a courtesy: a failure must never reach the session.
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

/** Says hello to mods-hub when it is installed. */
async function greetHub($: EngineInterface): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: ['build.result'], consumes: [] })
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    await greetHub($)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const tool = buildToolOf(e.command)
    if (tool === undefined || e.run_in_background === true) return next(e)

    const startedAt = await $.clock.now()
    const ran = await next(e)
    if (ran.deny === undefined) {
      // The build's verdict on the hub's bus (autopilot, screenshot-check); nothing without the hub.
      await hubPublish($, { topic: 'build.result', data: { tool, outcome: ran.isError === true ? 'failed' : 'passed', durationMs: Math.max(0, (await $.clock.now()) - startedAt), command: e.command.slice(0, 200) } })
    }
    if (ran.deny === undefined && ran.isError !== true) $.clock.after(0, () => void measure($, e.command, startedAt, settings))
    return ran
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
