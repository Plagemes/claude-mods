import { MAX_NESTING, simpleCommands as readCommands, shellScriptArg } from './shared/shell'

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

/**
 * The simple commands of a line, as the shared shell reader splits them (pipelines and lists, wrappers such as
 * `sudo` and `timeout` peeled): their words, and the files their `>` and `>>` redirects write. Commands nested in
 * `bash -c`, `eval` or `$()` are not listed here: `additionsOf` opens those scripts itself.
 */
export const simpleCommands = (command: string): Simple[] =>
  readCommands(command)
    .filter(simple => simple.depth === 0)
    .map(simple => ({ words: simple.argv, redirects: simple.redirects.filter(redirect => redirect.op.includes('>') && redirect.target !== '').map(redirect => redirect.target) }))

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

/** What the command adds to the disk, as far as its words say; `cd` earlier in the line moves where relative paths point. */
export const additionsOf = (command: string, startDirectory: string, depth = 0): Additions => {
  const additions: Additions = { files: [], folders: [], isGitAdd: false }
  let cwd = startDirectory
  for (const { redirects, words } of simpleCommands(command)) {
    const program = basename(words[0] ?? '')
    const script = program === 'eval' ? words.slice(1).join(' ') : shellScriptArg(words)
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
