import type { EngineInterface, Register } from 'claude-code'

import { parsePeekArgs, resolvePath } from './args'
import { detectKind, formatReport, tableFromCsv, tableFromJsonl } from './table'

const BYTES_PER_KB = 1024
const DEFAULT_SAMPLE_KB = 64
const DEFAULT_MAX_READ_KB = 1024
const DEFAULT_ROWS = 5
const MAX_ROWS = 50
const HEAD_TIMEOUT_MS = 5_000
const COUNT_TIMEOUT_MS = 8_000
/** Without `head`, a file this small is read whole instead. */
const SMALL_FILE_BYTES = 1024 * BYTES_PER_KB
const DATA_FILE = /\.(?:csv|tsv|jsonl|ndjson)$/i
const USAGE = 'Usage: /peek <path> [rows], e.g. /peek data/orders.csv 10. Works on CSV, TSV and JSON Lines files.'

type Settings = { sampleBytes: number; maxReadBytes: number }

const kbOption = (value: unknown, fallback: number): number => (typeof value === 'number' && value >= 0 ? value : fallback) * BYTES_PER_KB

const formatSize = (bytes: number): string =>
  bytes >= BYTES_PER_KB * BYTES_PER_KB ? `${(bytes / (BYTES_PER_KB * BYTES_PER_KB)).toFixed(1)} MB` : `${Math.round(bytes / BYTES_PER_KB)} KB`

/** The start of the file as text: `head -c`, so a 4 GB file costs 64 KB; a small file is read whole where there is no head. */
async function readSample($: EngineInterface, path: string, size: number, bytes: number): Promise<string | undefined> {
  try {
    const out = await $.process.run(['head', '-c', String(bytes), path], { timeoutMs: HEAD_TIMEOUT_MS })
    if (out.exitCode === 0) return out.stdout
  } catch {
    // No head on this machine: fall through to reading the file itself.
  }
  if (size > SMALL_FILE_BYTES) return undefined
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

/** Newlines in the whole file, from `wc -l`; undefined when that takes too long or fails. */
async function countLines($: EngineInterface, path: string): Promise<number | undefined> {
  try {
    const out = await $.process.run(['wc', '-l', path], { timeoutMs: COUNT_TIMEOUT_MS })
    const count = /^\s*(\d+)/.exec(out.stdout)?.[1]
    return out.exitCode === 0 && count !== undefined ? Number(count) : undefined
  } catch {
    return undefined
  }
}

async function homeFolder($: EngineInterface): Promise<string | undefined> {
  try {
    return await $.env.get('HOME')
  } catch {
    return undefined
  }
}

async function peek($: EngineInterface, args: string, settings: Settings): Promise<string> {
  const parsed = parsePeekArgs(args)
  if (parsed === undefined) return USAGE
  const path = resolvePath(parsed.path, await $.session.cwd(), parsed.path.startsWith('~/') ? await homeFolder($) : undefined)

  let size: number
  try {
    const stat = await $.fs.stat(path)
    if (stat.kind !== 'file') return `${parsed.path} is not a file.`
    size = stat.size
  } catch {
    return `Cannot find ${parsed.path}.`
  }

  const sample = (await readSample($, path, size, settings.sampleBytes))?.replace(/^﻿/, '')
  if (sample === undefined) return `Could not read ${parsed.path}.`
  if (sample.includes('\u0000')) return `${parsed.path} does not look like a text file.`

  const isWhole = size <= settings.sampleBytes
  const rowsShown = Math.min(MAX_ROWS, Math.max(1, parsed.rows ?? DEFAULT_ROWS))
  const table = detectKind(path, sample) === 'jsonl' ? tableFromJsonl(sample, !isWhole, rowsShown) : tableFromCsv(sample, !isWhole, rowsShown)
  if (table.columns.length === 0) return `${parsed.path} has no readable rows in its first ${formatSize(settings.sampleBytes)}.`

  const lines = isWhole ? undefined : await countLines($, path)
  return formatReport(table, { name: parsed.path, bytes: size, lines, isWhole, sampleBytes: Math.min(size, settings.sampleBytes), rowsShown })
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    sampleBytes: Math.max(BYTES_PER_KB, kbOption(options.sampleKb, DEFAULT_SAMPLE_KB)),
    maxReadBytes: kbOption(options.maxReadKb, DEFAULT_MAX_READ_KB),
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'peek',
      description: "Show a CSV or JSONL file's columns, sample rows and inferred types without reading it all",
      argumentHint: '<path> [rows]',
    })
    return next(e)
  })

  on('command.run', { command: 'peek' }, async ($, e) => ({ text: await peek($, e.args, settings) }))

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    if (settings.maxReadBytes === 0 || e.limit !== undefined || e._host !== undefined || !DATA_FILE.test(e.file_path)) return next(e)

    let size: number
    try {
      const stat = await $.fs.stat(e.file_path)
      if (stat.kind !== 'file') return next(e)
      size = stat.size
    } catch {
      // Missing or unreadable: the Read tool reports that itself.
      return next(e)
    }
    if (size <= settings.maxReadBytes) return next(e)

    return {
      deny:
        `csv-peek: ${e.file_path} is ${formatSize(size)}, too big to read whole. Read a slice with offset and limit, or sample it with Bash (head -n 20, wc -l). ` +
        `The user can run /peek ${e.file_path} to see its columns, types and sample rows.`,
    }
  }).catch(($, e, next) => next(e))
}
