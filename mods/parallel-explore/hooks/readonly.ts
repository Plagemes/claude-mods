// The read-only rule for parallel-explore's explorers: which tools they may call, and which shell
// commands count as reading. A command line is read the way bash reads it (quotes, escapes,
// operators, redirections), then each program is checked for options or script text that write or
// run something. Whatever cannot be read with confidence is refused. No `$` here.

/** Tools an explorer may call; Bash is further held to read commands. Everything else is refused. */
export const READ_TOOLS: ReadonlySet<string> = new Set([
  'Read', 'Grep', 'Glob', 'LSP', 'Bash', 'WebFetch', 'WebSearch', 'ToolSearch', 'TodoWrite', 'TaskGet', 'TaskList',
  'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool',
])

/** Programs an explorer may run. Those with options or scripts that write or run something are checked below. */
const READ_PROGRAMS = new Set([
  'cd', 'pushd', 'popd', 'pwd', 'ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'fd', 'wc', 'sort', 'uniq',
  'cut', 'tr', 'awk', 'sed', 'jq', 'yq', 'tree', 'file', 'stat', 'du', 'echo', 'printf', 'basename', 'dirname', 'realpath', 'readlink',
  'which', 'type', 'nl', 'column', 'diff', 'cmp', 'true', 'test', '[', 'git', 'strings', 'od', 'hexdump', 'md5sum', 'sha256sum',
])
/** Programs with no option that writes or runs anything: a glob may start their arguments. */
const GLOB_SAFE = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'wc', 'cut', 'du', 'stat', 'nl', 'diff', 'cmp', 'strings', 'od', 'hexdump',
  'md5sum', 'sha256sum', 'echo', 'basename', 'dirname', 'realpath', 'readlink', 'jq', 'column',
])

type OptionRules = {
  /** Short option letters that write or run something, alone or in a cluster (`-uo`). */
  short?: string
  /** Long options that write or run something; their abbreviations count too. */
  long?: readonly string[]
  /** Real options that merely abbreviate a risky one. */
  exact?: readonly string[]
}
const OPTION_RULES: Readonly<Record<string, OptionRules>> = {
  rg: { long: ['pre', 'pre-glob', 'hostname-bin'] },
  ag: { long: ['pager'] },
  fd: { short: 'xX', long: ['exec', 'exec-batch'] },
  sort: { short: 'o', long: ['output', 'compress-program'] },
  tree: { short: 'oR', long: ['output'] },
  file: { short: 'C', long: ['compile'] },
  yq: { short: 'is', long: ['inplace', 'in-place', 'split-exp'] },
  printf: { short: 'v' },
}
const FIND_ACTIONS = /^-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/
const UNIQ_LONG_VALUE = /^--(?:skip-fields|skip-chars|check-chars)$/

const GIT_READS = new Set(['log', 'show', 'diff', 'grep', 'ls-files', 'ls-tree', 'blame', 'status', 'rev-parse', 'describe', 'shortlog', 'cat-file', 'branch', 'tag', 'remote'])
/** Global options allowed before the subcommand (besides `-C <dir>`); -c, --config-env, --git-dir, --exec-path, -p… are not. */
const GIT_GLOBAL_FLAGS = new Set(['--no-pager', '-P', '--no-replace-objects', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks'])
const GIT_RULES: OptionRules = { long: ['output', 'ext-diff', 'textconv', 'filters', 'open-files-in-pager', 'help'], exact: ['text'] }
const GIT_LIST_OPTIONS = {
  branch: /^(?:-[arlvqi]+|--(?:all|remotes|list|verbose|quiet|show-current|contains|no-contains|merged|no-merged|points-at|sort|format|color|no-color|column|no-column|ignore-case|abbrev|no-abbrev|omit-empty)(?:=.*)?)$/s,
  tag: /^(?:-(?:[li]|n\d*)+|--(?:list|contains|no-contains|merged|no-merged|points-at|sort|format|color|no-color|column|no-column|ignore-case|omit-empty)(?:=.*)?)$/s,
} as const
/** Options that make `git branch`/`git tag` list (their other words are patterns, not names to create). */
const GIT_LIST_MODE = { branch: /^--(?:list|contains|no-contains|merged|no-merged|points-at)(?:=|$)/, tag: /^-[a-z0-9]*[ln]|^--(?:list|contains|no-contains|merged|no-merged|points-at)(?:=|$)/ } as const
const GIT_VALUE_OPTIONS = /^--(?:sort|format|points-at)$/

const SED_FLAGS = 'nrsuzE'
const SED_LONG_FLAGS = new Set(['quiet', 'silent', 'regexp-extended', 'separate', 'unbuffered', 'null-data', 'zero-terminated', 'posix', 'debug', 'sandbox'])
const SED_SIMPLE = '=dDgGhHnNpPxzF'
const SED_REFUSED: Readonly<Record<string, string>> = { e: 'sed e runs commands', w: 'sed w writes files', W: 'sed W writes files' }

const AWK_KEYWORDS = new Set([
  'BEGIN', 'END', 'BEGINFILE', 'ENDFILE', 'function', 'func', 'if', 'else', 'while', 'for', 'do', 'break', 'continue', 'next', 'nextfile',
  'exit', 'return', 'delete', 'in', 'getline', 'print', 'printf', 'switch', 'case', 'default',
])
const AWK_PUNCTUATION = '(){}[];,+-*%^!~=<?:&$'

/** Bash's own operators end a word; anything else (even a non-ASCII space) belongs to it, as in bash. */
const WORD_END = /[ \t\n|&;<>()]/
const EXPANSION_START = /[A-Za-z0-9_{(\[@*#?$!-]/
const ASSIGNMENT = /^[A-Za-z_]\w*\+?=/
const SAFE_ASSIGNMENT = /^(?:LANG|LANGUAGE|LC_[A-Z]+|TZ|NO_COLOR)=|^(?:GIT_)?PAGER=(?:cat)?$/
const GLOB = /[*?[]/
/** git's `@{u}`, `HEAD@{2}`: braces bash leaves alone, as long as no other brace follows in the word. */
const GIT_REFLOG = /@\{(?:[^{},.]|\.(?!\.))*\}/g
const CONTROL_CHARACTERS = /[\0-\x08\x0b-\x1f\x7f]/
/** Marks a quoted or escaped character in a word's shape. */
const QUOTED = '\u0001'
const NO_EXPANSION = 'no variables or command substitution'
const NO_REDIRECT = 'no output redirection'

/** A shell word after quote removal (`text`), and the same with every quoted or escaped character as QUOTED (`shape`). */
type Word = { text: string; shape: string }

class Refused extends Error {}

function refuse(why: string): never {
  throw new Refused(why)
}

/** Why an explorer's shell command is refused, or undefined when it only reads. */
export const whyNotReadOnly = (command: string): string | undefined => {
  try {
    if (CONTROL_CHARACTERS.test(command)) refuse('no control characters')
    for (const words of parseCommands(command)) checkCommand(words)
    return undefined
  } catch (error) {
    return error instanceof Refused ? error.message : 'the command could not be checked'
  }
}

const isExpansion = (next: string | undefined, isInDoubleQuotes: boolean): boolean =>
  next !== undefined && (EXPANSION_START.test(next) || (!isInDoubleQuotes && (next === "'" || next === '"')))

/** Splits a command line into simple commands (their words), checking each redirection on the way. */
function parseCommands(line: string): Word[][] {
  const commands: Word[][] = [[]]
  let at = 0

  const readWord = (): Word | undefined => {
    let text = ''
    let shape = ''
    let isStarted = false
    const add = (char: string, isQuoted: boolean) => {
      text += char
      shape += isQuoted ? QUOTED : char
      isStarted = true
    }
    while (at < line.length && !WORD_END.test(line[at]!)) {
      const char = line[at]!
      if (char === '\\') {
        if (at + 1 >= line.length) refuse('no trailing backslash')
        if (line[at + 1] !== '\n') add(line[at + 1]!, true)
        at += 2
      } else if (char === "'") {
        const end = line.indexOf("'", at + 1)
        if (end === -1) refuse('an unclosed quote')
        isStarted = true
        for (const quoted of line.slice(at + 1, end)) add(quoted, true)
        at = end + 1
      } else if (char === '"') {
        isStarted = true
        for (at += 1; line[at] !== '"'; ) {
          if (at >= line.length) refuse('an unclosed quote')
          const inner = line[at]!
          const after = line[at + 1]
          if (inner === '`' || (inner === '$' && isExpansion(after, true))) refuse(NO_EXPANSION)
          if (inner === '\\' && after !== undefined && '$`"\\\n'.includes(after)) {
            if (after !== '\n') add(after, true)
            at += 2
          } else {
            add(inner, true)
            at += 1
          }
        }
        at += 1
      } else {
        if (char === '`' || (char === '$' && isExpansion(line[at + 1], false))) refuse(NO_EXPANSION)
        add(char, false)
        at += 1
      }
    }
    return isStarted ? { text, shape } : undefined
  }

  const target = (): string => {
    while (line[at] === ' ' || line[at] === '\t') at += 1
    return readWord()?.text ?? refuse('an incomplete redirection')
  }

  const redirect = (): void => {
    if (line.startsWith('<<<', at)) {
      at += 3
      target() // a here-string is data
    } else if (line.startsWith('<<', at)) {
      refuse('no here-documents')
    } else if (line.startsWith('<(', at) || line.startsWith('>(', at)) {
      refuse('no process substitution')
    } else if (line.startsWith('<>', at)) {
      refuse(NO_REDIRECT)
    } else if (line[at] === '<') {
      at += line.startsWith('<&', at) ? 2 : 1
      target()
    } else {
      const isDuplicate = line.startsWith('>&', at)
      at += isDuplicate || line.startsWith('>>', at) || line.startsWith('>|', at) ? 2 : 1
      const to = target()
      if (to !== '/dev/null' && !(isDuplicate && /^(?:\d+|-)$/.test(to))) refuse(NO_REDIRECT)
    }
  }

  const endCommand = () => {
    if (commands.at(-1)!.length > 0) commands.push([])
  }

  while (at < line.length) {
    const char = line[at]!
    if (char === ' ' || char === '\t') {
      at += 1
    } else if (char === '\n') {
      at += 1
      endCommand()
    } else if (char === '#') {
      while (at < line.length && line[at] !== '\n') at += 1
    } else if (line.startsWith('&>', at)) {
      at += line.startsWith('&>>', at) ? 3 : 2
      if (target() !== '/dev/null') refuse(NO_REDIRECT)
    } else if (char === ';' || char === '&' || char === '|') {
      at += ['&&', '||', '|&', ';;'].some(operator => line.startsWith(operator, at)) ? 2 : 1
      endCommand()
    } else if (char === '(' || char === ')') {
      refuse('no subshells or functions')
    } else if (char === '<' || char === '>') {
      redirect()
    } else {
      const word = readWord()
      // `2>`: an unquoted number right before a redirection is its file descriptor.
      if (word !== undefined && /^\d+$/.test(word.shape) && (line[at] === '<' || line[at] === '>')) redirect()
      else if (word !== undefined) commands.at(-1)!.push(word)
    }
  }
  return commands.filter(words => words.length > 0)
}

function checkCommand(words: readonly Word[]): void {
  let first = 0
  for (; first < words.length && ASSIGNMENT.test(words[first]!.shape); first += 1) {
    const { text } = words[first]!
    if (!SAFE_ASSIGNMENT.test(text)) refuse(`no ${text.slice(0, text.indexOf('='))}= (only LANG, LC_*, TZ and PAGER=cat)`)
  }
  const [programWord, ...args] = words.slice(first)
  if (programWord === undefined) return
  const program = programWord.text
  if (program.includes('/')) refuse('run programs by name, not by path')
  if (!READ_PROGRAMS.has(program)) refuse(`${program || '""'} is not a read command`)
  checkProgram(program, args)
  for (const arg of args) {
    if (/[{}]/.test(arg.shape.replace(GIT_REFLOG, ''))) refuse('no brace expansion')
    // A glob that starts a word could expand to a file named like an option (`--pre=…`).
    if (!GLOB_SAFE.has(program) && (GLOB.test(arg.shape[0] ?? '') || (arg.text.startsWith('-') && GLOB.test(arg.shape)))) {
      refuse(`start ${program} globs with ./ or quote them (a file named like an option could slip in)`)
    }
  }
}

function checkProgram(program: string, args: readonly Word[]): void {
  const texts = args.map(arg => arg.text)
  if (program === 'git') return checkGit(texts)
  if (program === 'sed') return checkSed(args)
  if (program === 'awk') return checkAwk(args)
  if (program === 'uniq') return checkUniq(args)
  if (program === 'find') {
    const action = texts.find(text => FIND_ACTIONS.test(text))
    if (action !== undefined) refuse(`find ${action} writes or runs commands`)
    return
  }
  const rules = OPTION_RULES[program]
  const option = rules === undefined ? undefined : riskyOption(texts, rules)
  if (option !== undefined) refuse(`${program} ${option} writes or runs something`)
}

/** The first option in `args` that writes or runs something. Words after `--` are checked too: refusing them is the safe side. */
function riskyOption(args: readonly string[], rules: OptionRules): string | undefined {
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const name = arg.slice(2).split('=')[0]!
      if (name !== '' && !rules.exact?.includes(name) && rules.long?.some(long => long.startsWith(name))) return `--${name}`
    } else if (arg.startsWith('-')) {
      const letter = [...arg.slice(1)].find(char => rules.short?.includes(char))
      if (letter !== undefined) return `-${letter}`
    }
  }
  return undefined
}

/** `uniq IN OUT` writes OUT: one file at most, and no glob that could become two. */
function checkUniq(args: readonly Word[]): void {
  if (args.some(arg => GLOB.test(arg.shape))) refuse('no globs for uniq (a second file would be overwritten)')
  let files = 0
  let isOption = true
  for (let k = 0; k < args.length; k += 1) {
    const text = args[k]!.text
    if (isOption && text === '--') isOption = false
    else if (isOption && text.startsWith('--')) k += UNIQ_LONG_VALUE.test(text) ? 1 : 0
    else if (isOption && text.startsWith('-') && text !== '-') k += /^-[^fsw]*[fsw]$/.test(text) ? 1 : 0 // -f/-s/-w take the next word
    else files += 1
  }
  if (files > 1) refuse('uniq with a second file writes it')
}

function checkGit(args: readonly string[]): void {
  let at = 0
  while (at < args.length && args[at]!.startsWith('-')) {
    const option = args[at]!
    if (option === '-C') at += 2
    else if (GIT_GLOBAL_FLAGS.has(option)) at += 1
    else refuse(`git ${option} is not allowed (config, pager and repository overrides can run commands)`)
  }
  const sub = args[at]
  if (sub === undefined || !GIT_READS.has(sub)) refuse(`git ${sub ?? 'without a subcommand'} is not a read command`)
  const rest = args.slice(at + 1)
  const option = riskyOption(rest, sub === 'grep' ? { ...GIT_RULES, short: 'O' } : GIT_RULES)
  if (option !== undefined) refuse(`git ${sub} ${option} writes or runs something`)
  if (sub === 'branch' || sub === 'tag') checkGitList(sub, rest)
  if (sub === 'remote') {
    const [action] = rest.filter(arg => arg !== '-v' && arg !== '--verbose')
    if (action !== undefined && action !== 'show' && action !== 'get-url') refuse('git remote may only list')
  }
}

/** `git branch`/`git tag` may list; a name outside list mode would create one. */
function checkGitList(sub: 'branch' | 'tag', args: readonly string[]): void {
  let names = 0
  let isListing = false
  for (let k = 0; k < args.length; k += 1) {
    const arg = args[k]!
    if (arg === '--') {
      names += args.length - k - 1
      break
    }
    if (!arg.startsWith('-')) {
      names += 1
      continue
    }
    if (!GIT_LIST_OPTIONS[sub].test(arg)) refuse(`git ${sub} may only list (${arg} refused)`)
    isListing ||= GIT_LIST_MODE[sub].test(arg)
    if (GIT_VALUE_OPTIONS.test(arg)) k += 1
  }
  if (names > 0 && !isListing) refuse(`git ${sub} may only list (a name would create one)`)
}

/** sed: only safe options, and every script read command by command (no w/W/e, no s///w or s///e). */
function checkSed(args: readonly Word[]): void {
  const scripts: Word[] = []
  let operand: Word | undefined
  const rest = (arg: Word, from: number): Word => ({ text: arg.text.slice(from), shape: arg.shape.slice(from) })
  for (let k = 0; k < args.length; k += 1) {
    const arg = args[k]!
    const { text } = arg
    if (text === '--') {
      operand ??= args[k + 1]
      break
    }
    if (text.startsWith('--')) {
      const equals = text.indexOf('=')
      const name = text.slice(2, equals === -1 ? undefined : equals)
      if (name === 'expression') {
        const script = equals === -1 ? args[(k += 1)] : rest(arg, equals + 1)
        if (script !== undefined) scripts.push(script)
      } else if (name === 'in-place') {
        refuse('no sed -i')
      } else if (!SED_LONG_FLAGS.has(name) || equals !== -1) {
        refuse(`sed --${name} is not allowed`)
      }
    } else if (text.startsWith('-') && text !== '-') {
      for (let p = 1; p < text.length; p += 1) {
        const letter = text[p]!
        if (letter === 'e') {
          const script = p + 1 < text.length ? rest(arg, p + 1) : args[(k += 1)]
          if (script !== undefined) scripts.push(script)
          break
        }
        if (letter === 'i' || letter === 'I') refuse('no sed -i')
        if (!SED_FLAGS.includes(letter)) refuse(`sed -${letter} is not allowed`)
      }
    } else {
      operand ??= arg
    }
  }
  if (scripts.length === 0 && operand !== undefined) scripts.push(operand)
  for (const script of scripts) {
    if (GLOB.test(script.shape)) refuse('quote sed scripts')
    checkSedScript(script.text)
  }
}

function checkSedScript(script: string): void {
  let at = 0
  const blanks = () => {
    while (script[at] === ' ' || script[at] === '\t') at += 1
  }
  const number = (): boolean => {
    const start = at
    while (/[0-9]/.test(script[at] ?? '')) at += 1
    return at > start
  }
  const address = (): boolean => {
    if (number()) {
      if (script[at] === '~') {
        at += 1
        number()
      }
      return true
    }
    if (script[at] === '$') {
      at += 1
      return true
    }
    if (script[at] !== '/' && script[at] !== '\\') return false
    const delimiter = script[at] === '\\' ? script[(at += 1)] : '/'
    at = skipDelimited(script, at + 1, checkedDelimiter(delimiter), true)
    while (script[at] === 'I' || script[at] === 'M') at += 1
    return true
  }
  // A label ends at a blank, `;` or `}` here: ending it early only means more of the script gets checked.
  const label = () => {
    blanks()
    while (at < script.length && !/[\s;}]/.test(script[at]!)) at += 1
  }
  const endOfCommand = () => {
    blanks()
    if (at < script.length && !';\n}#'.includes(script[at]!)) refuse('sed: unexpected text after a command')
  }

  while (at < script.length) {
    const char = script[at]!
    if (/[\s;]/.test(char)) {
      at += 1
      continue
    }
    if (char === '#') {
      while (at < script.length && script[at] !== '\n') at += 1
      continue
    }
    if (address()) {
      blanks()
      if (script[at] === ',') {
        at += 1
        blanks()
        if (script[at] === '+' || script[at] === '~') {
          at += 1
          if (!number()) refuse('sed: a bad address')
        } else if (!address()) {
          refuse('sed: a bad address')
        }
      }
      blanks()
    }
    while (script[at] === '!') {
      at += 1
      blanks()
    }
    const command = script[at]
    at += 1
    if (command === undefined) refuse('sed: a missing command')
    else if (command === '{' || command === '}') continue
    else if (SED_SIMPLE.includes(command)) endOfCommand()
    else if ('qQl'.includes(command)) {
      blanks()
      number()
      endOfCommand()
    } else if (':btT'.includes(command)) label()
    else if (command === 's' || command === 'y') {
      const delimiter = checkedDelimiter(script[at])
      at = skipDelimited(script, at + 1, delimiter, command === 's')
      at = skipDelimited(script, at, delimiter, false)
      if (command === 's') while (/[gpiImM0-9]/.test(script[at] ?? '')) at += 1
      if (script[at] === 'e') refuse('sed s///e runs commands')
      if (script[at] === 'w') refuse('sed s///w writes files')
      endOfCommand()
    } else refuse(SED_REFUSED[command] ?? `sed ${command} is not a read command`)
  }
}

function checkedDelimiter(delimiter: string | undefined): string {
  if (delimiter === undefined || /[\s\\[\]A-Za-z0-9]/.test(delimiter)) refuse('sed: an unusual delimiter')
  return delimiter
}

/** The index just past the part of `text` from `at` up to an unescaped `delimiter`. A regex's [...] is read whole. */
function skipDelimited(text: string, at: number, delimiter: string, isRegex: boolean): number {
  for (let i = at; i < text.length; i += 1) {
    const char = text[i]
    if (char === '\\') i += 1
    else if (char === '\n') refuse('a line break inside a regex or string')
    else if (char === delimiter) return i + 1
    else if (isRegex && char === '[') i = skipBracket(text, i, delimiter) - 1
  }
  return refuse('an unclosed regex or string')
}

/** Past a bracket expression. Implementations disagree on a delimiter or backslash inside one: refused. */
function skipBracket(text: string, at: number, delimiter: string): number {
  const unclear = 'a delimiter or \\ inside [...] in a regex reads differently across versions (use another sed delimiter)'
  let i = at + 1
  if (text[i] === '^') i += 1
  if (text[i] === ']') i += 1
  for (; i < text.length; i += 1) {
    const char = text[i]!
    if (char === ']') return i + 1
    if (char === delimiter || char === '\\' || char === '\n') refuse(unclear)
    if (char === '[' && /[:.=]/.test(text[i + 1] ?? '')) {
      const end = text.indexOf(`${text[i + 1]}]`, i + 2)
      if (end === -1 || /[\\\n]/.test(text.slice(i, end)) || text.slice(i, end).includes(delimiter)) refuse(unclear)
      i = end + 1
    }
  }
  return refuse(unclear)
}

/** awk: only -F and -v, and a program that neither runs commands nor writes files. */
function checkAwk(args: readonly Word[]): void {
  for (let k = 0; k < args.length; k += 1) {
    const { text } = args[k]!
    if (text === '--') {
      const program = args[k + 1]
      if (program !== undefined) checkAwkProgram(program)
      return
    }
    if (text.startsWith('-') && text !== '-') {
      if (text[1] !== 'F' && text[1] !== 'v') refuse(`awk ${text.startsWith('--') ? text.split('=')[0] : text.slice(0, 2)} is not allowed`)
      if (text.length === 2) k += 1
      continue
    }
    return checkAwkProgram(args[k]!)
  }
}

/**
 * Reads an awk program token by token, skipping strings, regexes and comments. Refused: system(), `@`
 * (gawk's @load, @include and indirect calls), any `|` but `||`, `>>`, and a `>` that redirects a
 * print. Where `/` could be either a division or a regex, the program is refused rather than guessed.
 */
function checkAwkProgram(word: Word): void {
  if (GLOB.test(word.shape)) refuse('quote awk programs')
  const program = word.text
  let at = 0
  let depth = 0
  let printDepth: number | undefined
  let before: 'operand' | 'operator' | 'unclear' = 'operator'
  while (at < program.length) {
    const char = program[at]!
    const rest = program.slice(at)
    const name = /^[A-Za-z_]\w*/.exec(rest)?.[0]
    const number = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest)?.[0]
    if (char === ' ' || char === '\t') {
      at += 1
    } else if (char === '\\' && program[at + 1] === '\n') {
      at += 2
    } else if (char === '\n') {
      at += 1
      if (depth === 0) before = 'operator'
    } else if (char === '#') {
      while (at < program.length && program[at] !== '\n') at += 1
    } else if (char === '"') {
      at = skipDelimited(program, at + 1, '"', false)
      before = 'operand'
    } else if (char === '/' && before === 'operand') {
      at += program[at + 1] === '=' ? 2 : 1
      before = 'operator'
    } else if (char === '/') {
      if (before === 'unclear') refuse('awk: a / that may be a division or a regex (drop the parentheses or use $0 ~ "…")')
      at = skipDelimited(program, at + 1, '/', true)
      before = 'operand'
    } else if (name !== undefined) {
      if (name === 'system') refuse('awk system() runs commands')
      if (name === 'print' || name === 'printf') printDepth = depth
      at += name.length
      before = AWK_KEYWORDS.has(name) ? 'unclear' : 'operand'
    } else if (number !== undefined) {
      at += number.length
      before = 'operand'
    } else if (char === '|') {
      if (program[at + 1] !== '|') refuse('awk pipes run commands')
      at += 2
      before = 'operator'
    } else if (char === '>') {
      if (program[at + 1] === '>') refuse('awk >> writes files')
      if (printDepth !== undefined && depth <= printDepth) refuse('awk print > writes files')
      at += program[at + 1] === '=' ? 2 : 1
      before = 'operator'
    } else if ((char === '+' || char === '-') && program[at + 1] === char) {
      at += 2
      before = 'unclear'
    } else {
      if (!AWK_PUNCTUATION.includes(char)) refuse(char === '@' ? 'awk @ directives can load code' : `awk: an unexpected ${char}`)
      if (char === '(') depth += 1
      if (char === ')') depth -= 1
      if (char === ';' || char === '{' || char === '}') printDepth = undefined
      at += 1
      before = char === ')' || char === '$' ? 'unclear' : char === ']' ? 'operand' : 'operator'
    }
  }
}
