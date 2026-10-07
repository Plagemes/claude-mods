// Pure shell reading for scope-lock: the files a Bash command line would write, with the `cd`s
// before them. Best effort and conservative: a shell is a programming language. No `$` here.

/** One path a command would write, and the `cd` arguments in effect before it, in order. */
export type WriteTarget = { path: string; via: string; cdChain: readonly string[] }

type Token = { kind: 'word'; text: string } | { kind: 'op'; text: string } | { kind: 'redirect'; text: string; isWrite: boolean }

const SEPARATORS = new Set([';', '&&', '||', '|', '|&', '&', '\n', '(', ')'])
const PREFIXES = new Set(['sudo', 'command', 'builtin', 'nohup', 'time', 'exec', 'nice', 'then', 'do', 'else', 'if', 'while', 'until', '!', '{', '}'])
const ASSIGNMENT = /^[A-Za-z_]\w*=/
const SAFE_DEVICE = /^\/dev\/(?:null|zero|stdout|stderr|stdin|tty|fd\/\d+)$/
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const PLAIN_WRITERS = new Set(['tee', 'rm', 'rmdir', 'unlink', 'touch', 'mkdir', 'truncate', 'shred'])
const COPIERS = new Set(['cp', 'ln', 'install', 'rsync'])
const OWNERSHIP = new Set(['chmod', 'chown', 'chgrp'])
/** Options that take the next word as their value, so it is not read as a path. */
const VALUED: Record<string, ReadonlySet<string>> = {
  touch: new Set(['-r', '-d', '-t']),
  mkdir: new Set(['-m']),
  truncate: new Set(['-s', '-r']),
  cp: new Set(['-t', '-S']),
  mv: new Set(['-t', '-S']),
  ln: new Set(['-t', '-S']),
  install: new Set(['-t', '-m', '-o', '-g', '-S']),
  rsync: new Set(['-e', '--exclude', '--include', '-f']),
  sed: new Set(['-e', '-f', '-l']),
  perl: new Set(['-e', '-E', '-M', '-I']),
}

/** The text up to the `)` closing the `$(` at `start`, and where it ends. */
const substitution = (command: string, start: number): { body: string; end: number } => {
  let depth = 0
  for (let i = start + 1; i < command.length; i += 1) {
    if (command[i] === '(') depth += 1
    else if (command[i] === ')' && --depth === 0) return { body: command.slice(start + 2, i), end: i }
  }
  return { body: command.slice(start + 2), end: command.length - 1 }
}

/** Words, separators and redirections; `$(…)` and backtick bodies are returned to be read as commands too. */
const tokenize = (command: string): { tokens: Token[]; nested: string[] } => {
  const tokens: Token[] = []
  const nested: string[] = []
  const heredocs: { delimiter: string; stripTabs: boolean }[] = []
  let word = ''
  let hasWord = false
  const push = () => {
    if (hasWord) tokens.push({ kind: 'word', text: word })
    word = ''
    hasWord = false
  }
  for (let i = 0; i < command.length; ) {
    const char = command[i] as string
    const next = command[i + 1] ?? ''
    if (char === '\\' && next !== '') {
      if (next !== '\n') word += next
      hasWord ||= next !== '\n'
      i += 2
    } else if (char === "'") {
      const end = command.indexOf("'", i + 1)
      const stop = end === -1 ? command.length : end
      word += command.slice(i + 1, stop)
      hasWord = true
      i = stop + 1
    } else if (char === '$' && next === '(') {
      const { body, end } = substitution(command, i)
      nested.push(body)
      word += command.slice(i, end + 1)
      hasWord = true
      i = end + 1
    } else if (char === '`') {
      const end = command.indexOf('`', i + 1)
      const stop = end === -1 ? command.length : end
      nested.push(command.slice(i + 1, stop))
      word += command.slice(i, stop + 1)
      hasWord = true
      i = stop + 1
    } else if (char === '"') {
      i += 1
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < command.length) i += 1
        else if (command[i] === '$' && command[i + 1] === '(') {
          const { body, end } = substitution(command, i)
          nested.push(body)
          word += command.slice(i, end + 1)
          i = end + 1
          continue
        }
        word += command[i]
        i += 1
      }
      hasWord = true
      i += 1
    } else if (char === '#' && !hasWord) {
      while (i < command.length && command[i] !== '\n') i += 1
    } else if (char === '\n') {
      push()
      tokens.push({ kind: 'op', text: '\n' })
      i += 1
      // Heredoc bodies start after the newline that ends their command.
      while (heredocs.length > 0) {
        const { delimiter, stripTabs } = heredocs.shift() as { delimiter: string; stripTabs: boolean }
        while (i < command.length) {
          const end = command.indexOf('\n', i)
          const line = command.slice(i, end === -1 ? command.length : end)
          i = end === -1 ? command.length : end + 1
          if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) break
        }
      }
    } else if (char === ' ' || char === '\t') {
      push()
      i += 1
    } else if (char === '>' || char === '<' || (char === '&' && next === '>')) {
      if (/^\d+$/.test(word)) {
        word = ''
        hasWord = false
      }
      push()
      const op = /^(?:&>>|&>|>>|>\||>&|>|<<<|<<-|<<|<&|<>|<)/.exec(command.slice(i))?.[0] ?? char
      i += op.length
      const duplicate = /^\s*(?:\d+|-)(?![\w./])/.exec(command.slice(i))
      if ((op === '>&' || op === '<&') && duplicate !== null) {
        i += duplicate[0].length
        continue
      }
      if (op === '<<' || op === '<<-') {
        const delimiter = /^\s*(['"]?)([^\s'";&|<>]+)\1/.exec(command.slice(i))
        if (delimiter !== null) {
          heredocs.push({ delimiter: delimiter[2] as string, stripTabs: op === '<<-' })
          i += delimiter[0].length
        }
        continue
      }
      tokens.push({ kind: 'redirect', text: op, isWrite: op.includes('>') })
    } else if (['&&', '||', '|&', ';;'].includes(char + next)) {
      push()
      tokens.push({ kind: 'op', text: char + next === ';;' ? ';' : char + next })
      i += 2
    } else if (';|&()'.includes(char)) {
      push()
      tokens.push({ kind: 'op', text: char })
      i += 1
    } else {
      word += char
      hasWord = true
      i += 1
    }
  }
  push()
  return { tokens, nested }
}

const operandsOf = (name: string, args: readonly string[]): string[] => {
  const valued = VALUED[name]
  const operands: string[] = []
  let isOptionsDone = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string
    if (!isOptionsDone && arg === '--') isOptionsDone = true
    else if (!isOptionsDone && arg.startsWith('-') && arg !== '-') {
      if (valued?.has(arg)) i += 1
    } else operands.push(arg)
  }
  return operands
}

const targetDirectory = (args: readonly string[]): string | undefined => {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string
    if (arg === '-t' || arg === '--target-directory') return args[i + 1]
    if (arg.startsWith('--target-directory=')) return arg.slice('--target-directory='.length)
  }
  return undefined
}

/** The paths one simple command writes. */
const writesOf = (argv: readonly string[]): { path: string; via: string }[] => {
  const name = (argv[0] ?? '').replace(/^.*\//, '')
  const args = argv.slice(1)
  const operands = operandsOf(name, args)
  const each = (paths: readonly string[], via = name) => paths.map(path => ({ path, via }))
  if (PLAIN_WRITERS.has(name)) return each(operands)
  if (name === 'mv') return each([...operands, ...[targetDirectory(args)].filter((dir): dir is string => dir !== undefined)])
  if (COPIERS.has(name)) {
    const directory = targetDirectory(args)
    if (directory !== undefined) return each([directory])
    const destination = operands.length >= 2 ? (operands[operands.length - 1] as string) : undefined
    return destination === undefined || (name === 'rsync' && /^[^/]*:/.test(destination)) ? [] : each([destination])
  }
  if (name === 'dd') return each(args.filter(arg => arg.startsWith('of=')).map(arg => arg.slice(3)))
  if (name === 'sed' || name === 'perl') {
    if (!args.some(arg => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith('--in-place'))) return []
    const hasScriptOption = args.some(arg => ['-e', '-E', '-f', '--expression', '--file'].includes(arg))
    return each(hasScriptOption ? operands : operands.slice(1))
  }
  if (OWNERSHIP.has(name)) return each(operands.slice(1))
  if (name === 'find' && args.includes('-delete')) {
    const starts = args.slice(0, Math.max(0, args.findIndex(arg => arg.startsWith('-') || arg === '(' || arg === '!')))
    return each(starts.length === 0 ? ['.'] : starts)
  }
  if (name === 'git') {
    const [sub = '', ...rest] = args.filter(arg => !/^-C$|^-c$/.test(arg))
    const files = operandsOf('git', rest)
    if (sub === 'rm' || sub === 'mv' || sub === 'restore') return each(files, `git ${sub}`)
    if (sub === 'checkout' && rest.includes('--')) return each(rest.slice(rest.indexOf('--') + 1), 'git checkout')
    if ((sub === 'clean' && rest.some(arg => /^-[a-zA-Z]*f/.test(arg))) || (sub === 'reset' && rest.includes('--hard')) || sub === 'stash') {
      return each(['.'], `git ${sub}`)
    }
    return []
  }
  if (SHELLS.has(name) && args.includes('-c')) {
    const script = args[args.indexOf('-c') + 1]
    return script === undefined ? [] : writeTargets(script).map(target => ({ path: target.path, via: target.via }))
  }
  return []
}

/** Every path `command` would write, with the `cd`s that precede it on the line. */
export const writeTargets = (command: string): WriteTarget[] => {
  const { tokens, nested } = tokenize(command)
  const targets: WriteTarget[] = []
  const cdChain: string[] = []
  let argv: string[] = []
  let pending: Extract<Token, { kind: 'redirect' }> | undefined
  const flush = () => {
    let start = 0
    while (start < argv.length && (PREFIXES.has(argv[start] as string) || ASSIGNMENT.test(argv[start] as string))) start += 1
    if (argv[start] === 'env') {
      start += 1
      while (start < argv.length && (ASSIGNMENT.test(argv[start] as string) || (argv[start] as string).startsWith('-'))) start += 1
    }
    const simple = argv.slice(start)
    if (simple[0] === 'cd' || simple[0] === 'pushd') cdChain.push(operandsOf('cd', simple.slice(1))[0] ?? '~')
    else for (const write of writesOf(simple)) targets.push({ ...write, cdChain: [...cdChain] })
    argv = []
  }
  for (const token of tokens) {
    if (pending !== undefined) {
      if (token.kind === 'word' && pending.isWrite && !SAFE_DEVICE.test(token.text)) targets.push({ path: token.text, via: pending.text, cdChain: [...cdChain] })
      pending = undefined
      if (token.kind === 'word') continue
    }
    if (token.kind === 'redirect') pending = token
    else if (token.kind === 'op') {
      if (SEPARATORS.has(token.text)) flush()
    } else argv.push(token.text)
  }
  flush()
  for (const body of nested) targets.push(...writeTargets(body))
  return targets
}
