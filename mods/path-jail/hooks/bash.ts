/**
 * A small, conservative reader of shell commands: it finds the paths a command
 * line would write to (redirections and the usual file commands), and the `cd`
 * in effect where each one is written. Best effort: a shell is Turing complete.
 */

/** One path a command would write, and the `cd` target in effect before it (undefined: the shell's cwd). */
export type WriteTarget = {
  path: string
  /** `cd` arguments seen earlier on the line, in order; the target is relative to the last. */
  cdChain: readonly string[]
  /** What writes it, for messages: `>`, `tee`, `rm`, ... */
  via: string
}

type Word = { kind: 'word'; text: string }
type Op = { kind: 'op'; text: string }
type Redirect = { kind: 'redirect'; text: string; isWrite: boolean; isHeredoc: boolean }
type Token = Word | Op | Redirect

const SEPARATORS = new Set(['&&', '||', ';', '|', '|&', '&', '\n', '(', ')', '{', '}'])
const PREFIX_WORDS = new Set(['command', 'builtin', 'nohup', 'time', 'exec', 'then', 'do', 'else', 'if', 'while', 'until', '!'])
const SAFE_DEVICES = /^\/dev\/(?:null|zero|stdout|stderr|stdin|tty|fd\/\d+)$/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Splits a command line into words, separators and redirections, honouring quotes, escapes and heredocs. */
export const tokenize = (command: string): Token[] => {
  const tokens: Token[] = []
  const heredocs: { delimiter: string; stripTabs: boolean }[] = []
  let word = ''
  let hasWord = false
  let i = 0

  const pushWord = (): void => {
    if (hasWord) tokens.push({ kind: 'word', text: word })
    word = ''
    hasWord = false
  }

  /** Skips heredoc bodies that start after the newline at `i`. */
  const skipHeredocs = (): void => {
    while (heredocs.length > 0) {
      const { delimiter, stripTabs } = heredocs.shift() as { delimiter: string; stripTabs: boolean }
      while (i < command.length) {
        const end = command.indexOf('\n', i)
        const line = command.slice(i, end === -1 ? command.length : end)
        i = end === -1 ? command.length : end + 1
        if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) break
      }
    }
  }

  while (i < command.length) {
    const char = command[i] as string
    const next = command[i + 1] ?? ''

    if (char === '\\' && next !== '') {
      if (next !== '\n') {
        word += next
        hasWord = true
      }
      i += 2
      continue
    }
    if (char === "'") {
      const end = command.indexOf("'", i + 1)
      const stop = end === -1 ? command.length : end
      word += command.slice(i + 1, stop)
      hasWord = true
      i = stop + 1
      continue
    }
    if (char === '"') {
      i += 1
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < command.length) i += 1
        word += command[i]
        i += 1
      }
      hasWord = true
      i += 1
      continue
    }
    if (char === '$' && next === '(') {
      // Keep a command substitution whole inside the word: its contents are not this line's redirections.
      let depth = 0
      const start = i
      for (; i < command.length; i += 1) {
        if (command[i] === '(') depth += 1
        else if (command[i] === ')' && --depth === 0) break
      }
      word += command.slice(start, i + 1)
      hasWord = true
      i += 1
      continue
    }
    if (char === '`') {
      const end = command.indexOf('`', i + 1)
      const stop = end === -1 ? command.length : end
      word += command.slice(i, stop + 1)
      hasWord = true
      i = stop + 1
      continue
    }
    if (char === '#' && !hasWord) {
      while (i < command.length && command[i] !== '\n') i += 1
      continue
    }
    if (char === '\n') {
      pushWord()
      tokens.push({ kind: 'op', text: '\n' })
      i += 1
      skipHeredocs()
      continue
    }
    if (char === ' ' || char === '\t') {
      pushWord()
      i += 1
      continue
    }
    if (char === '>' || char === '<' || (char === '&' && next === '>')) {
      // A word made only of digits right before the operator is its file descriptor (`2>`).
      if (/^\d+$/.test(word)) {
        word = ''
        hasWord = false
      }
      pushWord()
      const rest = command.slice(i)
      const op = /^(?:&>>|&>|>>|>\||>&|>|<<<|<<-|<<|<&|<>|<)/.exec(rest)?.[0] ?? char
      i += op.length
      if ((op === '>&' || op === '<&') && /^\s*(?:\d+|-)(?![\w./])/.test(command.slice(i))) {
        // File-descriptor duplication (`2>&1`, `>&-`): no file is written.
        const dup = /^\s*(?:\d+|-)/.exec(command.slice(i))?.[0] ?? ''
        i += dup.length
        continue
      }
      const isHeredoc = op === '<<' || op === '<<-'
      tokens.push({ kind: 'redirect', text: op, isWrite: op.includes('>'), isHeredoc })
      if (isHeredoc) {
        const match = /^\s*(['"]?)([^\s'";&|<>]+)\1/.exec(command.slice(i))
        if (match !== null) {
          heredocs.push({ delimiter: match[2] as string, stripTabs: op === '<<-' })
          i += match[0].length
        }
      }
      continue
    }
    const two = char + next
    if (two === '&&' || two === '||' || two === '|&' || two === ';;') {
      pushWord()
      tokens.push({ kind: 'op', text: two === ';;' ? ';' : two })
      i += 2
      continue
    }
    if (char === ';' || char === '|' || char === '&' || char === '(' || char === ')') {
      pushWord()
      tokens.push({ kind: 'op', text: char })
      i += 1
      continue
    }
    if ((char === '{' || char === '}') && !hasWord && (next === ' ' || next === '\n' || next === '' || next === ';')) {
      pushWord()
      tokens.push({ kind: 'op', text: char })
      i += 1
      continue
    }
    word += char
    hasWord = true
    i += 1
  }
  pushWord()
  return tokens
}

const operands = (args: readonly string[]): string[] => {
  const result: string[] = []
  let isOptionsDone = false
  for (const arg of args) {
    if (!isOptionsDone && arg === '--') {
      isOptionsDone = true
      continue
    }
    if (!isOptionsDone && arg.startsWith('-') && arg !== '-') continue
    result.push(arg)
  }
  return result
}

/** `-t DIR` / `--target-directory=DIR` of cp, mv, ln, install. */
const targetDirectory = (args: readonly string[]): string | undefined => {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string
    if (arg === '-t' || arg === '--target-directory') return args[i + 1]
    if (arg.startsWith('--target-directory=')) return arg.slice('--target-directory='.length)
    if (/^-[a-zA-Z]*t$/.test(arg) && !arg.startsWith('--')) return args[i + 1]
  }
  return undefined
}

/** Arguments of options that take a value, so they are not read as operands. */
const withoutOptionValues = (args: readonly string[], valued: ReadonlySet<string>): string[] =>
  args.filter((arg, index) => !valued.has(args[index - 1] ?? '') || arg.startsWith('-'))

/** Options whose value is the next argument, per command, so the value is not read as a path. */
const VALUED_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  touch: new Set(['-r', '-d', '-t', '--reference', '--date']),
  mkdir: new Set(['-m', '--mode']),
  truncate: new Set(['-s', '--size', '-r', '--reference']),
  shred: new Set(['-n', '-s', '--iterations', '--size']),
  mv: new Set(['-t', '-S', '--target-directory', '--suffix']),
  cp: new Set(['-t', '-S', '--target-directory', '--suffix']),
  ln: new Set(['-t', '-S', '--target-directory', '--suffix']),
  install: new Set(['-t', '-S', '-m', '-o', '-g', '--target-directory', '--suffix', '--mode', '--owner', '--group']),
  rsync: new Set(['-e', '--rsh', '--exclude', '--include', '--filter', '-f']),
  sed: new Set(['-e', '-f', '--expression', '--file', '-l', '--line-length']),
  perl: new Set(['-e', '-E', '-M', '-I']),
}
const NO_VALUED: ReadonlySet<string> = new Set()
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const SHELL_COMMAND_FLAG = /^-[a-zA-Z]*c[a-zA-Z]*$/
/** Commands that run the command after their own options, and those options that take a value. */
const WRAPPERS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-T', '-U', '--user', '--group', '--host', '--prompt', '--chdir']),
  doas: new Set(['-u', '-C']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n', '-p', '--class', '--classdata']),
  stdbuf: new Set(['-i', '-o', '-e']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
}

/** The paths one simple command (`argv`) writes, by what the command is; a nested `sh -c` script is read too. */
const writesOf = (argv: readonly string[]): { path: string; via: string; cdChain?: readonly string[] }[] => {
  const name = (argv[0] ?? '').replace(/^.*\//, '')
  const args = argv.slice(1)
  const list = operands(withoutOptionValues(args, VALUED_OPTIONS[name] ?? NO_VALUED))
  const each = (paths: readonly string[], via = name) => paths.map(path => ({ path, via }))

  switch (name) {
    case 'tee':
    case 'rm':
    case 'rmdir':
    case 'unlink':
    case 'touch':
    case 'mkdir':
    case 'truncate':
    case 'shred':
      return each(list)
    case 'mv': {
      // A move writes its destination and removes its sources: every operand counts.
      const directory = targetDirectory(args)
      return each([...list, ...(directory === undefined ? [] : [directory])])
    }
    case 'cp':
    case 'ln':
    case 'install': {
      const directory = targetDirectory(args)
      if (directory !== undefined) return each([directory])
      return list.length >= 2 ? each([list[list.length - 1] as string]) : []
    }
    case 'rsync': {
      const destination = list.length >= 2 ? (list[list.length - 1] as string) : undefined
      // `host:path` is a remote destination, not a local write.
      return destination === undefined || /^[^/]*:/.test(destination) ? [] : each([destination])
    }
    case 'dd':
      return each(args.filter(arg => arg.startsWith('of=')).map(arg => arg.slice(3)))
    case 'sed':
    case 'perl': {
      const isInPlace = args.some(arg => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith('--in-place'))
      if (!isInPlace) return []
      const hasScriptOption = args.some(arg => ['-e', '-E', '-f', '--expression', '--file'].includes(arg))
      return each(hasScriptOption ? list : list.slice(1))
    }
    case 'chmod':
    case 'chown':
    case 'chgrp':
      return each(list.slice(1))
    case 'find': {
      if (!args.includes('-delete')) return []
      const starts: string[] = []
      for (const arg of args) {
        if (arg.startsWith('-') || arg === '(' || arg === '!') break
        starts.push(arg)
      }
      return each(starts.length === 0 ? ['.'] : starts)
    }
    default: {
      if (!SHELLS.has(name)) return []
      // `-c`, or `-c` grouped with other short options: `bash -lc`, `sh -ec`.
      const flag = args.findIndex(arg => SHELL_COMMAND_FLAG.test(arg))
      const script = flag === -1 ? undefined : args[flag + 1]
      return script === undefined ? [] : writeTargets(script)
    }
  }
}

/** Every path `command` would write to, with the `cd`s that precede it on the line. */
export const writeTargets = (command: string): WriteTarget[] => {
  const tokens = tokenize(command)
  const targets: WriteTarget[] = []
  const cdChain: string[] = []
  let argv: string[] = []
  let isRedirectTarget: Redirect | undefined

  const flush = (): void => {
    let start = 0
    for (let previous = -1; previous !== start; ) {
      previous = start
      while (start < argv.length && (PREFIX_WORDS.has(argv[start] as string) || ASSIGNMENT.test(argv[start] as string))) start += 1
      if (argv[start] === 'env') {
        start += 1
        while (start < argv.length && (ASSIGNMENT.test(argv[start] as string) || (argv[start] as string).startsWith('-'))) start += 1
      }
      // `sudo -u root rm …`, `timeout 5 rm …`, `nice -n 5 rm …`: skip the wrapper's own options to reach the command.
      const valued = WRAPPERS[argv[start] ?? '']
      if (valued !== undefined) {
        const wrapper = argv[start]
        start += 1
        while (start < argv.length && (argv[start] as string).startsWith('-')) start += valued.has(argv[start] as string) ? 2 : 1
        if (wrapper === 'timeout' && start < argv.length) start += 1
      }
    }
    const simple = argv.slice(start)
    if (simple[0] === 'cd' || simple[0] === 'pushd') {
      const directory = operands(simple.slice(1))[0]
      cdChain.push(directory ?? '~')
    } else {
      for (const write of writesOf(simple)) {
        targets.push({ path: write.path, via: write.via, cdChain: [...cdChain, ...(write.cdChain ?? [])] })
      }
    }
    argv = []
  }

  for (const token of tokens) {
    if (isRedirectTarget !== undefined) {
      if (token.kind === 'word') {
        if (isRedirectTarget.isWrite && !SAFE_DEVICES.test(token.text)) {
          targets.push({ path: token.text, via: isRedirectTarget.text, cdChain: [...cdChain] })
        }
        isRedirectTarget = undefined
        continue
      }
      isRedirectTarget = undefined
    }
    if (token.kind === 'redirect') {
      isRedirectTarget = token.isHeredoc ? undefined : token
      continue
    }
    if (token.kind === 'op') {
      if (SEPARATORS.has(token.text)) flush()
      continue
    }
    argv.push(token.text)
    for (const body of substitutionBodies(token.text)) {
      for (const nested of writeTargets(body)) targets.push({ ...nested, cdChain: [...cdChain, ...nested.cdChain] })
    }
  }
  flush()
  return targets
}

/** The commands inside `$(...)` and backticks of a word, which run before the word is used. */
const substitutionBodies = (word: string): string[] => {
  const bodies: string[] = []
  for (let i = 0; i < word.length; i += 1) {
    if (word[i] === '`') {
      const end = word.indexOf('`', i + 1)
      if (end === -1) break
      bodies.push(word.slice(i + 1, end))
      i = end
    } else if (word[i] === '$' && word[i + 1] === '(') {
      let depth = 0
      let end = i + 1
      for (; end < word.length; end += 1) {
        if (word[end] === '(') depth += 1
        else if (word[end] === ')' && --depth === 0) break
      }
      bodies.push(word.slice(i + 2, end))
      i = end
    }
  }
  return bodies
}

/**
 * A Git Bash / MSYS / Cygwin drive path (`/c/Users`, `/cygdrive/c/Users`) as
 * Windows spells it (`C:\Users`). Only for a jail on Windows paths: there,
 * `/c/...` names drive C, not a folder `c` at the root of the current drive.
 */
export const fromGitBash = (path: string): string =>
  path.replace(/^\/(?:cygdrive\/)?([A-Za-z])(?:\/|$)/, (_match, drive: string) => `${drive.toUpperCase()}:\\`)
