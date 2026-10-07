const FETCH_PROGRAMS = new Set(['curl', 'wget', 'http', 'https', 'httpie', 'xh', 'xhs'])
const WRAPPERS = new Set(['sudo', 'env', 'time', 'nohup', 'nice', 'exec', 'timeout', 'stdbuf', 'xargs', 'do', 'then', 'else'])
const WRAPPER_OPTIONS_WITH_VALUE = new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '-n', '-I', '-L', '-P'])
const URL_WITH_SCHEME = /^([a-z][a-z0-9+.-]*):\/\/([^/?#\\]*)/i
const BARE_HOST = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
/** Options that take the next word as a value, so that word is not a URL. */
const VALUE_OPTIONS: Record<'curl' | 'wget', ReadonlySet<string>> = {
  curl: new Set([
    '-A', '-b', '-c', '-C', '-d', '-D', '-e', '-E', '-F', '-H', '-K', '-m', '-o', '-P', '-Q', '-r', '-T', '-u', '-U', '-w', '-x', '-X', '-y', '-Y', '-z',
    '--output', '--header', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--request', '--user', '--user-agent', '--referer', '--cookie', '--cookie-jar', '--form',
    '--max-time', '--connect-timeout', '--retry', '--retry-delay', '--retry-max-time', '--proxy', '--cert', '--key', '--cacert', '--resolve', '--write-out', '--output-dir',
    '--upload-file', '--range', '--limit-rate', '--json', '--config', '--dump-header',
  ]),
  wget: new Set([
    '-O', '-P', '-o', '-a', '-i', '-t', '-T', '-w', '-e', '-U', '-l', '-A', '-R', '-D', '-I', '-X', '-B', '-Q',
    '--output-document', '--directory-prefix', '--output-file', '--append-output', '--input-file', '--tries', '--timeout', '--wait', '--header', '--user-agent', '--referer', '--post-data',
    '--post-file', '--user', '--password', '--load-cookies', '--save-cookies', '--limit-rate',
  ]),
}
const CLUSTER_ENDING_IN_VALUE_OPTION = /^-[A-Za-z]*[AbcCdDeEFHKmoPQrTuUwxXyYz]$/
const LOOP_START = /(?:^|[;&|(\n"']\s*)(?:for|while|until)\b/
const POLITE = /\bsleep\b|\bwait\b|--limit-rate|--rate\b|--wait\b/

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
    } else if ('|;&\n(){}<>'.includes(char)) {
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

const programOf = (words: readonly string[]): { name: string; args: string[] } | undefined => {
  let index = 0
  while (index < words.length) {
    const word = words[index] ?? ''
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) index += 1
    else if (WRAPPERS.has(basename(word))) {
      const wrapper = basename(word)
      index += 1
      while (words[index]?.startsWith('-') === true) index += WRAPPER_OPTIONS_WITH_VALUE.has(words[index] ?? '') && wrapper === 'sudo' ? 2 : 1
      if (wrapper === 'timeout') index += 1
    } else break
  }
  const name = basename(words[index] ?? '')
  return name === '' ? undefined : { name, args: words.slice(index + 1) }
}

/** The host of a URL, lower-cased, without userinfo or port; undefined when it cannot be told. */
export const hostOf = (url: string): string | undefined => {
  const authority = (URL_WITH_SCHEME.exec(url) ?? URL_WITH_SCHEME.exec(`https://${url}`))?.[2]
  if (authority === undefined || /[\s%\\$`]/.test(authority)) return undefined
  const afterUser = authority.slice(authority.lastIndexOf('@') + 1)
  const host = (/^\[([0-9a-f:.]+)\](?::\d*)?$/i.exec(afterUser)?.[1] ?? /^([^:]+)(?::\d*)?$/.exec(afterUser)?.[1] ?? '').toLowerCase().replace(/\.$/, '')
  return /^[a-z0-9._-]+$/.test(host) || host.includes(':') ? host : undefined
}

/** This machine, the local network and the like: calls there are nobody's API to hammer. */
export const isLocalHost = (host: string): boolean =>
  host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1' || host === '0.0.0.0' ||
  /^(?:127|10)\.\d+\.\d+\.\d+$/.test(host) || /^192\.168\.\d+\.\d+$/.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host) || /^169\.254\.\d+\.\d+$/.test(host)

const targetsOf = (name: string, args: readonly string[]): string[] => {
  if (name === 'curl' || name === 'wget') {
    const targets: string[] = []
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index] ?? ''
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) targets.push(arg)
      else if (arg === '--url' && args[index + 1] !== undefined) targets.push(args[(index += 1)] ?? '')
      else if (arg.startsWith('--url=')) targets.push(arg.slice('--url='.length))
      else if (arg.startsWith('-')) index += VALUE_OPTIONS[name].has(arg) || (name === 'curl' && CLUSTER_ENDING_IN_VALUE_OPTION.test(arg)) ? 1 : 0
      else if (BARE_HOST.test(arg)) targets.push(arg)
    }
    return targets
  }
  // httpie and xh: `http [METHOD] URL [ITEM...]`, with https as the default scheme for the `https` command.
  const [first, second] = args.filter(arg => !arg.startsWith('-'))
  const target = first !== undefined && HTTP_METHODS.has(first.toUpperCase()) ? second : first
  return target === undefined || target.startsWith(':') ? [] : [name === 'https' || name === 'xhs' ? `https://${target.replace(/^[a-z]+:\/\//i, '')}` : target]
}

/** The external hosts a command sends curl, wget or httpie requests to, once per mention. */
export const externalHosts = (command: string): string[] =>
  simpleCommands(command).flatMap(words => {
    const program = programOf(words)
    if (program === undefined || !FETCH_PROGRAMS.has(program.name)) return []
    return targetsOf(program.name, program.args).flatMap(url => {
      const host = hostOf(url)
      return host === undefined || isLocalHost(host) ? [] : [host]
    })
  })

export type LoopUse = { iterations: number | undefined }

/**
 * A fetch in a for/while/until loop, or fed by xargs or parallel, in one command: each round is a request, and nothing
 * in the command slows them down. Undefined for a polite loop (one that sleeps or waits) or none.
 */
export const loopOfFetches = (command: string): LoopUse | undefined => {
  const text = /\b(?:ba|z)?sh\s+-c\b|\beval\b/.test(command) ? command : command.replace(/"[^"]*"|'[^']*'/g, '""')
  const start = LOOP_START.exec(text)
  const fetches = /\b(?:curl|wget|http|https|httpie|xh)\b/
  if (start !== null) {
    const body = text.slice(start.index)
    if (/\bdo\b/.test(body) && fetches.test(body.slice(body.search(/\bdo\b/))) && !POLITE.test(body)) {
      const range = /\{(\d+)\.\.(\d+)\}|\bseq\s+(?:-s\s*\S+\s+)?(\d+)\s+(\d+)/.exec(body)
      const words = /\bfor\s+\w+\s+in\s+([^;\n]+?)\s*;?\s*do\b/.exec(body)?.[1]
      const count = range === null ? (words === undefined || /[$`{]/.test(words) ? undefined : words.trim().split(/\s+/).length) : Math.abs(Number(range[2] ?? range[4]) - Number(range[1] ?? range[3])) + 1
      return { iterations: count }
    }
  }
  return /\b(?:xargs|parallel)\b[^|;&\n]*\b(?:curl|wget|http|httpie|xh)\b/.test(text) && !POLITE.test(text) ? { iterations: undefined } : undefined
}
