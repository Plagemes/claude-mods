import type { EngineInterface, Register } from 'claude-code'

import { hasNpmToken, isNpmrc, parseGlobs, protectionOf } from './paths'
import { baseName, parseShell } from './shell'

const FILE_TOOLS = /^(?:Read|Edit|Write|MultiEdit|NotebookEdit|Grep)$/
const PATH_FIELDS = ['file_path', 'notebook_path', 'path', 'glob'] as const
const TEXT_FIELDS = ['new_string', 'content', 'new_source'] as const

// Commands that print, copy, search, edit or send the files named to them.
const FILE_COMMANDS = new Set([
  'cat', 'tac', 'nl', 'rev', 'less', 'more', 'head', 'tail', 'bat', 'batcat', 'grep', 'egrep', 'fgrep',
  'rg', 'ag', 'ack', 'awk', 'gawk', 'sed', 'cut', 'sort', 'uniq', 'tr', 'od', 'xxd', 'hexdump', 'strings',
  'base64', 'diff', 'cmp', 'comm', 'paste', 'join', 'cp', 'mv', 'rm', 'ln', 'tee', 'scp', 'rsync',
  'curl', 'wget', 'nc', 'ncat', 'vi', 'vim', 'nvim', 'nano', 'emacs', 'code', 'open', 'dd', 'jq', 'yq',
])
const GIT_READERS = new Set(['show', 'cat-file', 'blame', 'grep'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish'])
/** How deep `bash -c "…"` strings are opened up. */
const MAX_NESTING = 3

type Verdict = { path: string; reason: string }

/** `@file`, `--flag=file` and `rev:file` all name a file after their last separator. */
function candidates(word: string): string[] {
  const tail = word.split(/[=@:]/).pop() ?? word
  return tail === word ? [word] : [word, tail]
}

async function expandHome($: EngineInterface, path: string): Promise<string> {
  if (!path.startsWith('~/')) return path
  const home = await $.env.get('HOME')
  return home === undefined ? path : `${home}${path.slice(1)}`
}

async function npmrcHoldsToken($: EngineInterface, path: string, newText: string): Promise<boolean> {
  if (hasNpmToken(newText)) return true
  try {
    return hasNpmToken(await $.fs.read(await expandHome($, path)))
  } catch {
    return false
  }
}

async function realPathOf($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    return (await $.fs.stat(path, { resolve: true })).realPath
  } catch {
    return undefined
  }
}

type Rules = { extra: RegExp[]; allowed: RegExp[] }

/** Why a path is off limits, or undefined when it may be used. */
async function judge($: EngineInterface, rules: Rules, path: string, newText = ''): Promise<Verdict | undefined> {
  if (rules.allowed.some(glob => glob.test(path))) return undefined
  if (rules.extra.some(glob => glob.test(path))) return { path, reason: 'a path you protected' }
  const byName = protectionOf(path)
  if (byName) return { path, reason: byName.reason }
  if (isNpmrc(path) && (await npmrcHoldsToken($, path, newText))) return { path, reason: 'an .npmrc holding an auth token' }
  return undefined
}

/** The command strings a command hands to a shell: `bash -c "…"` (also after `sudo` or `docker exec`) and `eval "…"`. */
function nestedScripts(words: readonly string[]): string[] {
  const scripts: string[] = []
  words.forEach((word, index) => {
    if (!SHELLS.has(baseName(word))) return
    const flag = words.findIndex((arg, at) => at > index && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg))
    const script = flag === -1 ? undefined : words[flag + 1]
    if (script !== undefined) scripts.push(script)
  })
  if (words[0] === 'eval') scripts.push(words.slice(1).join(' '))
  return scripts
}

/** The first protected file a shell line reads or writes, looking inside the scripts it hands to `bash -c` too. */
async function bashVerdict($: EngineInterface, rules: Rules, command: string, depth = 0): Promise<Verdict | undefined> {
  for (const { words, redirects } of parseShell(command)) {
    const names = words.map(baseName)
    const touchesFiles = names.some(name => FILE_COMMANDS.has(name)) || (names.includes('git') && names.some(name => GIT_READERS.has(name)))
    const paths = [...redirects, ...(touchesFiles ? words : [])].flatMap(candidates)
    for (const path of paths) {
      const verdict = await judge($, rules, path)
      if (verdict) return verdict
    }
    for (const script of depth < MAX_NESTING ? nestedScripts(words) : []) {
      const verdict = await bashVerdict($, rules, script, depth + 1)
      if (verdict) return verdict
    }
  }
  return undefined
}

function refusal(what: string, { path, reason }: Verdict): string {
  return `env-guard: ${what} ${path} (${reason}) is blocked. Ask the user for the value you need, or work from .env.example.`
}

export const register: Register = (on, options) => {
  const rules: Rules = {
    extra: parseGlobs(String(options.extraProtected ?? '')),
    allowed: parseGlobs(String(options.allowed ?? '')),
  }

  on('tool.call', { tool: FILE_TOOLS }, async ($, e, next) => {
    const input: Readonly<Record<string, unknown>> = e
    const newText = TEXT_FIELDS.map(field => input[field]).filter(value => typeof value === 'string').join('\n')
    for (const field of PATH_FIELDS) {
      const path = input[field]
      if (typeof path !== 'string') continue
      const direct = await judge($, rules, path, newText)
      if (direct) return { deny: refusal(`${String(e.tool)} of`, direct) }
      const real = field === 'glob' ? undefined : await realPathOf($, path)
      const viaLink = real === undefined || real === path ? undefined : await judge($, rules, real, newText)
      if (viaLink) return { deny: refusal(`${String(e.tool)} of`, { ...viaLink, path: `${path} -> ${real}` }) }
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'env-guard: its check failed, so the call was blocked.' }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const verdict = await bashVerdict($, rules, e.command)
    return verdict ? { deny: refusal('this command touches', verdict) } : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'env-guard: its check failed, so the command was blocked.' }))
}
