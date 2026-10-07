import type { EngineInterface, Register, ToolCallInput, ToolCallResult } from 'claude-code'

import { pickFormatter } from './formatters'
import type { Formatter } from './formatters'
import { basename, dirname, isAbsolute, isNotInstalled, join, shorten } from './project'
import type { Level, Project } from './project'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
const SKIPPED_PATH = /(^|[\\/])(node_modules|\.git)[\\/]/
const MAX_LEVELS = 40
const DEFAULT_TIMEOUT_SECONDS = 20
const MAX_TIMEOUT_SECONDS = 600
const MAX_REASON_LENGTH = 160

type Settings = { disabled: ReadonlySet<string>; timeoutMs: number }

type Outcome =
  | { kind: 'formatted'; formatter: string }
  | { kind: 'skipped' }
  | { kind: 'missing'; formatter: string }
  | { kind: 'failed'; formatter: string; reason: string }

/** Executables that would not start; not tried again this session. */
const missing = new Set<string>()
let formattedCount = 0

export const register: Register = (on, options) => {
  const timeoutSeconds = Math.min(
    Number(options.timeoutSeconds) > 0 ? Number(options.timeoutSeconds) : DEFAULT_TIMEOUT_SECONDS,
    MAX_TIMEOUT_SECONDS,
  )
  const settings: Settings = {
    disabled: new Set(
      String(options.disabled ?? '')
        .split(/[\s,]+/)
        .map(name => name.trim().toLowerCase())
        .filter(Boolean),
    ),
    timeoutMs: timeoutSeconds * 1000,
  }

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const target = editedFile(e, ran)
    if (target === undefined) return ran

    const root = await $.session.cwd().catch(() => undefined)
    const file = isAbsolute(target) || root === undefined ? target : join(root, target)
    if (SKIPPED_PATH.test(file)) return ran

    const outcome = await formatFile($, file, settings).catch((): Outcome => ({ kind: 'skipped' }))
    const shown = shorten(file, root)

    switch (outcome.kind) {
      case 'skipped':
        return ran
      case 'missing':
        $.ui.toast(`${outcome.formatter} is not installed, so ${basename(file)} was left as written`)
        return ran
      case 'failed':
        $.ui.status(`✗ auto-format: ${outcome.formatter} could not format ${basename(file)}`)
        return withContext(
          ran,
          `auto-format: ${outcome.formatter} could not format ${shown} (${outcome.reason}). The file is exactly as you wrote it; this usually points at a syntax error.`,
        )
      case 'formatted':
        formattedCount += 1
        $.ui.status(
          `✎ auto-format: ${formattedCount} ${formattedCount === 1 ? 'file' : 'files'} formatted · last ${basename(file)} (${outcome.formatter})`,
        )
        return withContext(
          ran,
          `auto-format: ${outcome.formatter} reformatted ${shown} after your edit, so its contents on disk differ from what you wrote. Read it again before your next edit to it, and follow the project's formatting.`,
        )
    }
  })
}

/** Picks the project's formatter for `file`, runs it, and says what became of the file. */
const formatFile = async ($: EngineInterface, file: string, settings: Settings): Promise<Outcome> => {
  const project = await scanProject($, file)
  const formatter = await pickFormatter(file, project, settings.disabled)
  if (formatter === undefined) return { kind: 'skipped' }

  const executable = await resolveExecutable($, project, formatter)
  if (missing.has(executable)) return { kind: 'skipped' }

  const before = await $.fs.read(file).catch(() => undefined)
  if (before === undefined) return { kind: 'skipped' }

  const argv = [executable, ...(await formatter.args(file, project))]
  const cwd = formatter.configDir(project) ?? dirname(file)
  let run
  try {
    run = await $.process.run(argv, { cwd, timeoutMs: settings.timeoutMs })
  } catch (error) {
    if (!isNotInstalled(error)) {
      return { kind: 'failed', formatter: formatter.name, reason: `stopped after ${settings.timeoutMs / 1000}s` }
    }
    missing.add(executable)
    return { kind: 'missing', formatter: formatter.name }
  }
  if (run.exitCode !== 0) {
    const firstLine = `${run.stderr}\n${run.stdout}`.trim().split('\n')[0]?.trim() ?? ''
    const reason = firstLine === '' ? `exit code ${run.exitCode}` : firstLine.slice(0, MAX_REASON_LENGTH)
    return { kind: 'failed', formatter: formatter.name, reason }
  }

  const after = await $.fs.read(file).catch(() => undefined)
  return after === undefined || after === before ? { kind: 'skipped' } : { kind: 'formatted', formatter: formatter.name }
}

/**
 * Lists the file's directory and each parent, stopping at the first one that
 * holds `.git` (the repository root) or at the filesystem root.
 */
const scanProject = async ($: EngineInterface, file: string): Promise<Project> => {
  const levels: Level[] = []
  let dir = dirname(file)
  for (let depth = 0; depth < MAX_LEVELS; depth += 1) {
    const entries = await $.fs.list(dir).catch(() => [])
    const names = new Set(entries.map(entry => entry.name))
    levels.push({ dir, names })
    const parent = dirname(dir)
    if (names.has('.git') || parent === dir) break
    dir = parent
  }

  return {
    levels,
    find: (...names) => levels.find(level => names.some(name => level.names.has(name)))?.dir,
    readAll: async name => {
      const found: { dir: string; text: string }[] = []
      for (const level of levels) {
        if (!level.names.has(name)) continue
        const text = await $.fs.read(join(level.dir, name)).catch(() => undefined)
        if (text !== undefined) found.push({ dir: level.dir, text })
      }
      return found
    },
  }
}

/**
 * The nearest local install of the formatter (`node_modules/.bin`, a venv,
 * `vendor/bin`); the bare name otherwise, which the host finds on PATH.
 */
const resolveExecutable = async ($: EngineInterface, project: Project, formatter: Formatter): Promise<string> => {
  for (const level of project.levels) {
    for (const folder of formatter.localFolders) {
      if (!level.names.has(folder.split('/')[0] ?? folder)) continue
      const candidate = join(join(level.dir, folder), formatter.bin)
      if (await $.fs.exists(candidate).catch(() => false)) return candidate
    }
  }
  return formatter.bin
}

/** The file a successful Edit, Write or MultiEdit changed; undefined otherwise. */
const editedFile = (e: ToolCallInput, ran: ToolCallResult): string | undefined => {
  if (!EDIT_TOOLS.has(String(e.tool)) || ran.deny !== undefined || ran.isError === true) return undefined
  const result: unknown = ran.result
  const isStaged = typeof result === 'object' && result !== null && 'staged' in result && result.staged === true
  if (isStaged) return undefined
  const path = 'file_path' in e ? e.file_path : undefined
  return typeof path === 'string' && path !== '' ? path : undefined
}

/** The tool's result with one more note for the model to read after it. */
const withContext = (ran: ToolCallResult, note: string): ToolCallResult =>
  ran.deny !== undefined ? ran : { ...ran, context: [...(ran.context ?? []), note] }
