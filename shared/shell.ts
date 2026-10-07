/**
 * shared/shell.ts — one conservative shell reader for every guard.
 *
 * Extracted from the best of the existing readers:
 *   - mods/path-jail/hooks/bash.ts        the tokenizer (quotes, escapes, `$(...)`, backticks, comments,
 *                                         fd duplication, heredocs) and the wrapper table (sudo, timeout, nice, ...)
 *   - mods/curl-pipe-guard/hooks/pipes.ts pipelines and the nesting of `bash -c "…"` / `eval "…"` (depth 3)
 *   - mods/offline-mode/hooks/network.ts  `xargs`, `builtin`, `exec` as wrappers (`xargs rm` reads as `rm`)
 * and extended: heredoc and here-string bodies fed to a shell are read as scripts too.
 *
 * It reads text; it never runs anything. A shell is Turing complete, so this is best effort and
 * errs on the side of finding MORE commands (a guard over-reading is safer than one under-reading).
 * Pure: no `$`, no I/O. Vendored into mods by scripts/sync-shared.mjs.
 */

export type ShellWord = { kind: 'word'; text: string }
export type ShellOp = { kind: 'op'; text: string }
export type ShellRedirect = {
  kind: 'redirect'
  /** The operator as written: `>`, `>>`, `<`, `&>`, `<<`, `<<-`, `<<<`, ... */
  text: string
  isWrite: boolean
  isHeredoc: boolean
  /** A heredoc's body (the lines up to its delimiter); undefined for every other redirect. */
  body?: string
}
export type ShellToken = ShellWord | ShellOp | ShellRedirect

/** One simple command of a line, its wrappers (sudo, env, timeout, ...) and assignments removed. */
export type ShellCommand = {
  /** The command and its arguments, quotes resolved. `argv[0]` may be a path (`/bin/rm`). */
  argv: string[]
  /** `argv[0]`'s base name, lowercased (`/usr/bin/RM` → `rm`). */
  name: string
  /** Redirections of this command: operator and target (`>` `out.txt`); heredocs have no target. */
  redirects: { op: string; target: string }[]
  /** The wrappers that were peeled off, outermost first (`['sudo', 'timeout']`). */
  wrappers: string[]
  /** Which pipeline of the line it is in, and its place in that pipeline (0 = first stage). */
  pipeline: number
  stage: number
  /** 0 for the line itself; 1+ inside `bash -c`, `eval`, `$(...)`, backticks or a heredoc fed to a shell. */
  depth: number
  /** How a nested command was reached: `sh -c`, `eval`, `$()`, `heredoc`; absent at depth 0. */
  via?: 'sh -c' | 'eval' | '$()' | 'heredoc'
}

export const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'csh', 'tcsh', 'mksh', 'busybox'])
/** How deep `bash -c "…"`, `eval "…"` and substitutions are opened up. */
export const MAX_NESTING = 3

const SEPARATORS = new Set(['&&', '||', ';', '&', '\n', '(', ')', '{', '}'])
const PIPES = new Set(['|', '|&'])
const PREFIX_WORDS = new Set(['command', 'builtin', 'nohup', 'time', 'exec', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', 'noglob'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/
const SHELL_COMMAND_FLAG = /^-[a-zA-Z]*c[a-zA-Z]*$/
/** Commands that run the command after their own options, and those options that take a value. */
const WRAPPERS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-T', '-U', '--user', '--group', '--host', '--prompt', '--chdir']),
  doas: new Set(['-u', '-C']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n', '-p', '--class', '--classdata']),
  stdbuf: new Set(['-i', '-o', '-e']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  env: new Set(['-u', '-C', '-S', '--unset', '--chdir', '--split-string']),
  xargs: new Set(['-I', '-i', '-L', '-n', '-P', '-s', '-d', '-E', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file', '--replace']),
  chronic: new Set(),
  caffeinate: new Set(['-t', '-w']),
  watch: new Set(['-n', '-d', '--interval']),
}

/** Splits a command line into words, separators and redirections, honouring quotes, escapes and heredocs. */
export function tokenize(command: string): ShellToken[] {
  const tokens: ShellToken[] = []
  const heredocs: { token: ShellRedirect; delimiter: string; stripTabs: boolean }[] = []
  let word = ''
  let hasWord = false
  let i = 0

  const pushWord = (): void => {
    if (hasWord) tokens.push({ kind: 'word', text: word })
    word = ''
    hasWord = false
  }

  /** Reads the heredoc bodies that start after the newline at `i`, and keeps each on its redirect. */
  const readHeredocs = (): void => {
    while (heredocs.length > 0) {
      const { token, delimiter, stripTabs } = heredocs.shift() as { token: ShellRedirect; delimiter: string; stripTabs: boolean }
      const lines: string[] = []
      while (i < command.length) {
        const end = command.indexOf('\n', i)
        const line = command.slice(i, end === -1 ? command.length : end)
        i = end === -1 ? command.length : end + 1
        const bare = stripTabs ? line.replace(/^\t+/, '') : line
        if (bare === delimiter) break
        lines.push(bare)
      }
      token.body = lines.join('\n')
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
    if (char === '$' && next === "'") {
      // ANSI-C quoting: $'…', its escapes kept as written (good enough to read words).
      const end = command.indexOf("'", i + 2)
      const stop = end === -1 ? command.length : end
      word += command.slice(i + 2, stop)
      hasWord = true
      i = stop + 1
      continue
    }
    if (char === '"') {
      i += 1
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < command.length && '"\\$`\n'.includes(command[i + 1] as string)) i += 1
        word += command[i]
        i += 1
      }
      hasWord = true
      i += 1
      continue
    }
    if (char === '$' && next === '(') {
      // Keep a command substitution whole inside the word: its contents are not this line's separators.
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
      readHeredocs()
      continue
    }
    if (char === ' ' || char === '\t' || char === '\r') {
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
      const op = /^(?:&>>|&>|>>|>\||>&|>|<<<|<<-|<<|<&|<>|<)/.exec(command.slice(i))?.[0] ?? char
      i += op.length
      if ((op === '>&' || op === '<&') && /^\s*(?:\d+|-)(?![\w./])/.test(command.slice(i))) {
        // File-descriptor duplication (`2>&1`, `>&-`): no file is involved.
        i += (/^\s*(?:\d+|-)/.exec(command.slice(i))?.[0] ?? '').length
        continue
      }
      const isHeredoc = op === '<<' || op === '<<-'
      const token: ShellRedirect = { kind: 'redirect', text: op, isWrite: op.includes('>'), isHeredoc }
      tokens.push(token)
      if (isHeredoc) {
        const match = /^\s*(['"]?)([^\s'";&|<>]+)\1/.exec(command.slice(i))
        if (match !== null) {
          heredocs.push({ token, delimiter: match[2] as string, stripTabs: op === '<<-' })
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
  // A heredoc whose body never started (no newline after it) has an empty body.
  for (const pending of heredocs) pending.token.body = ''
  return tokens
}

/** The base name of a word, lowercased: `/usr/bin/RM` → `rm`. */
export function baseName(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1).toLowerCase()
}

/** Peels wrappers (sudo, env, timeout, nice, xargs, ...), prefix words and `VAR=x` assignments off an argv. */
export function unwrap(argv: readonly string[]): { argv: string[]; wrappers: string[] } {
  const wrappers: string[] = []
  let start = 0
  for (let previous = -1; previous !== start; ) {
    previous = start
    while (start < argv.length && (PREFIX_WORDS.has(argv[start] as string) || ASSIGNMENT.test(argv[start] as string))) start += 1
    const name = baseName(argv[start] ?? '')
    const valued = WRAPPERS[name]
    if (valued === undefined) continue
    wrappers.push(name)
    start += 1
    while (start < argv.length) {
      const arg = argv[start] as string
      if (name === 'env' && ASSIGNMENT.test(arg)) start += 1
      else if (arg === '--') {
        start += 1
        break
      } else if (arg.startsWith('-') && arg !== '-') start += valued.has(arg) ? 2 : 1
      else break
    }
    // `timeout 5 cmd`, `watch -n 2 cmd`: timeout's duration is its first operand.
    if (name === 'timeout' && start < argv.length) start += 1
  }
  return { argv: argv.slice(start), wrappers }
}

/** The commands inside `$(...)` and backticks of a word, which run before the word is used. */
export function substitutionBodies(word: string): string[] {
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

/** The script a shell runs from `-c`, or undefined (`bash -lc "…"`, `sh -ec '…'`). */
export function shellScriptArg(argv: readonly string[]): string | undefined {
  if (!SHELLS.has(baseName(argv[0] ?? ''))) return undefined
  const flag = argv.findIndex((arg, at) => at > 0 && SHELL_COMMAND_FLAG.test(arg))
  return flag === -1 ? undefined : argv[flag + 1]
}

/** Whether a shell argv reads its program from standard input (no `-c`, no script file). */
export function shellReadsStdin(argv: readonly string[]): boolean {
  if (!SHELLS.has(baseName(argv[0] ?? ''))) return false
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i] as string
    if (arg === '-s' || arg === '-') return true
    if (SHELL_COMMAND_FLAG.test(arg)) return false
    if (arg === '-o' || arg === '+o') i += 1
    else if (!arg.startsWith('-') && !arg.startsWith('+')) return false
  }
  return true
}

/**
 * Every simple command a line would run, in order: pipelines and lists split, wrappers peeled,
 * and the scripts handed to `bash -c`, `eval`, `xargs`, `$(...)`, backticks and heredocs read too
 * (up to MAX_NESTING deep). Never throws.
 */
export function simpleCommands(command: string, depth = 0, via?: ShellCommand['via']): ShellCommand[] {
  const out: ShellCommand[] = []
  let words: string[] = []
  let redirects: { op: string; target: string }[] = []
  let heredocBodies: string[] = []
  let pendingRedirect: ShellRedirect | undefined
  let pipeline = 0
  let stage = 0

  const nested = (script: string, how: ShellCommand['via']): void => {
    if (depth >= MAX_NESTING || script.trim() === '') return
    out.push(...simpleCommands(script, depth + 1, how))
  }

  const flush = (): void => {
    const { argv, wrappers } = unwrap(words)
    if (argv.length > 0 || redirects.length > 0) {
      const name = baseName(argv[0] ?? '')
      out.push({ argv, name, redirects, wrappers, pipeline, stage, depth, ...(via === undefined ? {} : { via }) })
      const script = shellScriptArg(argv)
      if (script !== undefined) nested(script, 'sh -c')
      if (name === 'eval') nested(argv.slice(1).join(' '), 'eval')
      if (shellReadsStdin(argv)) for (const body of heredocBodies) nested(body, 'heredoc')
    }
    words = []
    redirects = []
    heredocBodies = []
    pendingRedirect = undefined
  }

  for (const token of tokenize(command)) {
    if (pendingRedirect !== undefined) {
      if (token.kind === 'word') {
        redirects.push({ op: pendingRedirect.text, target: token.text })
        if (pendingRedirect.text === '<<<') heredocBodies.push(token.text)
        for (const body of substitutionBodies(token.text)) nested(body, '$()')
        pendingRedirect = undefined
        continue
      }
      pendingRedirect = undefined
    }
    if (token.kind === 'redirect') {
      if (token.isHeredoc) {
        redirects.push({ op: token.text, target: '' })
        if (token.body !== undefined) heredocBodies.push(token.body)
      } else {
        pendingRedirect = token
      }
      continue
    }
    if (token.kind === 'op') {
      if (PIPES.has(token.text)) {
        flush()
        stage += 1
      } else if (SEPARATORS.has(token.text)) {
        flush()
        pipeline += 1
        stage = 0
      }
      continue
    }
    words.push(token.text)
    for (const body of substitutionBodies(token.text)) nested(body, '$()')
  }
  flush()
  return out
}

/** The names of every command a line would run (nested ones included), deduplicated. */
export function commandNames(command: string): string[] {
  return [...new Set(simpleCommands(command).map(cmd => cmd.name).filter(name => name !== ''))]
}

/** Operands of an argv (options and `--` dropped): `rm -rf -- a b` → `['a', 'b']`. */
export function operands(args: readonly string[]): string[] {
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
