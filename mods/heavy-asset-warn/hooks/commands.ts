/** The git subcommand, past global options such as -C dir and -c key=value. */
const gitSubcommand = (words: readonly string[]): string | undefined => {
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] ?? ''
    if (word === '-C' || word === '-c') index += 1
    else if (!word.startsWith('-')) return word
  }
  return undefined
}

/** What a shell command adds to the disk: file paths to look at, and folders to look into for files it just wrote. */
export type Additions = { files: string[]; folders: string[]; isGitAdd: boolean }

type Simple = { words: string[]; redirects: string[] }

/** Index of the quote that closes the one at `start`, a backslash inside double quotes escaping the next character; -1 when it never closes. */
const closingQuote = (text: string, start: number): number => {
  const quote = text[start]
  for (let index = start + 1; index < text.length; index += 1) {
    if (quote === '"' && text[index] === '\\') index += 1
    else if (text[index] === quote) return index
  }
  return -1
}

/** Splits a command line into simple commands: words with quotes resolved, and the targets of > and >>. */
export const simpleCommands = (command: string): Simple[] => {
  const commands: Simple[] = [{ words: [], redirects: [] }]
  let word: string | undefined
  let isRedirect = false
  let index = 0

  const endWord = (): void => {
    if (word === undefined) return
    const current = commands.at(-1)
    if (isRedirect) current?.redirects.push(word)
    else current?.words.push(word)
    word = undefined
    isRedirect = false
  }

  while (index < command.length) {
    const char = command[index] ?? ''
    if (char === "'" || char === '"') {
      const close = closingQuote(command, index)
      if (close < 0) break
      const inner = command.slice(index + 1, close)
      word = (word ?? '') + (char === '"' ? inner.replace(/\\(["\\$`])/g, '$1') : inner)
      index = close + 1
    } else if (char === '\\') {
      word = (word ?? '') + (command[index + 1] ?? '')
      index += 2
    } else if (/\s/.test(char) && char !== '\n') {
      endWord()
      index += 1
    } else if (char === '|' || char === ';' || char === '&' || char === '\n' || char === '(' || char === ')') {
      endWord()
      if (commands.at(-1)?.words.length !== 0) commands.push({ words: [], redirects: [] })
      index += 1
    } else if (char === '>') {
      // "2>file": the number belongs to the operator. ">&2" duplicates a descriptor and names no file.
      if (word !== undefined && /^\d+$/.test(word)) word = undefined
      endWord()
      index += command[index + 1] === '>' ? 2 : 1
      if (command[index] === '&') {
        index += 1
        while (/[\d-]/.test(command[index] ?? '')) index += 1
      } else {
        isRedirect = true
      }
    } else if (char === '<') {
      endWord()
      index += 1
    } else {
      word = (word ?? '') + char
      index += 1
    }
  }
  endWord()
  return commands.filter(simple => simple.words.length > 0 || simple.redirects.length > 0)
}

const basename = (path: string): string => path.replace(/\/+$/, '').slice(path.replace(/\/+$/, '').lastIndexOf('/') + 1)
const hasGlob = (path: string): boolean => /[*?[{]/.test(path)
const isUnknown = (path: string): boolean => /[$`]/.test(path) || path === '-' || path === '/dev/null'
const absolute = (path: string, cwd: string): string => (path.startsWith('/') ? path : `${cwd.replace(/\/+$/, '')}/${path.replace(/^\.\//, '')}`).replace(/(.)\/+$/, '$1')
const urlName = (url: string): string => {
  const name = basename(url.replace(/[?#].*$/, ''))
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

const OPTIONS_WITH_VALUE: Record<string, ReadonlySet<string>> = {
  cp: new Set(['-t', '--target-directory', '-S', '--suffix']),
  mv: new Set(['-t', '--target-directory', '-S', '--suffix']),
  install: new Set(['-t', '--target-directory', '-m', '-o', '-g', '-S']),
}

/** `cp a b dir/`, `mv a dir/`, `install -m 644 a dest`, `cp -t dir a b`. */
const moves = (program: string, words: readonly string[], cwd: string, additions: Additions): void => {
  const positional: string[] = []
  let target: string | undefined
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] ?? ''
    if (word === '-t' || word === '--target-directory') {
      target = words[index + 1]
      index += 1
    } else if (word.startsWith('--target-directory=')) {
      target = word.slice('--target-directory='.length)
    } else if (word.startsWith('-') && word !== '-') {
      if (OPTIONS_WITH_VALUE[program]?.has(word)) index += 1
    } else {
      positional.push(word)
    }
  }
  const destination = target ?? positional.pop()
  if (destination === undefined || isUnknown(destination)) return

  const place = absolute(destination, cwd)
  additions.files.push(place)
  for (const source of positional.filter(source => !isUnknown(source))) {
    if (hasGlob(source)) additions.folders.push(place)
    else additions.files.push(`${place}/${basename(source)}`)
  }
}

/** `curl -o file url`, `curl -O url`, `wget -O file url`, `wget -P dir url`. */
const downloads = (program: string, words: readonly string[], cwd: string, additions: Additions): void => {
  const urls = words.filter(word => /^[a-z][a-z0-9+.-]*:\/\//i.test(word))
  let outputDir = cwd
  let isRemoteName = program === 'wget'
  let isNamed = false
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] ?? ''
    const next = words[index + 1]
    const isOutput =
      word === '--output' ||
      (program === 'curl' && /^-[A-Za-z]*o$/.test(word)) ||
      (program === 'wget' && (word === '-O' || word === '--output-document'))
    if (isOutput && next !== undefined) {
      if (!isUnknown(next)) additions.files.push(absolute(next, cwd))
      isNamed = true
      index += 1
    } else if (program === 'wget' && word.startsWith('--output-document=')) {
      additions.files.push(absolute(word.slice('--output-document='.length), cwd))
      isNamed = true
    } else if (program === 'wget' && /^-O.+/.test(word)) {
      additions.files.push(absolute(word.slice(2), cwd))
      isNamed = true
    } else if (((word === '-P' && program === 'wget') || word === '--directory-prefix' || word === '--output-dir') && next !== undefined) {
      outputDir = absolute(next, cwd)
      index += 1
    } else if (word.startsWith('--directory-prefix=')) {
      outputDir = absolute(word.slice('--directory-prefix='.length), cwd)
    } else if (program === 'curl' && (word === '--remote-name' || /^-[A-Za-z]*O[A-Za-z]*$/.test(word))) {
      isRemoteName = true
    }
  }
  if (isNamed || !isRemoteName) return
  for (const url of urls) additions.files.push(`${outputDir}/${urlName(url)}`)
  // wget -P dir with a name of its own is covered above; a bare wget also leaves fresh files in the folder.
  if (program === 'wget') additions.folders.push(outputDir)
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const PREFIXES = new Set(['command', 'builtin', 'exec', 'nohup'])
/** Commands that run the command after their own options, and those options that take a value. */
const WRAPPERS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-T', '-U', '--user', '--group', '--host', '--prompt', '--chdir']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '--unset', '-C', '--chdir']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n', '-p', '--class', '--classdata']),
  stdbuf: new Set(['-i', '-o', '-e']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  time: new Set(['-f', '--format', '-o', '--output']),
}
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
/** `-c`, or `-c` grouped with other short options: `bash -lc`, `sh -ec`. */
const SHELL_COMMAND_FLAG = /^-[a-zA-Z]*c[a-zA-Z]*$/
const MAX_NESTING = 3

/** The words of the command a simple command runs, past assignments and wrappers: `sudo -u web timeout 60 cp a b` is `cp a b`. */
const unwrap = (words: readonly string[]): string[] => {
  let start = 0
  for (;;) {
    while (start < words.length && (ASSIGNMENT.test(words[start] ?? '') || PREFIXES.has(words[start] ?? ''))) start += 1
    const wrapper = basename(words[start] ?? '')
    const valued = WRAPPERS[wrapper]
    if (valued === undefined) return words.slice(start)
    start += 1
    while (start < words.length && (words[start] ?? '').startsWith('-')) start += valued.has(words[start] ?? '') ? 2 : 1
    if (wrapper === 'timeout') start += 1
  }
}

/** What the command adds to the disk, as far as its words say; `cd` earlier in the line moves where relative paths point. */
export const additionsOf = (command: string, startDirectory: string, depth = 0): Additions => {
  const additions: Additions = { files: [], folders: [], isGitAdd: false }
  let cwd = startDirectory
  for (const simple of simpleCommands(command)) {
    const { redirects } = simple
    const words = unwrap(simple.words)
    const program = basename(words[0] ?? '')
    const flag = SHELLS.has(program) ? words.findIndex(word => SHELL_COMMAND_FLAG.test(word)) : -1
    const script = program === 'eval' ? words.slice(1).join(' ') : flag > 0 ? words[flag + 1] : undefined
    if (script !== undefined && depth < MAX_NESTING) {
      // `bash -c "cp big.mp4 public/"`, `sh -lc '…'`, `eval '…'`: the script's own commands add the files.
      const inner = additionsOf(script, cwd, depth + 1)
      additions.files.push(...inner.files)
      additions.folders.push(...inner.folders)
      additions.isGitAdd ||= inner.isGitAdd
    } else if (program === 'cd' && words[1] !== undefined && !isUnknown(words[1])) cwd = absolute(words[1], cwd)
    else if (program === 'cp' || program === 'mv' || program === 'install') moves(program, words, cwd, additions)
    else if (program === 'curl' || program === 'wget') downloads(program, words, cwd, additions)
    else if (program === 'git' && gitSubcommand(words) === 'add') additions.isGitAdd = true
    for (const target of redirects.filter(target => !isUnknown(target))) additions.files.push(absolute(target, cwd))
  }
  return additions
}
