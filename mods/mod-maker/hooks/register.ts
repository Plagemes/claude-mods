import type { EngineInterface, Register } from 'claude-code'

import { claudeBinary, parseTestRun, parseValidation } from './cli'
import { KINDS, githubRepository, isKind, moduleFile, parseArgs, scaffold } from './templates'
import type { Kind, ModSpec } from './templates'

type Dollar = EngineInterface
/** The userConfig values this load runs with. */
type Settings = { author: string; defaultKind: Kind; shouldRunTests: boolean }

const COMMAND = 'new-mod'
const ARGUMENT_HINT = `<name> [description] [--kind ${KINDS.join('|')}]`
const GIT_TIMEOUT_MS = 3_000
const VALIDATE_TIMEOUT_MS = 60_000
const TEST_TIMEOUT_MS = 180_000
const SHOWN_ERRORS = 5
const KIND_LINES: Record<Kind, string> = {
  guard: 'guard    a tool.call hook that refuses risky Bash commands (fails closed)',
  status: 'status   a status line that counts tool calls, with a userConfig label',
  pane: 'pane     a /<name> command opening a pane drawn from $.state',
  command: 'command  a /<name> command answered from a command.run hook',
}
/** Kinds whose template registers `/<name>`. */
const COMMAND_KINDS = new Set<Kind>(['pane', 'command'])

const describe = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^[\w-]+: \$\.[\w.]+: /, '')

const usage = (): string =>
  [`Usage: /${COMMAND} ${ARGUMENT_HINT}`, 'Kinds:', ...KINDS.map(kind => `  ${KIND_LINES[kind]}`)].join('\n')

async function isDirectory($: Dollar, path: string): Promise<boolean> {
  try {
    return (await $.fs.stat(path)).kind === 'dir'
  } catch {
    return false
  }
}

/** One line of a git command's output, or undefined outside a repository or without git. */
async function gitLine($: Dollar, cwd: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const ran = await $.process.run(['git', ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS })
    const line = ran.stdout.trim().split('\n')[0]?.trim() ?? ''
    return ran.exitCode === 0 && line !== '' ? line : undefined
  } catch {
    return undefined
  }
}

/** Why `/<name>` cannot be the new command, when another command already has it. */
async function commandClash($: Dollar, name: string): Promise<string | undefined> {
  let commands: Awaited<ReturnType<Dollar['command']['list']>>
  try {
    commands = await $.command.list()
  } catch {
    return undefined
  }
  const taken = commands.find(command => command.name === name)
  if (taken === undefined) return undefined
  const owner = taken.source === 'plugin' && taken.plugin !== undefined ? `the ${taken.plugin} plugin's` : `a ${taken.source} command`

  return `/${name} is already ${owner}. Pane and command mods register /<name>: pick another name, or use --kind guard or status.`
}

async function claudeBin($: Dollar): Promise<string> {
  try {
    return claudeBinary(await $.env.get('CLAUDE_CODE_EXECPATH'))
  } catch {
    return claudeBinary(undefined)
  }
}

/** `claude plugin validate`'s verdict on the new folder, as report lines. */
async function validate($: Dollar, bin: string, dir: string): Promise<{ lines: string[]; isOk: boolean }> {
  try {
    const ran = await $.process.run([bin, 'plugin', 'validate', dir, '--json'], { timeoutMs: VALIDATE_TIMEOUT_MS })
    const report = parseValidation(ran.stdout)
    if (report === undefined) return { lines: [`? claude plugin validate printed no report (exit code ${ran.exitCode}).`], isOk: false }
    if (report.isOk) {
      const warnings = report.warnings === 0 ? '' : ` (${report.warnings} warning${report.warnings === 1 ? '' : 's'})`
      return { lines: [`✓ claude plugin validate: passed${warnings}`], isOk: true }
    }
    return {
      lines: ['✗ claude plugin validate: failed', ...report.errors.slice(0, SHOWN_ERRORS).map(error => `  ${error}`)],
      isOk: false,
    }
  } catch (error) {
    return { lines: [`? claude plugin validate did not run: ${describe(error)}`], isOk: false }
  }
}

async function runTests($: Dollar, bin: string, dir: string): Promise<string> {
  try {
    const ran = await $.process.run([bin, 'plugin', 'test', dir], { timeoutMs: TEST_TIMEOUT_MS })
    const counts = parseTestRun(`${ran.stdout}\n${ran.stderr}`)
    if (counts === undefined) return `? claude plugin test printed no result (exit code ${ran.exitCode}).`
    return counts.failed === 0 && ran.exitCode === 0
      ? `✓ claude plugin test: ${counts.passed} passed`
      : `✗ claude plugin test: ${counts.failed} failed, ${counts.passed} passed`
  } catch (error) {
    return `? claude plugin test did not run: ${describe(error)}`
  }
}

/** Scaffolds the mod `/new-mod` asks for and reports what was made, checked and what comes next. */
async function newMod($: Dollar, settings: Settings, args: string): Promise<string> {
  if (args.trim() === '' || args.trim() === '--help') return usage()
  const parsed = parseArgs(args, settings.defaultKind)
  if (!parsed.isOk) return `✗ ${parsed.reason}\n${usage()}`

  const cwd = (await $.session.cwd()).replace(/[\\/]+$/, '')
  const isCollection = await isDirectory($, `${cwd}/mods`)
  const shown = isCollection ? `mods/${parsed.name}` : parsed.name
  const dir = `${cwd}/${shown}`
  if (await $.fs.exists(dir)) return `✗ ${shown} already exists. Pick another name, or remove that folder first.`
  if (COMMAND_KINDS.has(parsed.kind)) {
    const clash = await commandClash($, parsed.name)
    if (clash !== undefined) return `✗ ${clash}`
  }

  const [gitAuthor, remote] = await Promise.all([
    settings.author === '' ? gitLine($, cwd, ['config', 'user.name']) : Promise.resolve(undefined),
    gitLine($, cwd, ['remote', 'get-url', 'origin']),
  ])
  const author = settings.author === '' ? gitAuthor : settings.author
  const repository = remote === undefined ? undefined : githubRepository(remote)
  const spec: ModSpec = {
    name: parsed.name,
    description: parsed.description,
    kind: parsed.kind,
    isCollection,
    ...(author === undefined ? {} : { author }),
    ...(repository === undefined ? {} : { repository }),
  }

  const written: string[] = []
  for (const [path, text] of Object.entries(scaffold(spec))) {
    try {
      await $.fs.write(`${dir}/${path}`, text)
      written.push(path)
    } catch (error) {
      const partial = written.length === 0 ? '' : ` Already written: ${written.join(', ')}.`
      return `✗ Could not write ${shown}/${path}: ${describe(error)}.${partial}`
    }
  }

  const bin = await claudeBin($)
  const checked = await validate($, bin, dir)
  const tested = settings.shouldRunTests && checked.isOk ? [await runTests($, bin, dir)] : []
  const hooksFile = `hooks/${moduleFile(parsed.kind)}`

  return [
    `✓ Created ${shown}, a ${parsed.kind} mod: ${written.join(' · ')}`,
    ...checked.lines,
    ...tested,
    'Next:',
    `  1. Fill in ${hooksFile} and the TODOs in README.md.`,
    `  2. Try it: claude --plugin-dir ${shown}`,
    `  3. Test it: claude plugin test ${shown}`,
    ...(isCollection ? ['  4. List it in .claude-plugin/marketplace.json to publish it.'] : []),
  ].join('\n')
}

export const register: Register = (on, options) => {
  const kind = String(options.defaultKind ?? '')
  const settings: Settings = {
    author: typeof options.author === 'string' ? options.author.trim() : '',
    defaultKind: isKind(kind) ? kind : 'command',
    shouldRunTests: options.runTests !== false,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'new-mod',
      description: 'Scaffold a new Claude Code mod: manifest, hooks, a passing test and a README',
      argumentHint: ARGUMENT_HINT,
    })

    return next(e)
  })

  on('command.run', { command: 'new-mod' }, async ($, e) => ({ text: await newMod($, settings, e.args) }))
}
