/** The words of one command: its program, then its arguments. */
type Words = readonly string[]

const CONNECTORS = new Set(['&&', '||', ';', '|', '\n'])
const WRAPPERS = new Set(['sudo', 'time', 'nice', 'command', 'env', 'nohup'])
/** Commands that do nothing a second run would regret: they set things up, look, or are the receiving end of a download. */
const HARMLESS = new Set([
  'cd', 'pushd', 'popd', 'export', 'set', 'unset', 'echo', 'printf', 'true', 'pwd', 'ls', 'cat', 'mkdir', 'rm', 'test', '[', 'source', '.', ':',
  'tar', 'unzip', 'gunzip', 'zcat', 'chmod', 'sha256sum', 'shasum', 'md5sum', 'head', 'tail', 'grep', 'jq', 'sort', 'wc', 'tee',
])

/** The subcommands of each program that fetch things and can be run again without harm. */
const SAFE_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  npm: ['install', 'i', 'ci', 'add', 'update', 'up', 'upgrade', 'dedupe', 'view', 'info', 'outdated', 'audit', 'pack'],
  pnpm: ['install', 'i', 'add', 'update', 'up', 'upgrade', 'fetch', 'dedupe', 'outdated'],
  bun: ['install', 'i', 'add', 'update'],
  pip: ['install', 'download', 'wheel'],
  poetry: ['install', 'add', 'update', 'lock'],
  pipenv: ['install', 'sync', 'update'],
  conda: ['install', 'update', 'create'],
  mamba: ['install', 'update', 'create'],
  gem: ['install', 'update', 'fetch'],
  composer: ['install', 'update', 'require'],
  dotnet: ['restore'],
  nuget: ['restore'],
  cargo: ['fetch', 'install', 'add', 'update', 'vendor', 'build', 'check'],
  rustup: ['update', 'toolchain', 'component', 'target'],
  apt: ['install', 'update', 'upgrade', 'dist-upgrade', 'build-dep'],
  'apt-get': ['install', 'update', 'upgrade', 'dist-upgrade', 'build-dep'],
  apk: ['add', 'update', 'upgrade'],
  brew: ['install', 'update', 'upgrade', 'fetch', 'tap'],
  dnf: ['install', 'update', 'upgrade'],
  yum: ['install', 'update', 'upgrade'],
  terraform: ['init', 'get'],
  tofu: ['init', 'get'],
  nvm: ['install'],
}
const GIT_SUBCOMMANDS = new Set(['fetch', 'pull', 'clone', 'ls-remote'])
const GIT_SUBMODULE = new Set(['update', 'sync', 'init'])
const CURL_WRITES = /^(?:-d.*|--data(?:-[a-z]+)?(?:=.*)?|-F.*|--form(?:-string)?(?:=.*)?|-T.*|--upload-file(?:=.*)?|--json(?:=.*)?|-X(?!GET$|HEAD$).+|--request=(?!GET$|HEAD$).+)$/
const CURL_METHOD_FLAGS = new Set(['-X', '--request'])
const DOCKER_SUBCOMMANDS = new Set(['pull', 'build'])

/** Shell words of `command`, split into segments at `&&`, `||`, `;`, `|` and line breaks, or undefined when it uses features that make a rerun unpredictable. */
export const segmentsOf = (command: string): Words[] | undefined => {
  const segments: string[][] = [[]]
  let word: string | undefined
  let quote: '"' | "'" | undefined
  const endWord = () => {
    if (word !== undefined) segments.at(-1)?.push(word)
    word = undefined
  }

  for (let i = 0; i < command.length; i++) {
    const char = command[i] ?? ''
    const next = command[i + 1]
    if (quote === "'") {
      if (char === "'") quote = undefined
      else word = (word ?? '') + char
    } else if (quote === '"') {
      if (char === '"') quote = undefined
      else if (char === '`' || (char === '$' && next === '(')) return undefined
      else if (char === '\\' && next !== undefined) {
        word = (word ?? '') + next
        i += 1
      } else word = (word ?? '') + char
    } else if (char === "'" || char === '"') {
      quote = char
      word ??= ''
    } else if (char === '\\' && next !== undefined) {
      word = (word ?? '') + next
      i += 1
    } else if (char === '`' || char === '(' || char === ')' || (char === '$' && next === '(')) {
      return undefined
    } else if (char === '<' && next === '<') {
      return undefined
    } else if (char === '>' && next === '>') {
      return undefined
    } else if (char === '&' && next !== '&' && command[i - 1] !== '>' && command[i - 1] !== '&' && next !== '>') {
      return undefined
    } else if (/\s/.test(char) && char !== '\n') {
      endWord()
    } else if (CONNECTORS.has(char) || CONNECTORS.has(`${char}${next}`)) {
      endWord()
      if (`${char}${next}` === '&&' || `${char}${next}` === '||') i += 1
      segments.push([])
    } else {
      word = (word ?? '') + char
    }
  }
  if (quote !== undefined) return undefined
  endWord()
  return segments.filter(words => words.length > 0)
}

const REDIRECT_TO_NEXT_WORD = /^(?:\d*>|&>)$/
const REDIRECT = /^(?:\d*>|&>|<)/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const WRAPPER_FLAGS_WITH_VALUE = new Set(['-n', '-u', '-g', '-C'])
const TIMEOUT_FLAGS_WITH_VALUE = new Set(['-s', '-k', '--signal', '--kill-after'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
/** `-c`, or `-c` grouped with other short options: `bash -lc`, `sh -ec`. */
const SHELL_COMMAND_FLAG = /^-[a-zA-Z]*c[a-zA-Z]*$/
const MAX_NESTING = 3

/** `words` without redirections (`> out.log`, `2>&1`, `&>/dev/null`) and without what runs before the program: variables, `sudo`, `time`, `timeout 60`. */
const programWords = (words: Words): string[] => {
  let rest: string[] = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? ''
    if (REDIRECT_TO_NEXT_WORD.test(word)) i += 1
    else if (!REDIRECT.test(word)) rest.push(word)
  }

  for (;;) {
    const [first = '', ...after] = rest
    if (ASSIGNMENT.test(first)) {
      rest = after
    } else if (WRAPPERS.has(first)) {
      let skipped = 0
      while (after[skipped]?.startsWith('-') === true) skipped += WRAPPER_FLAGS_WITH_VALUE.has(after[skipped] ?? '') ? 2 : 1
      rest = after.slice(skipped)
    } else if (first === 'timeout') {
      let skipped = 0
      while (after[skipped]?.startsWith('-') === true) skipped += TIMEOUT_FLAGS_WITH_VALUE.has(after[skipped] ?? '') ? 2 : 1
      rest = after.slice(skipped + 1)
    } else {
      return rest
    }
  }
}

const baseName = (program: string): string => program.split('/').at(-1) ?? program

/** Whether `words` is one fetch-type command a second run would redo without harm. */
const isRepeatable = (words: Words, depth: number): boolean => {
  const [rawProgram = '', ...args] = programWords(words)
  let program = baseName(rawProgram)
  let rest = args

  if (SHELLS.has(program)) {
    // `bash -lc "npm ci"`: the script decides, read like a command line of its own.
    const flag = rest.findIndex(arg => SHELL_COMMAND_FLAG.test(arg))
    const script = flag === -1 ? undefined : rest[flag + 1]
    return script !== undefined && depth < MAX_NESTING && isRetryable(script, depth + 1)
  }

  if (/^python[\d.]*$/.test(program) && rest[0] === '-m' && rest[1] === 'pip') {
    program = 'pip'
    rest = rest.slice(2)
  }
  if (program === 'pip3') program = 'pip'
  if (program === 'uv') return ['sync', 'add', 'lock'].includes(rest[0] ?? '') || (rest[0] === 'pip' && ['install', 'sync', 'compile'].includes(rest[1] ?? ''))
  if (program === 'yarn') return rest.every(arg => arg.startsWith('-')) || ['install', 'add', 'upgrade', 'up', 'dedupe'].includes(rest[0] ?? '')
  if (program === 'bundle') return rest.every(arg => arg.startsWith('-')) || ['install', 'update'].includes(rest[0] ?? '')
  if (program === 'wget') return !rest.some(arg => /^--(?:post-data|post-file|method)/.test(arg))
  if (program === 'curl') return isReadOnlyCurl(rest)
  if (program === 'git') return isRepeatableGit(rest)
  if (program === 'go') return ['get', 'install'].includes(rest[0] ?? '') || (rest[0] === 'mod' && ['download', 'tidy', 'vendor'].includes(rest[1] ?? ''))
  if (program === 'docker' || program === 'docker-compose') return isRepeatableDocker(program, rest)
  if (program === 'gh') return (rest[0] === 'repo' && rest[1] === 'clone') || (rest[0] === 'release' && rest[1] === 'download')

  const subcommand = rest.find(arg => !arg.startsWith('-') && !arg.startsWith('+'))
  return subcommand !== undefined && (SAFE_SUBCOMMANDS[program]?.includes(subcommand) ?? false)
}

const isReadOnlyCurl = (args: Words): boolean =>
  !args.some((arg, index) => CURL_WRITES.test(arg) || (CURL_METHOD_FLAGS.has(args[index - 1] ?? '') && !/^(?:GET|HEAD)$/i.test(arg)))

const isRepeatableGit = (args: Words): boolean => {
  // `git -C dir fetch`, `git -c k=v pull`: skip the options that come before the subcommand.
  let i = 0
  while (i < args.length && (args[i]?.startsWith('-') === true)) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1
  const subcommand = args[i]
  if (subcommand === undefined) return false
  if (subcommand === 'submodule') return GIT_SUBMODULE.has(args.slice(i + 1).find(arg => !arg.startsWith('-')) ?? '')
  if (subcommand === 'remote') return args[i + 1] === 'update'
  if (subcommand === 'lfs') return ['pull', 'fetch', 'clone'].includes(args[i + 1] ?? '')
  return GIT_SUBCOMMANDS.has(subcommand)
}

const isRepeatableDocker = (program: string, args: Words): boolean => {
  const [first = '', second = ''] = args.filter(arg => !arg.startsWith('-'))
  if (program === 'docker-compose') return DOCKER_SUBCOMMANDS.has(first)
  if (first === 'compose') return DOCKER_SUBCOMMANDS.has(second)
  if (first === 'image' || first === 'buildx') return DOCKER_SUBCOMMANDS.has(second)
  return DOCKER_SUBCOMMANDS.has(first)
}

/**
 * Whether running `command` again after a network failure is safe: every part of it is a fetch-type command
 * (install, fetch, pull, clone, a GET) or something harmless beside one (`cd`, `rm -rf node_modules`, `tar`).
 * At least one part has to be a fetch, or there is nothing a network error could have broken.
 */
export const isRetryable = (command: string, depth = 0): boolean => {
  const segments = segmentsOf(command)
  if (segments === undefined || segments.length === 0) return false
  const kinds = segments.map(words => (isRepeatable(words, depth) ? 'fetch' : HARMLESS.has(baseName(programWords(words)[0] ?? '')) ? 'harmless' : 'other'))
  return kinds.includes('fetch') && !kinds.includes('other')
}

const TRANSIENT_ERRORS: readonly RegExp[] = [
  /\bETIMEDOUT\b/,
  /\bESOCKETTIMEDOUT\b/,
  /\bECONNRESET\b/,
  /\bEAI_AGAIN\b/,
  /\bEHOSTUNREACH\b/,
  /\bENETUNREACH\b/,
  /\bENETDOWN\b/,
  /\bsocket hang up\b/i,
  /\bnetwork timeout\b/i,
  /\bnetwork (?:is )?unreachable\b/i,
  /\bCould not resolve host\b/i,
  /\bTemporary failure in name resolution\b/i,
  /\bConnection (?:timed out|reset by peer)\b/i,
  /\bOperation timed out\b/i,
  /\bTLS handshake timeout\b/i,
  /\bi\/o timeout\b/i,
  /\bspurious network error\b/i,
  /\b(?:ReadTimeoutError|ConnectTimeoutError|Connection aborted|Connection broken)\b/,
  /\bunexpected EOF\b/i,
  /\bearly EOF\b/i,
  /\bthe remote end hung up unexpectedly\b/i,
  /\bRPC failed; (?:curl \d+ |HTTP (?:502|503|504))/i,
  /\b(?:502 Bad Gateway|503 Service (?:Temporarily )?Unavailable|504 Gateway Time-?out)\b/i,
  /\b(?:returned error|HTTP status|HTTP|error|status code|code|ERR!)[: ]+(?:429|502|503|504)\b/i,
  /\b(?:Bad Gateway|Service Temporarily Unavailable|Gateway Time-?out)\b/i,
]

/** The part of `output` that says the failure was a temporary network one, or undefined when it says nothing of the kind. */
export const transientError = (output: string): string | undefined => {
  for (const pattern of TRANSIENT_ERRORS) {
    const match = pattern.exec(output)
    if (match !== null) return match[0].trim()
  }
  return undefined
}

/** The wait before retry number `retry` (1-based): `first`, then twice as long each time. */
export const backoffMs = (retry: number, firstMs: number): number => firstMs * 2 ** (retry - 1)
