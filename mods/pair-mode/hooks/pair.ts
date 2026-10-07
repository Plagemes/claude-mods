/** What `/pair <args>` asks for. */
export type PairAction = 'on' | 'off' | 'check' | 'toggle' | 'help'

/** Line counts of a diff, from `git diff --numstat`. */
export type DiffStats = { files: number; adds: number; dels: number }

/** Where the diff a check sends starts from. */
export type Since = 'start' | 'review' | 'head'

export const MAX_DIFF_CHARS = 40_000

export const parseAction = (args: string): PairAction => {
  const word = args.trim().toLowerCase()
  if (word === '') return 'toggle'
  if (word === 'on' || word === 'start') return 'on'
  if (word === 'off' || word === 'stop') return 'off'
  if (word === 'check' || word === 'review') return 'check'
  return 'help'
}

// ── Shell commands that write files ─────────────────────────────────────────

const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g
const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/
const SEPARATORS = /\|\||&&|[;|&\n()`]|\$\(/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const WRAPPERS = new Set(['sudo', 'command', 'exec', 'nohup', 'time', 'env', 'nice', 'xargs', 'doas'])
const SAFE_TARGET = /^(?:\/dev\/(?:null|stdout|stderr|tty)|&\d|&-)$/
const REDIRECTION = /(?:^|[^<>&\d])\d?>>?\|?(?!&)\s*([^\s;&|<>()]+)/g
const BOTH_REDIRECTION = /&>>?\s*([^\s;&|<>()]+)/g
// `--?\w`: an option's dashes are read one way only, so a long run of options cannot backtrack exponentially.
const INLINE_SCRIPT = /\b(?:node|python[\d.]*|ruby|perl|deno|bun|php)(?:\s+--?\w[\w-]*)*\s+(?:-e|-c|-p|-r|--eval|eval|-)(?=\s|$)/
const SCRIPTED_WRITE =
  /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|write_text|write_bytes)\s*\(|\bopen\([^)]*,\s*['"](?:[wax]b?\+?|[rwa]\+b?)['"]/
const FILE_TOOLS = new Set(['rm', 'mv', 'cp', 'touch', 'truncate', 'ln', 'patch', 'rmdir', 'unlink', 'shred'])
const GIT_WRITERS = new Set(['apply', 'am', 'restore', 'cherry-pick', 'revert', 'merge', 'rebase', 'pull'])
const FORMATTERS = new Set(['black', 'isort', 'rustfmt', 'autopep8', 'yapf', 'autoflake'])
const CHECK_FLAGS = new Set(['--check', '--check-only', '--diff', '-c', '--dry-run'])

/** Drops here-document bodies, so their lines are not read as commands. */
const withoutHeredocs = (command: string): string => {
  const kept: string[] = []
  let delimiter: string | undefined
  for (const line of command.split('\n')) {
    if (delimiter !== undefined) {
      if (line.trim() === delimiter) delimiter = undefined
      continue
    }
    kept.push(line)
    delimiter = HEREDOC.exec(line)?.[2]
  }
  return kept.join('\n')
}

/** The words of each simple command, quoted text blanked out; env assignments and wrappers dropped. */
const simpleCommands = (bare: string): string[][] =>
  bare
    .split(SEPARATORS)
    .map(part => part.trim().split(/\s+/).filter(word => word !== ''))
    .map(words => {
      let start = 0
      while (start < words.length) {
        const word = words[start] as string
        if (ASSIGNMENT.test(word) || WRAPPERS.has(word) || (start > 0 && word.startsWith('-') && WRAPPERS.has(words[start - 1] ?? ''))) {
          start += 1
        } else break
      }
      return words.slice(start)
    })
    .filter(words => words.length > 0)

const hasShortFlag = (args: readonly string[], flag: string): boolean =>
  args.some(arg => /^-[A-Za-z]+/.test(arg) && !arg.startsWith('--') && arg.slice(1).includes(flag))

const programOf = (word: string): string => word.slice(word.lastIndexOf('/') + 1)

const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])

/** The git subcommand, past global options such as `-C <dir>`. */
const gitSubcommand = (args: readonly string[]): string | undefined => {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string
    if (GIT_VALUED.has(arg)) i += 1
    else if (!arg.startsWith('-')) return arg
  }
  return undefined
}

/** Why one simple command writes files, or undefined. */
const writerOf = (words: readonly string[]): string | undefined => {
  const program = programOf(words[0] ?? '')
  const args = words.slice(1)
  if (FILE_TOOLS.has(program)) return program
  if (program === 'tee' && args.some(arg => !arg.startsWith('-') && !SAFE_TARGET.test(arg))) return 'tee'
  if ((program === 'sed' || program === 'perl') && (hasShortFlag(args, 'i') || args.some(arg => arg.startsWith('--in-place')))) {
    return `${program} -i`
  }
  if (program === 'dd' && args.some(arg => arg.startsWith('of='))) return 'dd of='
  if (program === 'find') {
    if (args.includes('-delete')) return 'find -delete'
    const exec = args.findIndex(arg => arg === '-exec' || arg === '-execdir')
    if (exec !== -1) return writerOf(args.slice(exec + 1))
  }
  if (program === 'git') {
    const sub = gitSubcommand(args)
    if (sub === undefined) return undefined
    if (GIT_WRITERS.has(sub)) return `git ${sub}`
    if (sub === 'checkout' && args.includes('--')) return 'git checkout --'
    if (sub === 'stash' && args.some(arg => arg === 'pop' || arg === 'apply')) return 'git stash pop'
    if (sub === 'reset' && args.includes('--hard')) return 'git reset --hard'
  }
  if (args.includes('--fix') || args.includes('--write')) return `${program} ${args.includes('--fix') ? '--fix' : '--write'}`
  if (program === 'prettier' && args.includes('-w')) return 'prettier -w'
  if ((program === 'gofmt' || program === 'goimports') && args.includes('-w')) return `${program} -w`
  if (program === 'cargo' && args[0] === 'fmt' && !args.includes('--check')) return 'cargo fmt'
  if (program === 'ruff' && args[0] === 'format' && !args.some(arg => CHECK_FLAGS.has(arg))) return 'ruff format'
  if (FORMATTERS.has(program) && !args.some(arg => CHECK_FLAGS.has(arg))) return program
  if ((program === 'rubocop' || program === 'standardrb') && (args.includes('-a') || args.includes('-A') || args.includes('--autocorrect'))) {
    return `${program} --autocorrect`
  }
  return undefined
}

/**
 * Why a shell command looks like it writes files (`sed -i`, `> out.txt`,
 * `rm`, `prettier --write`, a script calling writeFileSync...), or
 * undefined when it does not. Best effort: quoted text and here-document
 * bodies are not read as commands, and redirections to /dev/null are fine.
 */
export const writesFiles = (command: string): string | undefined => {
  if (INLINE_SCRIPT.test(command) && SCRIPTED_WRITE.test(command)) return 'a script that writes files'
  const bare = withoutHeredocs(command).replace(QUOTED, '""')
  for (const pattern of [REDIRECTION, BOTH_REDIRECTION]) {
    for (const match of bare.matchAll(pattern)) {
      const target = match[1] ?? ''
      if (!SAFE_TARGET.test(target)) return target === '""' ? 'a redirection to a file' : `a redirection to ${target}`
    }
  }
  for (const words of simpleCommands(bare)) {
    const writer = writerOf(words)
    if (writer !== undefined) return writer
  }
  return undefined
}

// ── Reviews ─────────────────────────────────────────────────────────────────

/** Totals of `git diff --numstat` output; binary files count as a file with no lines. */
export const parseNumstat = (numstat: string): DiffStats => {
  const stats: DiffStats = { files: 0, adds: 0, dels: 0 }
  for (const line of numstat.split('\n')) {
    const [adds, dels, path] = line.split('\t')
    if (path === undefined || path === '') continue
    stats.files += 1
    stats.adds += Number(adds) || 0
    stats.dels += Number(dels) || 0
  }
  return stats
}

/** The diff whole, or cut at the last file boundary before `max` characters. */
export const cutDiff = (diff: string, max = MAX_DIFF_CHARS): { text: string; isCut: boolean } => {
  if (diff.length <= max) return { text: diff, isCut: false }
  const boundary = diff.lastIndexOf('\ndiff --git ', max)
  const end = boundary > 0 ? boundary + 1 : max
  return { text: diff.slice(0, end), isCut: true }
}

export const describeStats = (stats: DiffStats): string =>
  `${stats.files} file${stats.files === 1 ? '' : 's'}, +${stats.adds} −${stats.dels}`

const SINCE_WORDS: Record<Since, string> = {
  start: 'since pair mode started',
  review: 'since your last review',
  head: 'since the last commit',
}

/** The prompt the person sees in the transcript for a check. */
export const reviewRequest = (stats: DiffStats, since: Since): string =>
  `Review the changes I typed ${SINCE_WORDS[since]} (${describeStats(stats)}; the diff is attached).`

/** The model-only note that carries the diff under review. */
export const reviewContext = (diff: string, since: Since): string => {
  const { text, isCut } = cutDiff(diff)
  return [
    `pair-mode check: the user applied these changes by hand ${SINCE_WORDS[since]}.`,
    'Review them as a pairing partner: do they match what you proposed (if you proposed something), and are there bugs, typos, ' +
      'missed cases, naming or style problems, or missing tests? Be specific and brief, praise what is right in one line, and give any ' +
      'fix as a unified diff for the user to type. Do not edit files yourself.',
    '```diff',
    text.trimEnd(),
    '```',
    ...(isCut ? [`(The diff was cut at ${MAX_DIFF_CHARS} characters; ask the user for the rest if needed.)`] : []),
  ].join('\n')
}

/** `path` made absolute against `root` (POSIX or a Windows drive path left as is). */
export const absolutePath = (root: string, path: string): string =>
  path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) ? path : `${root.replace(/[\\/]+$/, '')}/${path}`
