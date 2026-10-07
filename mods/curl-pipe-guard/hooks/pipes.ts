import { embeddedShellScripts, simpleCommands, type ShellCommand } from './shared/shell'

export type Finding = {
  /** Which case it is, for mods-hub's risk.blocked: `pipe-to-interpreter` or `run-substitution`. */
  rule: string
  /** The interpreter that would run the download. */
  interpreter: string
  /** The URLs the download names, for the "download first" advice. */
  urls: string[]
}

const DOWNLOADERS = new Set(['curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod', 'fetch', 'http', 'https', 'xh', 'aria2c'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'ash', 'powershell', 'pwsh'])
const SCRIPT_RUNNERS = /^(?:python[\d.]*|pypy[\d]*|node|nodejs|ruby|perl|php|lua)$/
const ALWAYS_EXECUTES_INPUT = new Set(['iex', 'invoke-expression'])
const PROGRAM_OPTIONS = new Set(['-c', '-m', '-e', '-E', '-p', '-r', '--eval', '--print'])
/** How deep scripts handed to a shell further along (`docker exec web sh -c '…'`) are opened up. */
const MAX_NESTING = 3

const FETCH = String.raw`(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|fetch)\b`
const SUBSTITUTION = String.raw`(?:<\(|\$\(|\x60)\s*(?:sudo\s+)?`
const EVALUATORS = String.raw`(?:eval|source|iex|invoke-expression)\b|\.(?=\s)`
const INTERPRETERS = String.raw`(?:sh|bash|zsh|dash|ksh|fish|python[\d.]*|node|nodejs|ruby|perl|php)\b`
// eval "$(curl ...)", source <(curl ...), . <(wget ...)
const EVALUATES_SUBSTITUTION = new RegExp(String.raw`(?:^|[\s;&|(])(?:${EVALUATORS})[^;&|\n]*?${SUBSTITUTION}${FETCH}`, 'i')
// bash <(curl ...), /bin/sh -c "$(curl ...)", bash < <(curl ...), bash <<< "$(curl ...)";
// but not python script.py "$(curl ...)", where the download is data
const INTERPRETS_SUBSTITUTION = new RegExp(
  String.raw`(?:^|[\s;&|(])(?:sudo\s+(?:-\S+\s+)*)?(?:[^\s;&|()<>]*/)?${INTERPRETERS}(?:\s+-{1,2}[\w-]+)*\s+(?:<{1,3}\s*)?["']?${SUBSTITUTION}${FETCH}`,
  'i',
)
// iex (iwr ...), iex ((New-Object Net.WebClient).DownloadString(...))
const POWERSHELL_EVALUATES_DOWNLOAD = new RegExp(String.raw`\b(?:iex|invoke-expression)\b[^;|\n]*?(?:${FETCH}|downloadstring)`, 'i')

/** Does this interpreter, with these arguments, take its program from standard input? */
function readsProgramFromStdin(name: string, args: readonly string[]): boolean {
  if (ALWAYS_EXECUTES_INPUT.has(name)) return true
  const isShell = SHELLS.has(name)
  if (!isShell && !SCRIPT_RUNNERS.test(name)) return false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '-' || arg === '-s') return true
    if (arg === '--') continue
    if (arg === '-o' || arg === '+o') i += 1
    else if (isShell && /^-[a-zA-Z]*c/.test(arg)) return false
    else if (!isShell && PROGRAM_OPTIONS.has(arg)) return false
    else if (!arg.startsWith('-')) return false
  }
  return true
}

const urlsIn = (argv: readonly string[]): string[] => argv.filter(word => /^https?:\/\//i.test(word))

/** A downloader piped straight into a stage that runs its stdin as a program. */
function pipedDownload(commands: readonly ShellCommand[]): Finding | undefined {
  for (const runner of commands) {
    if (runner.stage === 0 || !readsProgramFromStdin(runner.name, runner.argv.slice(1))) continue
    const download = commands.find(cmd => cmd.pipeline === runner.pipeline && cmd.stage < runner.stage && DOWNLOADERS.has(cmd.name))
    if (download !== undefined) return { rule: 'pipe-to-interpreter', interpreter: runner.name, urls: urlsIn(download.argv) }
  }
  return undefined
}

/**
 * The first download that would be executed unread, or undefined. The shared shell reader splits pipelines, peels
 * wrappers (`sudo -E`, `env`, `FOO=1`) and opens `bash -c "…"`, `eval "…"`, `$(…)` and heredocs fed to a shell;
 * scripts handed to a shell further along (`docker exec web sh -c '…'`) are opened here.
 */
export function findPipeToShell(command: string, depth = 0): Finding | undefined {
  const commands = simpleCommands(command)
  if (depth < MAX_NESTING) {
    for (const { argv } of commands) {
      for (const script of embeddedShellScripts(argv)) {
        const found = findPipeToShell(script, depth + 1)
        if (found !== undefined) return found
      }
    }
  }
  const piped = pipedDownload(commands)
  if (piped !== undefined) return piped
  const patterns = [EVALUATES_SUBSTITUTION, INTERPRETS_SUBSTITUTION, POWERSHELL_EVALUATES_DOWNLOAD]
  if (patterns.some(pattern => pattern.test(command))) {
    const urls = command.match(/https?:\/\/[^\s"')`]+/g) ?? []
    return { rule: 'run-substitution', interpreter: 'a shell', urls }
  }
  return undefined
}

export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
}
