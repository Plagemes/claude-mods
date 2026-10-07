export type Finding = {
  /** The interpreter that would run the download. */
  interpreter: string
  /** The URLs the download names, for the "download first" advice. */
  urls: string[]
}

type Stage = string[]

const DOWNLOADERS = new Set(['curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod', 'fetch', 'http', 'https', 'xh', 'aria2c'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'ash', 'powershell', 'pwsh'])
const SCRIPT_RUNNERS = /^(?:python[\d.]*|pypy[\d]*|node|nodejs|ruby|perl|php|lua)$/
const ALWAYS_EXECUTES_INPUT = new Set(['iex', 'invoke-expression'])
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'exec', 'command', 'nohup', 'time', 'nice', 'stdbuf'])
const WRAPPER_OPTIONS_WITH_VALUE = new Set(['-u', '-g', '-h', '-p', '-C', '-r', '-t', '-U', '-D', '-T'])
const PROGRAM_OPTIONS = new Set(['-c', '-m', '-e', '-E', '-p', '-r', '--eval', '--print'])

const FETCH = String.raw`(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|fetch)\b`
const SUBSTITUTION = String.raw`(?:<\(|\$\(|\x60)\s*(?:sudo\s+)?`
const EVALUATORS = String.raw`(?:eval|source|iex|invoke-expression)\b|\.(?=\s)`
const INTERPRETERS = String.raw`(?:sh|bash|zsh|dash|ksh|fish|python[\d.]*|node|nodejs|ruby|perl|php)\b`
// eval "$(curl ...)", source <(curl ...), . <(wget ...)
const EVALUATES_SUBSTITUTION = new RegExp(String.raw`(?:^|[\s;&|(])(?:${EVALUATORS})[^;&|\n]*?${SUBSTITUTION}${FETCH}`, 'i')
// bash <(curl ...), sh -c "$(curl ...)"; but not python script.py "$(curl ...)", where the download is data
const INTERPRETS_SUBSTITUTION = new RegExp(
  String.raw`(?:^|[\s;&|(])(?:sudo\s+(?:-\S+\s+)*)?${INTERPRETERS}(?:\s+-{1,2}[\w-]+)*\s+["']?${SUBSTITUTION}${FETCH}`,
  'i',
)
// iex (iwr ...), iex ((New-Object Net.WebClient).DownloadString(...))
const POWERSHELL_EVALUATES_DOWNLOAD = new RegExp(String.raw`\b(?:iex|invoke-expression)\b[^;|\n]*?(?:${FETCH}|downloadstring)`, 'i')

/** Pipelines of stages of words: `a | b && c` is [[a, b], [c]]. Quotes are honoured; nothing is run. */
function parsePipelines(input: string): Stage[][] {
  const pipelines: Stage[][] = []
  let stages: Stage[] = []
  let words: string[] = []
  let word = ''
  let hasWord = false
  let quote: '"' | "'" | undefined

  const endWord = () => {
    if (hasWord && !/^[0-9]*[<>]/.test(word)) words.push(word)
    word = ''
    hasWord = false
  }
  const endStage = () => {
    endWord()
    if (words.length > 0) stages.push(words)
    words = []
  }
  const endPipeline = () => {
    endStage()
    if (stages.length > 0) pipelines.push(stages)
    stages = []
  }

  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
      else if (ch === '\\' && quote === '"' && i + 1 < input.length) word += input[++i]
      else word += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      hasWord = true
    } else if (ch === '\\' && i + 1 < input.length) {
      word += input[++i]
      hasWord = true
    } else if (ch === '|' && input[i + 1] !== '|') {
      endStage()
    } else if (ch === '&' && /[<>]$/.test(word)) {
      word += ch
    } else if (/[\n;|&()\x60]/.test(ch)) {
      endPipeline()
    } else if (/\s/.test(ch)) {
      endWord()
    } else {
      word += ch
      hasWord = true
    }
  }
  endPipeline()
  return pipelines
}

function baseName(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1).toLowerCase()
}

/** The command a stage runs and its arguments, with sudo/env-style wrappers and assignments skipped. */
function commandOf(stage: Stage): { name: string; args: string[] } | undefined {
  for (let i = 0; i < stage.length; i++) {
    const word = stage[i] as string
    if (/^\w+=/.test(word) || WRAPPERS.has(baseName(word))) continue
    if (word.startsWith('-')) {
      if (WRAPPER_OPTIONS_WITH_VALUE.has(word)) i += 1
      continue
    }
    return { name: baseName(word), args: stage.slice(i + 1) }
  }
  return undefined
}

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

function urlsIn(stage: Stage): string[] {
  return stage.filter(word => /^https?:\/\//i.test(word))
}

/** The first download that would be executed unread, or undefined. */
export function findPipeToShell(command: string): Finding | undefined {
  for (const stages of parsePipelines(command)) {
    for (let i = 1; i < stages.length; i++) {
      const runner = commandOf(stages[i] as Stage)
      if (runner === undefined || !readsProgramFromStdin(runner.name, runner.args)) continue
      const download = stages.slice(0, i).find(stage => DOWNLOADERS.has(commandOf(stage)?.name ?? ''))
      if (download !== undefined) return { interpreter: runner.name, urls: urlsIn(download) }
    }
  }
  const patterns = [EVALUATES_SUBSTITUTION, INTERPRETS_SUBSTITUTION, POWERSHELL_EVALUATES_DOWNLOAD]
  if (patterns.some(pattern => pattern.test(command))) {
    const urls = command.match(/https?:\/\/[^\s"')`]+/g) ?? []
    return { interpreter: 'a shell', urls }
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
