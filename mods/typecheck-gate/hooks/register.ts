import type { EngineInterface, Register, ToolCallInput, ToolCallResult } from 'claude-code'

import { PY_EXTENSIONS, TS_EXTENSIONS, listFindings, parseMypy, parsePyright, parseTsc } from './checkers'
import type { CheckResult, Checker, Finding } from './checkers'
import { dirname, extension, isAbsolute, isNotInstalled, join, referencedConfigs, relativeTo } from './project'
import type { Level, Project } from './project'

const COMMAND = 'typecheck'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
const MAX_LEVELS = 40
const MAX_LISTED = 20
const DEFAULT_TIMEOUT_SECONDS = 180
const MAX_TIMEOUT_SECONDS = 600
const DEFAULT_MAX_ROUNDS = 3
const TSCONFIG = 'tsconfig.json'
const PYRIGHT_CONFIG = 'pyrightconfig.json'
const MYPY_CONFIGS = ['mypy.ini', '.mypy.ini']
const NODE_BIN = ['node_modules/.bin']
const PYTHON_BIN = ['.venv/bin', 'venv/bin']

type Mode = 'notify' | 'autofix'

type Settings = { mode: Mode; maxRounds: number; timeoutMs: number }

/** One checker run: which checker, where, and its whole argv. */
type Job = { checker: Checker; cwd: string; argv: string[] }

/** Type-checkable files edited since the last check. */
const edited = new Set<string>()
/** Every type-checkable file edited this session, for /typecheck. */
const touched = new Set<string>()
/** Fix-up prompts sent since the person last typed one. */
let autofixRounds = 0
/** The errors of the last check, handed to Claude with the next prompt. */
let pendingNote: string | undefined
let isChecking = false

export const register: Register = (on, options) => {
  const settings: Settings = {
    mode: options.mode === 'autofix' ? 'autofix' : 'notify',
    maxRounds: Number(options.maxAutofixRounds) >= 0 ? Number(options.maxAutofixRounds) : DEFAULT_MAX_ROUNDS,
    timeoutMs:
      Math.min(Number(options.timeoutSeconds) > 0 ? Number(options.timeoutSeconds) : DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS) *
      1000,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Type-check the files edited this session now (tsc, pyright or mypy)' })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const target = editedFile(e, ran)
    if (target === undefined) return ran
    const ext = extension(target)
    if (!TS_EXTENSIONS.has(ext) && !PY_EXTENSIONS.has(ext)) return ran

    const file = isAbsolute(target) ? target : join(await $.session.cwd().catch(() => '/'), target)
    edited.add(file)
    touched.add(file)
    return ran
  })

  on('prompt.submit', ($, e, next) => {
    if (e.origin.kind !== 'plugin') autofixRounds = 0
    if (pendingNote === undefined) return next(e)
    const note = pendingNote
    pendingNote = undefined
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer' || edited.size === 0 || isChecking) return done

    const files = [...edited]
    edited.clear()
    void gate($, files, settings)
    return done
  })

  on('command.run', { command: COMMAND }, async $ => {
    const root = await $.session.cwd().catch(() => '/')
    let jobs = await planJobs($, [...touched])
    if (jobs.length === 0 && (await $.fs.exists(join(root, TSCONFIG)).catch(() => false))) {
      jobs = await tscJobs($, await scanProject($, join(root, TSCONFIG)), root)
    }
    if (jobs.length === 0) {
      return { text: 'typecheck-gate: nothing to check (no tsconfig.json, and no pyright or mypy config for the files edited so far).' }
    }

    const results = await runJobs($, jobs, settings)
    const findings = findingsOf(results)
    showVerdict($, results)
    if (findings.length === 0) return { text: `typecheck-gate: ✓ no type errors (${checkersOf(results)}).` }
    return {
      text: [
        `typecheck-gate: ${checkersOf(results)} reports ${countOf(findings)}:`,
        ...listFindings(findings, MAX_LISTED, file => relativeTo(root, file)),
      ].join('\n'),
    }
  })
}

/**
 * Checks the files a turn edited. On errors it asks Claude to fix them in a turn
 * of its own (autofix), or keeps a note Claude reads with the next prompt (notify).
 */
const gate = async ($: EngineInterface, files: readonly string[], settings: Settings): Promise<void> => {
  isChecking = true
  try {
    const jobs = await planJobs($, files)
    if (jobs.length === 0) return
    const results = await runJobs($, jobs, settings)
    showVerdict($, results)

    const findings = findingsOf(results)
    pendingNote = undefined
    if (findings.length === 0) {
      autofixRounds = 0
      return
    }

    const root = await $.session.cwd().catch(() => '/')
    const list = listFindings(findings, MAX_LISTED, file => relativeTo(root, file)).join('\n')
    const what = `${checkersOf(results)} reports ${countOf(findings)} after your last turn`

    if (settings.mode === 'autofix' && autofixRounds < settings.maxRounds) {
      autofixRounds += 1
      $.ui.toast(`typecheck-gate: ${countOf(findings)}, asking Claude to fix them (round ${autofixRounds} of ${settings.maxRounds})`)
      await $.prompt
        .submit({ text: `typecheck-gate: ${what}. Fix them, then type-check again to confirm:\n${list}` })
        .catch(() => $.ui.toast('typecheck-gate: could not ask Claude to fix the type errors'))
      return
    }

    $.ui.toast(
      settings.mode === 'autofix'
        ? `typecheck-gate: ${countOf(findings)} still stand after ${settings.maxRounds} fix rounds; over to you`
        : `typecheck-gate: ${countOf(findings)} (${checkersOf(results)})`,
    )
    pendingNote = `typecheck-gate: ${what}. Fix them before moving on, unless the user says otherwise:\n${list}`
  } catch {
    $.ui.status('✗ typecheck: the check could not run')
  } finally {
    isChecking = false
  }
}

/** One job per tsconfig project, and one per configured Python checker holding its edited files. */
const planJobs = async ($: EngineInterface, files: readonly string[]): Promise<Job[]> => {
  const jobs = new Map<string, Job>()
  for (const file of files) {
    const ext = extension(file)
    const project = await scanProject($, file)
    if (TS_EXTENSIONS.has(ext)) {
      const dir = project.find(TSCONFIG)
      if (dir !== undefined && !jobs.has(`tsc:${dir}`)) {
        for (const [index, job] of (await tscJobs($, project, dir)).entries()) jobs.set(index === 0 ? `tsc:${dir}` : `tsc:${dir}:${index}`, job)
      }
    } else if (PY_EXTENSIONS.has(ext)) {
      const choice = await pythonChecker(project)
      if (choice === undefined) continue
      const key = `${choice.checker}:${choice.cwd}`
      const job = jobs.get(key) ?? (await pythonJob($, project, choice.checker, choice.cwd))
      job.argv.push(file)
      jobs.set(key, job)
    }
  }
  return [...jobs.values()]
}

/** One `tsc --noEmit` per project: the tsconfig in `dir`, or each project a solution-style tsconfig references (Vite's layout). */
const tscJobs = async ($: EngineInterface, project: Project, dir: string): Promise<Job[]> => {
  const tsc = await resolveExecutable($, project, 'tsc', NODE_BIN)
  const text = await $.fs.read(join(dir, TSCONFIG)).catch(() => undefined)
  const configs = (text === undefined ? undefined : referencedConfigs(text, dir)) ?? [join(dir, TSCONFIG)]
  return configs.map(config => ({ checker: 'tsc', cwd: dir, argv: [tsc, '--noEmit', '--pretty', 'false', '-p', config] }))
}

const pythonJob = async ($: EngineInterface, project: Project, checker: Checker, cwd: string): Promise<Job> =>
  checker === 'pyright'
    ? { checker, cwd, argv: [await resolveExecutable($, project, 'pyright', [...NODE_BIN, ...PYTHON_BIN]), '--outputjson'] }
    : {
        checker,
        cwd,
        argv: [await resolveExecutable($, project, 'mypy', PYTHON_BIN), '--no-error-summary', '--no-color-output', '--show-column-numbers'],
      }

/** The Python checker the project configures, and the directory its config lives in. */
const pythonChecker = async (project: Project): Promise<{ checker: Checker; cwd: string } | undefined> => {
  const pyrightDir = project.find(PYRIGHT_CONFIG)
  if (pyrightDir !== undefined) return { checker: 'pyright', cwd: pyrightDir }
  const mypyDir = project.find(...MYPY_CONFIGS)
  if (mypyDir !== undefined) return { checker: 'mypy', cwd: mypyDir }

  const pyproject = await project.readNearest('pyproject.toml')
  const pyprojectDir = project.find('pyproject.toml')
  if (pyproject !== undefined && pyprojectDir !== undefined) {
    if (/^\[tool\.pyright\]/m.test(pyproject)) return { checker: 'pyright', cwd: pyprojectDir }
    if (/^\[tool\.mypy\]/m.test(pyproject)) return { checker: 'mypy', cwd: pyprojectDir }
  }
  const setupCfg = await project.readNearest('setup.cfg')
  const setupDir = project.find('setup.cfg')
  if (setupCfg !== undefined && setupDir !== undefined && /^\[mypy\]/m.test(setupCfg)) return { checker: 'mypy', cwd: setupDir }
  return undefined
}

/** Runs each job in turn, the status line saying so. */
const runJobs = async ($: EngineInterface, jobs: readonly Job[], settings: Settings): Promise<CheckResult[]> => {
  $.ui.status(`⧗ typecheck: running ${[...new Set(jobs.map(job => job.checker))].join(', ')}…`)
  const results: CheckResult[] = []
  for (const job of jobs) {
    try {
      const run = await $.process.run(job.argv, { cwd: job.cwd, timeoutMs: settings.timeoutMs, env: { NO_COLOR: '1' } })
      const output = `${run.stdout}\n${run.stderr}`
      results.push(
        job.checker === 'tsc'
          ? parseTsc(output, job.cwd, run.exitCode)
          : job.checker === 'pyright'
            ? parsePyright(run.stdout, run.exitCode)
            : parseMypy(output, job.cwd, run.exitCode),
      )
    } catch (error) {
      const failure = isNotInstalled(error) ? 'not installed' : `stopped after ${settings.timeoutMs / 1000}s`
      results.push({ checker: job.checker, failure })
    }
  }
  return results
}

/** The status line for a finished check. */
const showVerdict = ($: EngineInterface, results: readonly CheckResult[]): void => {
  const findings = findingsOf(results)
  const failure = results.find(result => 'failure' in result)
  if (findings.length > 0) $.ui.status(`✗ types: ${countOf(findings)} (${checkersOf(results)})`)
  else if (failure !== undefined && 'failure' in failure) $.ui.status(`✗ typecheck: ${failure.checker} ${failure.failure}`)
  else $.ui.status(`✓ types: clean (${checkersOf(results)})`)
}

const findingsOf = (results: readonly CheckResult[]): Finding[] =>
  results.flatMap(result => ('findings' in result ? result.findings : []))

const checkersOf = (results: readonly CheckResult[]): string => [...new Set(results.map(result => result.checker))].join(', ')

const countOf = (findings: readonly Finding[]): string =>
  `${findings.length} type ${findings.length === 1 ? 'error' : 'errors'}`

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

  const find = (...names: string[]) => levels.find(level => names.some(name => level.names.has(name)))?.dir
  return {
    levels,
    find,
    readNearest: async name => {
      const dir = find(name)
      return dir === undefined ? undefined : $.fs.read(join(dir, name)).catch(() => undefined)
    },
  }
}

/** The nearest local install of `bin` under one of `folders`; the bare name, found on PATH, otherwise. */
const resolveExecutable = async ($: EngineInterface, project: Project, bin: string, folders: readonly string[]): Promise<string> => {
  for (const level of project.levels) {
    for (const folder of folders) {
      if (!level.names.has(folder.split('/')[0] ?? folder)) continue
      const candidate = join(level.dir, folder, bin)
      if (await $.fs.exists(candidate).catch(() => false)) return candidate
    }
  }
  return bin
}

/** The file a successful Edit, Write or MultiEdit changed; undefined otherwise. */
const editedFile = (e: ToolCallInput, ran: ToolCallResult): string | undefined => {
  if (!EDIT_TOOLS.has(String(e.tool)) || ran.deny !== undefined || ran.isError === true) return undefined
  const path = 'file_path' in e ? e.file_path : undefined
  return typeof path === 'string' && path !== '' ? path : undefined
}
