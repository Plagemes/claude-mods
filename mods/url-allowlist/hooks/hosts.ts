const URL_START = /^([a-z][a-z0-9+.-]*):\/\/([^/?#\\]*)/i
const HOSTNAME = /^[a-z0-9._-]+$/
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/
const FETCH_PROGRAMS = new Set(['curl', 'wget', 'http', 'https', 'httpie'])
/** Commands that run the command after their own options, and those options that take a value. */
const WRAPPERS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '-r', '-t', '--user', '--group', '--host', '--prompt', '--chdir']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '--unset', '-C', '--chdir']),
  time: new Set(['-f', '--format', '-o', '--output']),
  nohup: new Set(),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n', '-p', '--class', '--classdata']),
  command: new Set(),
  builtin: new Set(),
  exec: new Set(['-a']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  stdbuf: new Set(['-i', '-o', '-e']),
}
const SHELL = /^(?:ba|z|da|k)?sh$/
/** `-c`, or `-c` grouped with other short options: `bash -lc`, `sh -ec`. */
const SHELL_COMMAND_FLAG = /^-[a-zA-Z]*c[a-zA-Z]*$/

/**
 * The host a URL points at, lower-cased: undefined when it cannot be told with certainty (userinfo tricks are
 * seen through, but escapes, backslashes, odd characters and expansions give no host). A URL with no scheme
 * is read as https, as WebFetch would.
 */
export const hostOf = (url: string): string | undefined => {
  const text = url.trim().replace(/[\t\n\r]/g, '')
  const authority = (URL_START.exec(text) ?? URL_START.exec(`https://${text}`))?.[2]
  if (authority === undefined || /[\s%\\]/.test(authority)) return undefined
  const afterUser = authority.slice(authority.lastIndexOf('@') + 1)
  const host = (/^\[([0-9a-f:.]+)\](?::\d*)?$/i.exec(afterUser)?.[1] ?? /^([^:]+)(?::\d*)?$/.exec(afterUser)?.[1] ?? '').toLowerCase().replace(/\.$/, '')
  return host !== '' && (HOSTNAME.test(host) || host.includes(':')) ? host : undefined
}

export const isLoopback = (host: string): boolean => host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127\.\d+\.\d+\.\d+$/.test(host)

/** What a person may type for a host (a bare name, a URL, a wildcard), reduced to `example.com` or `*.example.com`; undefined when it is not one. */
export const parseEntry = (entry: string): string | undefined => {
  const text = entry.trim().toLowerCase()
  const isSubdomainsOnly = text.startsWith('*.')
  const host = hostOf(isSubdomainsOnly ? text.slice(2) : text)
  // A name with no dot would cover a whole top-level domain ("com"): only localhost is allowed that short.
  if (host === undefined || (!host.includes('.') && !host.includes(':') && host !== 'localhost')) return undefined
  return isSubdomainsOnly ? `*.${host}` : host
}

export const parseList = (list: string): string[] =>
  list.split(',').flatMap(entry => {
    const parsed = parseEntry(entry)
    return parsed === undefined ? [] : [parsed]
  })

/** `github.com` matches github.com and api.github.com, never evilgithub.com or github.com.evil.com; `*.example.com` only the subdomains. */
export const matchesAny = (host: string, entries: readonly string[]): boolean =>
  entries.some(entry => {
    if (entry.startsWith('*.')) return host.endsWith(entry.slice(1))
    return host === entry || (!IPV4.test(entry) && host.endsWith(`.${entry}`))
  })

// ── URLs in shell commands ──────────────────────────────────────────────────

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** Words of each simple command, quotes resolved. */
const simpleCommands = (command: string): string[][] => {
  const commands: string[][] = [[]]
  let word: string | undefined
  let index = 0
  const endWord = (): void => {
    if (word !== undefined) commands.at(-1)?.push(word)
    word = undefined
  }
  while (index < command.length) {
    const char = command[index] ?? ''
    if (char === "'" || char === '"') {
      let close = index + 1
      while (close < command.length && command[close] !== char) close += char === '"' && command[close] === '\\' ? 2 : 1
      if (close >= command.length) break
      const inner = command.slice(index + 1, close)
      word = (word ?? '') + (char === '"' ? inner.replace(/\\(["\\$`])/g, '$1') : inner)
      index = close + 1
    } else if (char === '\\') {
      word = (word ?? '') + (command[index + 1] ?? '')
      index += 2
    } else if (/[ \t]/.test(char)) {
      endWord()
      index += 1
    } else if ('|;&\n()<>'.includes(char)) {
      endWord()
      if (commands.at(-1)?.length !== 0) commands.push([])
      index += 1
    } else {
      word = (word ?? '') + char
      index += 1
    }
  }
  endWord()
  return commands.filter(words => words.length > 0)
}

/** The fetching program of a simple command and the words after it, past env assignments and wrappers such as sudo. */
const programOf = (words: readonly string[]): { name: string; args: readonly string[] } | undefined => {
  let index = 0
  while (index < words.length) {
    const word = words[index] ?? ''
    const valued = WRAPPERS[basename(word)]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) index += 1
    else if (valued !== undefined) {
      const wasTimeout = basename(word) === 'timeout'
      index += 1
      while (words[index]?.startsWith('-') === true) index += valued.has(words[index] ?? '') ? 2 : 1
      if (wasTimeout) index += 1
    } else break
  }
  const name = basename(words[index] ?? '')
  return name === '' ? undefined : { name, args: words.slice(index + 1) }
}

const MAX_NESTING = 2

/** Every `scheme://` URL passed to curl, wget or httpie in a command (also inside `bash -c "..."`). */
export const urlsInCommand = (command: string, depth = 0): string[] =>
  simpleCommands(command).flatMap(words => {
    const program = programOf(words)
    if (program === undefined) return []
    if (FETCH_PROGRAMS.has(program.name)) {
      return program.args.flatMap((word, index) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(word) ? [word] : word === '--url' && program.args[index + 1] !== undefined ? [program.args[index + 1] ?? ''] : []))
    }
    if (depth >= MAX_NESTING) return []
    // `eval "curl …"` and `bash -lc "curl …"` run their text as a command line of its own.
    if (program.name === 'eval') return urlsInCommand(program.args.join(' '), depth + 1)
    const flag = SHELL.test(program.name) ? program.args.findIndex(arg => SHELL_COMMAND_FLAG.test(arg)) : -1
    const script = flag === -1 ? undefined : program.args[flag + 1]
    return script === undefined ? [] : urlsInCommand(script, depth + 1)
  })
