// Pure parts of the write-scope guard: which paths are tests or docs, code with its comments taken out,
// and what a shell command writes. No `$` here.

/** Where a preset may write: anywhere in the project, test files only, or documentation (and comments) only. */
export type Scope = 'project' | 'tests' | 'docs'

/** Folders any preset may use for scratch files. */
export const SCRATCH_DIRS = ['/tmp/', '/private/tmp/', '/var/folders/']

const TEST_PATH = [
  /(^|\/)(tests?|__tests__|__mocks__|__snapshots__|__fixtures__|specs?|e2e|fixtures|testdata|test[-_]?utils|testing)\//i,
  /\.(test|spec|e2e|stories)\.[a-z0-9]+$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /(^|\/)conftest\.py$/i,
  /_(test|spec)\.[a-z0-9]+$/i,
  /(Test|Tests|Spec|IT)\.(java|kt|kts|scala|cs|swift|groovy|php)$/,
]

const DOC_PATH = [
  /\.(md|mdx|markdown|rst|adoc|asciidoc|txt|org)$/i,
  /(^|\/)(docs?|documentation|guides?|wiki)\//i,
  /(^|\/)(README|CHANGELOG|CHANGES|HISTORY|CONTRIBUTING|AUTHORS|NOTICE|LICENSE|COPYING|CODE_OF_CONDUCT|SECURITY)(\.[a-z]+)?$/i,
]

export const isTestPath = (path: string): boolean => TEST_PATH.some(pattern => pattern.test(path))
export const isDocPath = (path: string): boolean => DOC_PATH.some(pattern => pattern.test(path))

type Syntax = { line: readonly string[]; block?: readonly [string, string]; docstrings?: boolean; keepIndent?: boolean }

const C_LIKE: Syntax = { line: ['//'], block: ['/*', '*/'] }
const HASH: Syntax = { line: ['#'], keepIndent: true }
const SYNTAX_BY_EXTENSION: Record<string, Syntax> = {
  ...Object.fromEntries(
    ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'java', 'kt', 'kts', 'scala', 'groovy', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs', 'go', 'rs', 'swift', 'dart', 'zig', 'proto'].map(
      ext => [ext, C_LIKE],
    ),
  ),
  ...Object.fromEntries(['css', 'scss', 'less'].map(ext => [ext, { line: [], block: ['/*', '*/'] } satisfies Syntax])),
  php: { line: ['//', '#'], block: ['/*', '*/'] },
  py: { line: ['#'], docstrings: true, keepIndent: true },
  pyi: { line: ['#'], docstrings: true, keepIndent: true },
  ...Object.fromEntries(['rb', 'sh', 'bash', 'zsh', 'fish', 'pl', 'r', 'ex', 'exs', 'cr', 'nim', 'yml', 'yaml', 'toml', 'tf', 'cmake'].map(ext => [ext, HASH])),
  ...Object.fromEntries(['sql', 'lua', 'hs', 'elm'].map(ext => [ext, { line: ['--'] } satisfies Syntax])),
}

const extensionOf = (path: string): string => /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? ''

/** Whether the guard can tell comments from code in this file. */
export const knowsComments = (path: string): boolean => extensionOf(path) in SYNTAX_BY_EXTENSION

/**
 * The code of a file with its comments (and Python docstrings) taken out and whitespace normalised, so two versions
 * that differ only in comments and docstrings compare equal. Strings are kept whole, comment markers inside them too.
 */
export function codeOnly(source: string, path: string): string {
  const syntax = SYNTAX_BY_EXTENSION[extensionOf(path)] ?? { line: [] }
  let out = ''
  let i = 0
  while (i < source.length) {
    const rest = source.slice(i, i + 3)
    if (syntax.docstrings === true && (rest === '"""' || rest === "'''")) {
      const end = source.indexOf(rest, i + 3)
      i = end < 0 ? source.length : end + 3
      continue
    }
    const char = source[i] ?? ''
    if (char === '"' || char === "'" || char === '`') {
      let j = i + 1
      while (j < source.length && source[j] !== char && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1
      out += source.slice(i, j + 1)
      i = j + 1
      continue
    }
    const block = syntax.block
    if (block !== undefined && source.startsWith(block[0], i)) {
      const end = source.indexOf(block[1], i + block[0].length)
      i = end < 0 ? source.length : end + block[1].length
      continue
    }
    if (syntax.line.some(marker => source.startsWith(marker, i))) {
      const end = source.indexOf('\n', i)
      i = end < 0 ? source.length : end
      continue
    }
    out += char
    i += 1
  }
  const lines = out.split('\n').map(line => (syntax.keepIndent === true ? line.trimEnd() : line.trim().replace(/\s+/g, ' ')))
  return lines.filter(line => line.trim() !== '').join('\n')
}

/** `source` after an Edit tool call, or undefined when `oldString` is not in it. */
export function applyEdit(source: string, oldString: string, newString: string, isReplaceAll: boolean): string | undefined {
  if (oldString === '' || !source.includes(oldString)) return undefined
  return isReplaceAll ? source.split(oldString).join(newString) : source.replace(oldString, () => newString)
}

/** `git`, its global options (`-C dir`, `--no-pager`, ...), then a subcommand that changes the repository's state. */
const GIT_STATE =
  /\bgit\s+(?:(?:-C|-c|--git-dir|--work-tree|--namespace)\s+\S+\s+|-\S+\s+)*(commit|push|pull|reset|checkout|switch|rebase|merge|cherry-pick|revert|clean|stash|restore|am|tag|update-ref|filter-branch|worktree)(?![\w-])([^;&|\n]*)/g
/** The read-only forms of those subcommands: listing stashes, tags and worktrees. */
const READ_ONLY_FORM: Record<string, RegExp> = {
  stash: /^\s+(?:list|show)\b/,
  tag: /^(?:\s*$|\s+(?:-l|--list|-n\d*|--contains|--no-contains|--points-at|--merged|--no-merged|--sort)\b)/,
  worktree: /^\s+list\b/,
}

/** Why a preset may not run this git command, or undefined. */
export function gitStateChange(command: string): string | undefined {
  for (const [, verb = '', rest = ''] of command.matchAll(GIT_STATE)) {
    if (READ_ONLY_FORM[verb]?.test(rest) !== true) return `git ${verb}`
  }
  return undefined
}

const DEPENDENCY_CHANGE =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:add|install|i|remove|rm|uninstall|update|upgrade)\b|pip3?\s+(?:install|uninstall)\b|poetry\s+(?:add|remove)\b|uv\s+(?:add|remove|pip\s+install)\b|cargo\s+(?:add|remove|install)\b|go\s+get\b|bundle\s+(?:add|install)\b|gem\s+install\b|composer\s+(?:require|remove)\b)/

export const changesDependencies = (command: string): boolean => DEPENDENCY_CHANGE.test(command)

const WRITING_COMMANDS = new Set(['rm', 'rmdir', 'mv', 'cp', 'touch', 'mkdir', 'ln', 'chmod', 'chown', 'truncate', 'install', 'rsync', 'tee', 'unlink', 'shred'])
/** Commands that write only their last operand (or the folder after `-t`): the sources are read. */
const DESTINATION_ONLY = new Set(['cp', 'ln', 'install', 'rsync'])
/** Commands whose first operand is a mode or an owner, not a path. */
const MODE_FIRST = new Set(['chmod', 'chown'])
const IN_PLACE = /(?:^|[\s;&|(])(?:sed|perl|ruby)\b[^|;&\n]*?\s(?:-[a-zA-Z]*i(?![a-df-zA-Z])|--in-place)/
const HEREDOC = /<<-?\s*(["']?)([A-Za-z_][\w-]*)\1[^\n]*\n[\s\S]*?(?:\n\t*\2[ \t]*(?=\n|$)|$)/g
const HARMLESS_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr'])
const WORD_END = /[\s;&|<>()]/

const unquote = (word: string): string => word.replace(/^(["'])(.*)\1$/, '$2')

/** The shell's own text: here-document bodies are data, not commands, so they are left out. */
const withoutHeredocs = (command: string): string =>
  command.replace(HEREDOC, (whole: string) => whole.slice(0, whole.indexOf('\n')))

/** The targets of `>`, `>>` and `>|` outside quotes. */
function redirectTargets(command: string): string[] {
  const targets: string[] = []
  let quote = ''
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? ''
    if (quote !== '') {
      if (char === quote) quote = ''
      else if (char === '\\' && quote === '"') index += 1
      continue
    }
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char !== '>' || command[index - 1] === '<' || command[index - 1] === '>') continue
    let at = index + 1
    if (command[at] === '>' || command[at] === '|') at += 1
    while (/\s/.test(command[at] ?? '')) at += 1
    let target = ''
    const opening = command[at]
    if (opening === '"' || opening === "'") {
      const close = command.indexOf(opening, at + 1)
      target = command.slice(at + 1, close < 0 ? command.length : close)
    } else {
      while (at < command.length && !WORD_END.test(command[at] ?? '')) target += command[at++]
    }
    if (target !== '' && !HARMLESS_TARGETS.has(target) && !target.startsWith('&')) targets.push(target)
  }
  return targets
}

/** The operands a file command writes. */
function operandsWritten(program: string, words: readonly string[]): string[] {
  const operands: string[] = []
  let targetDirectory: string | undefined
  let isRedirectTarget = false
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? ''
    if (/^\d?>{1,2}/.test(word)) {
      isRedirectTarget = word.replace(/^\d?>{1,2}\|?/, '') === ''
      continue
    }
    if (isRedirectTarget) {
      isRedirectTarget = false
      continue
    }
    if (word === '-t' || word === '--target-directory') {
      targetDirectory = words[index + 1]
      index += 1
    } else if (word.startsWith('--target-directory=')) {
      targetDirectory = word.slice('--target-directory='.length)
    } else if (!word.startsWith('-') || (MODE_FIRST.has(program) && operands.length === 0 && /^-[rwxXst]+$/.test(word))) {
      operands.push(word)
    }
  }
  if (MODE_FIRST.has(program)) return operands.slice(1)
  if (DESTINATION_ONLY.has(program)) return targetDirectory !== undefined ? [targetDirectory] : operands.slice(-1)
  return operands
}

/**
 * The paths a shell command writes, as far as its words show: redirections, `tee`, and file commands such as
 * cp, mv, rm, touch, mkdir. Undefined when it edits in place (sed -i, perl -i), where the files cannot be told.
 * Best effort: a script that writes files itself (python -c, node -e) is not seen.
 */
export function shellWrites(command: string): string[] | undefined {
  const shell = withoutHeredocs(command)
  if (IN_PLACE.test(shell)) return undefined
  const targets = redirectTargets(shell)
  for (const segment of shell.split(/&&|\|\||[;|\n]/)) {
    const words = (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(unquote)
    let at = 0
    while (at < words.length && (/^\w+=/.test(words[at] ?? '') || words[at] === 'sudo' || words[at] === 'command')) at += 1
    const program = (words[at] ?? '').split('/').pop() ?? ''
    if (WRITING_COMMANDS.has(program)) targets.push(...operandsWritten(program, words.slice(at + 1)))
  }
  return targets
}

/** A shell target as a path relative to `root` when it lies inside it; undefined when it lies outside. */
function insideRoot(target: string, root: string): string | undefined {
  if (!target.startsWith('/') && !target.startsWith('~')) return target.split('/').includes('..') ? undefined : target.replace(/^\.\//, '')
  return target.startsWith(`${root}/`) ? target.slice(root.length + 1) : undefined
}

/** Why a preset may not run this shell command, or undefined when it may. `root` is the project root, absolute. */
export function shellRefusal(scope: Scope, command: string, root: string): string | undefined {
  const git = gitStateChange(command)
  if (git !== undefined) return `leaves version control to you (no ${git})`
  if (scope === 'project') return undefined
  if (changesDependencies(command)) return 'does not change dependencies; it names what is missing in its report instead'
  const writes = shellWrites(command)
  if (writes === undefined) return 'edits files with Edit and Write, not in place from the shell (sed -i, perl -i)'
  const isAllowedPath = scope === 'tests' ? isTestPath : isDocPath
  // A folder named like one (`mkdir -p src/__tests__`) is in scope too.
  const allowed = (relative: string): boolean => isAllowedPath(relative) || isAllowedPath(`${relative.replace(/\/+$/, '')}/`)
  const outside = writes.find(target => {
    if (SCRATCH_DIRS.some(dir => target.startsWith(dir))) return false
    const relative = insideRoot(target, root)
    return relative === undefined || !allowed(relative)
  })
  return outside === undefined ? undefined : `may not write ${outside} from the shell (${scope === 'tests' ? 'test files' : 'documentation'} only)`
}
