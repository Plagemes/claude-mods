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

/**
 * A word, quotes resolved; `start`/`end` are its offsets in the text read (quotes included), so it can be rewritten.
 * `substitutions` are the bodies of the `$(…)` and backticks the shell would run for it: bare or inside double
 * quotes, never inside single quotes, `$'…'` or after a backslash (`echo '$(rm a)'` runs nothing).
 */
export type ShellWord = { kind: 'word'; text: string; start: number; end: number; substitutions: string[] }
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
  /**
   * Where each argv word is in the text that was read (quotes included), for guards that rewrite a word. At depth 0
   * that is the line itself; deeper, it is the nested script, so only depth-0 spans can be applied to the line.
   */
  spans: { start: number; end: number }[]
  /** `argv[0]`'s base name, lowercased (`/usr/bin/RM` → `rm`). */
  name: string
  /** Redirections of this command: operator and target (`>` `out.txt`); heredocs have no target. */
  redirects: { op: string; target: string }[]
  /** The wrappers that were peeled off, outermost first (`['sudo', 'timeout']`). */
  wrappers: string[]
  /** `NAME=value` words peeled off (in front of the command, and `env`'s), later ones winning: `{ RAILS_ENV: 'test' }`. */
  assignments: Record<string, string>
  /**
   * Which pipeline it is in, and its place in that pipeline (0 = first stage). Pipeline numbers are unique
   * across the whole result, nested scripts included, so commands of two different `bash -c` scripts never
   * share one: `commands.filter(c => c.pipeline === cmd.pipeline)` is exactly cmd's pipeline.
   */
  pipeline: number
  stage: number
  /**
   * Sent to the background with `&` (`npm run dev &`): every stage of that pipeline, and what it runs inside
   * (its `bash -c` script, its substitutions), does not hold the line.
   */
  isBackground: boolean
  /** 0 for the line itself; 1+ inside `bash -c`, `eval`, `$(...)`, backticks or a heredoc fed to a shell. */
  depth: number
  /** How a nested command was reached: `sh -c`, `eval`, `$()`, `heredoc`; absent at depth 0. */
  via?: 'sh -c' | 'eval' | '$()' | 'heredoc'
  /**
   * Which script it was read from: 0 for the line itself, a new number for each nested script (each `bash -c`,
   * `$(…)`, heredoc), so the commands of one nested script can be told from a sibling's.
   */
  script: number
}

export const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'csh', 'tcsh', 'mksh', 'busybox'])
/** How deep `bash -c "…"`, `eval "…"` and substitutions are opened up. */
export const MAX_NESTING = 3

const SEPARATORS = new Set(['&&', '||', ';', '&', '\n', '(', ')', '{', '}'])
const PIPES = new Set(['|', '|&'])
const PREFIX_WORDS = new Set(['command', 'builtin', 'nohup', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', 'noglob'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/
const SHELL_COMMAND_FLAG = /^-[a-zA-Z]*c[a-zA-Z]*$/
/** Programs that run a command string as another user: `su -c '…' root`, `runuser -l app -c '…'`. */
const USER_SWITCHERS: ReadonlySet<string> = new Set(['su', 'runuser'])
/** Commands that run the command after their own options, and those options that take a value. */
const WRAPPERS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-T', '-U', '--user', '--group', '--host', '--prompt', '--chdir']),
  doas: new Set(['-u', '-C']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n', '-p', '--class', '--classdata']),
  stdbuf: new Set(['-i', '-o', '-e']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  env: new Set(['-u', '-C', '-S', '--unset', '--chdir', '--split-string']),
  xargs: new Set(['-I', '-i', '-L', '-n', '-P', '-s', '-d', '-E', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file', '--replace', '--max-lines']),
  /** The shell keyword and GNU time (`time -f '%e' -o t.txt cmd`). */
  time: new Set(['-f', '-o', '--format', '--output']),
  exec: new Set(['-a']),
  chronic: new Set(),
  setsid: new Set(),
  caffeinate: new Set(['-t', '-w']),
  watch: new Set(['-n', '-d', '--interval']),
}

/** The escapes `$'…'` decodes when reading a word (`$'a\tb'`); any other is kept as written. */
const ANSI_C_ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', "'": "'", '"': '"', '\\': '\\', e: '\u001b', E: '\u001b', a: '\u0007', b: '\b', f: '\f', v: '\v' }

/** Splits a command line into words, separators and redirections, honouring quotes, escapes and heredocs. */
export function tokenize(command: string): ShellToken[] {
  const tokens: ShellToken[] = []
  const heredocs: { token: ShellRedirect; delimiter: string; stripTabs: boolean }[] = []
  let word = ''
  let hasWord = false
  let wordStart = 0
  let substitutions: string[] = []
  let i = 0

  const pushWord = (): void => {
    // A line continuation right after the word (`origin\⏎ main`) is not part of it.
    let end = i
    while (end - 2 >= wordStart && command.slice(end - 2, end) === '\\\n') end -= 2
    if (hasWord) tokens.push({ kind: 'word', text: word, start: wordStart, end, substitutions })
    word = ''
    hasWord = false
    substitutions = []
  }
  /** The `$(…)` starting at `i`, kept whole in the word and its body noted; leaves `i` past its `)`. */
  const readDollarParen = (): void => {
    let depth = 0
    const start = i
    for (; i < command.length; i += 1) {
      if (command[i] === '(') depth += 1
      else if (command[i] === ')' && --depth === 0) break
    }
    word += command.slice(start, i + 1)
    substitutions.push(command.slice(start + 2, i))
    i += 1
  }
  /** The backtick substitution starting at `i`, kept whole and its body noted; leaves `i` past its closing backtick. */
  const readBackticks = (): void => {
    const end = command.indexOf('`', i + 1)
    const stop = end === -1 ? command.length : end
    word += command.slice(i, stop + 1)
    if (end !== -1) substitutions.push(command.slice(i + 1, end))
    i = stop + 1
  }
  /** The current word has content from `at` on (its first piece starts the word). */
  const mark = (at: number): void => {
    if (!hasWord) wordStart = at
    hasWord = true
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
    const at = i

    if (char === '\\' && next !== '') {
      if (next !== '\n') {
        word += next
        mark(at)
      }
      i += 2
      continue
    }
    if (char === "'") {
      const end = command.indexOf("'", i + 1)
      const stop = end === -1 ? command.length : end
      word += command.slice(i + 1, stop)
      mark(at)
      i = stop + 1
      continue
    }
    if (char === '$' && next === "'") {
      // ANSI-C quoting: $'…' expands nothing; `\'` does not end it; common escapes are decoded, others kept as written.
      i += 2
      while (i < command.length && command[i] !== "'") {
        if (command[i] === '\\' && i + 1 < command.length) {
          const escaped = command[i + 1] as string
          word += ANSI_C_ESCAPES[escaped] ?? `\\${escaped}`
          i += 2
          continue
        }
        word += command[i]
        i += 1
      }
      mark(at)
      i += 1
      continue
    }
    if (char === '"') {
      i += 1
      while (i < command.length && command[i] !== '"') {
        // Substitutions run inside double quotes too; an escaped `\$` or `\`` is a plain character.
        if (command[i] === '$' && command[i + 1] === '(') {
          readDollarParen()
          continue
        }
        if (command[i] === '`') {
          readBackticks()
          continue
        }
        if (command[i] === '\\' && i + 1 < command.length && '"\\$`\n'.includes(command[i + 1] as string)) i += 1
        word += command[i]
        i += 1
      }
      mark(at)
      i += 1
      continue
    }
    if (char === '$' && next === '(') {
      // Keep a command substitution whole inside the word: its contents are not this line's separators.
      readDollarParen()
      mark(at)
      continue
    }
    if (char === '`') {
      readBackticks()
      mark(at)
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
    mark(at)
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
export function unwrap(argv: readonly string[]): { argv: string[]; wrappers: string[]; assignments: Record<string, string> } {
  const wrappers: string[] = []
  const assignments: Record<string, string> = {}
  const assign = (word: string): void => {
    const at = word.indexOf('=')
    assignments[word.slice(0, word[at - 1] === '+' ? at - 1 : at)] = word.slice(at + 1)
  }
  let start = 0
  for (let previous = -1; previous !== start; ) {
    previous = start
    while (start < argv.length && (PREFIX_WORDS.has(argv[start] as string) || ASSIGNMENT.test(argv[start] as string))) {
      if (ASSIGNMENT.test(argv[start] as string)) assign(argv[start] as string)
      start += 1
    }
    const name = baseName(argv[start] ?? '')
    const valued = WRAPPERS[name]
    if (valued === undefined) continue
    wrappers.push(name)
    start += 1
    while (start < argv.length) {
      const arg = argv[start] as string
      if (name === 'env' && ASSIGNMENT.test(arg)) {
        assign(arg)
        start += 1
      } else if (arg === '--') {
        start += 1
        break
      } else if (arg.startsWith('-') && arg !== '-') start += valued.has(arg) ? 2 : 1
      else break
    }
    // `timeout 5 cmd`, `watch -n 2 cmd`: timeout's duration is its first operand.
    if (name === 'timeout' && start < argv.length) start += 1
  }
  return { argv: argv.slice(start), wrappers, assignments }
}

/**
 * The commands inside `$(...)` and backticks of raw shell text. A word from `tokenize` has had its quotes resolved,
 * so pass it whole: `substitutionBodies(token)` returns `token.substitutions`, which knows `'$(x)'` runs nothing.
 */
export function substitutionBodies(word: string | ShellWord): string[] {
  if (typeof word !== 'string') return word.substitutions
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

/** The script a shell runs from `-c`, or undefined (`bash -lc "…"`, `sh -ec '…'`, `su -c '…' root`). */
export function shellScriptArg(argv: readonly string[]): string | undefined {
  const name = baseName(argv[0] ?? '')
  if (USER_SWITCHERS.has(name)) {
    for (let i = 1; i < argv.length; i += 1) {
      const arg = argv[i] as string
      if (arg === '-c' || arg === '--command') return argv[i + 1]
      if (arg.startsWith('--command=')) return arg.slice('--command='.length)
    }
    return undefined
  }
  if (!SHELLS.has(name)) return undefined
  const flag = argv.findIndex((arg, at) => at > 0 && SHELL_COMMAND_FLAG.test(arg))
  return flag === -1 ? undefined : argv[flag + 1]
}

/**
 * Scripts handed to a shell further along an argv, which simpleCommands does not open because the shell is not
 * the command itself: `docker exec app sh -c '…'`, `kubectl exec pod -- bash -lc '…'`, `ssh host bash -c '…'`.
 * Opt-in for guards that would rather over-read (`echo bash -c "x"` reads `x` too).
 */
export function embeddedShellScripts(argv: readonly string[]): string[] {
  const scripts: string[] = []
  for (let at = 1; at < argv.length; at += 1) {
    if (!SHELLS.has(baseName(argv[at] as string))) continue
    const script = shellScriptArg(argv.slice(at))
    if (script !== undefined) scripts.push(script)
  }
  return scripts
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
  return readScript(command, depth, via, { pipelines: 0, scripts: 0 })
}

/** simpleCommands, with one pipeline and script counter shared by the line and every script nested in it. */
function readScript(command: string, depth: number, via: ShellCommand['via'], counter: { pipelines: number; scripts: number }): ShellCommand[] {
  const out: ShellCommand[] = []
  const script = counter.scripts
  counter.scripts += 1
  let words: string[] = []
  let spans: ShellCommand['spans'] = []
  let redirects: { op: string; target: string }[] = []
  let heredocBodies: string[] = []
  let pendingRedirect: ShellRedirect | undefined
  let pipeline = counter.pipelines
  counter.pipelines += 1
  /** Where the current pipeline's commands (and those nested in them) start in `out`; a `( … )` or `{ …; }` group counts as one. */
  let pipelineStart = 0
  const groupStarts: number[] = []
  let stage = 0

  const nested = (script: string, how: ShellCommand['via']): void => {
    if (depth >= MAX_NESTING || script.trim() === '') return
    out.push(...readScript(script, depth + 1, how, counter))
  }

  const flush = (): void => {
    const { argv, wrappers, assignments } = unwrap(words)
    if (argv.length > 0 || redirects.length > 0) {
      const name = baseName(argv[0] ?? '')
      const argvSpans = spans.slice(words.length - argv.length)
      out.push({ argv, spans: argvSpans, name, redirects, wrappers, assignments, pipeline, stage, isBackground: false, depth, ...(via === undefined ? {} : { via }), script })
      const handed = shellScriptArg(argv)
      if (handed !== undefined) nested(handed, 'sh -c')
      if (name === 'eval') nested(argv.slice(1).join(' '), 'eval')
      if (shellReadsStdin(argv)) for (const body of heredocBodies) nested(body, 'heredoc')
    }
    words = []
    spans = []
    redirects = []
    heredocBodies = []
    pendingRedirect = undefined
  }

  for (const token of tokenize(command)) {
    if (pendingRedirect !== undefined) {
      if (token.kind === 'word') {
        redirects.push({ op: pendingRedirect.text, target: token.text })
        if (pendingRedirect.text === '<<<') heredocBodies.push(token.text)
        for (const body of token.substitutions) nested(body, '$()')
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
        if (token.text === '&') for (const cmd of out.slice(pipelineStart)) cmd.isBackground = true
        if (token.text === '(' || token.text === '{') groupStarts.push(out.length)
        // After a group closes, a `&` sends the whole group to the background.
        pipelineStart = token.text === ')' || token.text === '}' ? (groupStarts.pop() ?? out.length) : out.length
        pipeline = counter.pipelines
        counter.pipelines += 1
        stage = 0
      }
      continue
    }
    words.push(token.text)
    spans.push({ start: token.start, end: token.end })
    for (const body of token.substitutions) nested(body, '$()')
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
