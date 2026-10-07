import type { EngineInterface, FsEntry, Register } from 'claude-code'

import { KB, biggestChanges, bundleFiles, formatDelta, formatSize, isBuildCommand, isCompressible, largest, leadingCd, snapshotOf, totalOf } from './sizes'
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
    $.ui.toast(
      `bundle grew ${formatDelta(delta)} (+${percent.toFixed(1)}%) to ${formatSize(current.total)}` +
        (gzip === undefined ? '' : ` (≈ ${formatSize(gzip)} gzipped, largest files)`) +
        (changes.length === 0 ? '' : `. Biggest changes: ${changes.join(', ')}`),
      { timeoutMs: TOAST_MS },
    )
  } catch {
    // Measuring is a courtesy: a failure must never reach the session.
  }
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!isBuildCommand(e.command) || e.run_in_background === true) return next(e)

    const startedAt = await $.clock.now()
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) $.clock.after(0, () => void measure($, e.command, startedAt, settings))
    return ran
  }).catch(($, e, next) => next(e))
}
