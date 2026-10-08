import type { EngineInterface, Register, ToolCallInput, ToolCallResult } from 'claude-code'

import { pickLinter } from './linters'
import type { Linter, Problem } from './linters'
import { basename, dirname, isAbsolute, isNotInstalled, join, shorten } from './project'
import type { Level, Project } from './project'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
const SKIPPED_PATH = /(^|[\\/])(node_modules|\.git|vendor|target)[\\/]/
const MAX_LEVELS = 40
const MAX_LISTED = 30
const DEFAULT_TIMEOUT_SECONDS = 60
const MAX_TIMEOUT_SECONDS = 600

type Settings = { disabled: ReadonlySet<string>; includeWarnings: boolean; timeoutMs: number }

type Outcome =
  | { kind: 'skipped' }
  | { kind: 'missing'; linter: string }
  | { kind: 'failed'; linter: string; reason: string }
  | { kind: 'linted'; linter: string; problems: Problem[] }

/** Problems still standing per file, as each file's latest lint found them. */
const standing = new Map<string, number>()
/** Executables that would not start; not tried again this session. */
const missing = new Set<string>()

// ── mods-hub: lint results on the bus, a missing linter as a warning ────────────────────────────────

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
const ownVersion = async ($: EngineInterface): Promise<string> => {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Says hello to mods-hub when it is installed. */
const greetHub = async ($: EngineInterface): Promise<void> => {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: ['lint.result'], consumes: [] })
}

/** One file's lint on the hub's bus as `lint.result` (every problem the linter found, warnings included). */
const publishLint = async ($: EngineInterface, linter: string, file: string, problems: readonly Problem[]): Promise<void> => {
  const errors = problems.filter(problem => problem.severity === 'error').length
  await hubPublish($, { topic: 'lint.result', data: { tool: linter, errors, warnings: problems.length - errors, files: [file] } })
}

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
    includeWarnings: options.includeWarnings === true,
    timeoutMs: timeoutSeconds * 1000,
  }

  on('session.start', async ($, e, next) => {
    afterStart($, 'lint-on-save', () => greetHub($))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const target = editedFile(e, ran)
    if (target === undefined) return ran

    const root = await $.session.cwd().catch(() => undefined)
    const file = isAbsolute(target) || root === undefined ? target : join(root, target)
    if (SKIPPED_PATH.test(file)) return ran

    const outcome = await lintFile($, file, settings).catch((): Outcome => ({ kind: 'skipped' }))
    switch (outcome.kind) {
      case 'skipped':
        return ran
      case 'missing':
        await hubNotify($, { level: 'warning', title: `${outcome.linter} is not installed, so ${basename(file)} was not linted`, topic: 'lint.result' })
        return ran
      case 'failed':
        $.ui.status(`✗ lint: ${outcome.linter} failed on ${basename(file)}: ${outcome.reason}`)
        return ran
      case 'linted': {
        const reported = settings.includeWarnings
          ? outcome.problems
          : outcome.problems.filter(problem => problem.severity === 'error')
        if (reported.length === 0) standing.delete(file)
        else standing.set(file, reported.length)
        showStanding($)
        await publishLint($, outcome.linter, shorten(file, root), outcome.problems)
        return reported.length === 0
          ? ran
          : withContext(ran, describe(outcome.linter, shorten(file, root), reported))
      }
    }
  })

  on('session.end', ($, e, next) => {
    standing.clear()
    $.ui.status(undefined)
    return next(e)
  })
}

/** Picks the project's linter for `file`, runs it, and reads what it found. */
const lintFile = async ($: EngineInterface, file: string, settings: Settings): Promise<Outcome> => {
  const project = await scanProject($, file)
  const linter = await pickLinter(file, project, settings.disabled)
  if (linter === undefined) return { kind: 'skipped' }

  const executable = await resolveExecutable($, project, linter)
  if (missing.has(executable)) return { kind: 'skipped' }

  const cwd = linter.cwd(project, file)
  let run
  try {
    run = await $.process.run([executable, ...linter.args(file, cwd)], {
      cwd,
      timeoutMs: settings.timeoutMs,
      env: { NO_COLOR: '1', FORCE_COLOR: '0' },
    })
  } catch (error) {
    if (!isNotInstalled(error)) {
      return { kind: 'failed', linter: linter.name, reason: `stopped after ${settings.timeoutMs / 1000}s` }
    }
    missing.add(executable)
    return { kind: 'missing', linter: linter.name }
  }

  const verdict = linter.parse(run, file, cwd)
  if ('failure' in verdict) return { kind: 'failed', linter: linter.name, reason: verdict.failure }
  return { kind: 'linted', linter: linter.name, problems: verdict.problems }
}

/** Shows how many problems stand across the files linted so far. */
const showStanding = ($: EngineInterface): void => {
  const total = [...standing.values()].reduce((sum, count) => sum + count, 0)
  $.ui.status(
    total === 0
      ? '✓ lint: clean'
      : `⚠ lint: ${total} ${total === 1 ? 'problem' : 'problems'} in ${standing.size} ${standing.size === 1 ? 'file' : 'files'}`,
  )
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

/** The nearest local install of the linter; the bare name otherwise, which the host finds on PATH. */
const resolveExecutable = async ($: EngineInterface, project: Project, linter: Linter): Promise<string> => {
  for (const level of project.levels) {
    for (const folder of linter.localFolders) {
      if (!level.names.has(folder.split('/')[0] ?? folder)) continue
      const candidate = join(join(level.dir, folder), linter.bin)
      if (await $.fs.exists(candidate).catch(() => false)) return candidate
    }
  }
  return linter.bin
}

/** The note Claude reads after the edit: the problems, worst first, at most MAX_LISTED. */
const describe = (linter: string, shown: string, problems: readonly Problem[]): string => {
  const errors = problems.filter(problem => problem.severity === 'error').length
  const warnings = problems.length - errors
  const counts = [
    errors > 0 ? `${errors} ${errors === 1 ? 'error' : 'errors'}` : '',
    warnings > 0 ? `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}` : '',
  ]
    .filter(Boolean)
    .join(' and ')
  const sorted = [...problems].sort((a, b) => a.line - b.line || a.column - b.column)
  const lines = sorted
    .slice(0, MAX_LISTED)
    .map(
      problem =>
        `  ${problem.line}:${problem.column}  ${problem.severity}  ${problem.message}${problem.rule === undefined ? '' : `  [${problem.rule}]`}`,
    )
  const more = sorted.length > MAX_LISTED ? [`  … and ${sorted.length - MAX_LISTED} more`] : []
  return [`lint-on-save: ${linter} reports ${counts} in ${shown}. Fix them before moving on:`, ...lines, ...more].join('\n')
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

// #region @vendored shared/hub-client.ts sha256:6b153e2e759f: edit the source, then run `node scripts/sync-shared.mjs`.
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
/**
 * Runs a mod's start-up work (the hub hello, a first scan, loading what it keeps) once `session.start` has returned,
 * after a short delay staggered by the mod's name (0.15–1.35 s), so ~200 mods sharing one hooks worker do not all wait
 * on the hub, a process or the disk inside the session.start chain (`ran past its 10s budget`). A failure is logged
 * to the debug log. Call it from `session.start` in place of `await work()`; never await the hub there
 * (scripts/check-startup.mjs).
 */
function afterStart($: EngineInterface, mod: string, work: () => Promise<unknown>): void {
  let hash = 7
  for (let i = 0; i < mod.length; i += 1) hash = (hash * 31 + mod.charCodeAt(i)) % 1_200
  $.clock.after(150 + hash, () => {
    void work().catch(error => $.ui.log(`${mod}: start-up work failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' }))
  })
}
// #endregion @vendored shared/hub-client.ts
