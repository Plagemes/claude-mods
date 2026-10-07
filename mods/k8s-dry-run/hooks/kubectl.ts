import type { K8sDryRunObject } from '../types'

/** A kubectl call that changes the cluster, and what its dry run needs. */
export type KubectlCall = {
  verb: 'apply' | 'replace' | 'delete'
  /** Every word of the kubectl invocation after `kubectl`. */
  words: string[]
  context: string | undefined
  namespace: string | undefined
  kubeconfig: string | undefined
  /** Where `cd` moved before the call, relative or absolute. */
  cd: string | undefined
  /** The manifests a heredoc feeds to `-f -`. */
  stdin: string | undefined
  /** Why no dry run can stand for the call (its manifests come from another command). */
  unpreviewable: string | undefined
}

const SEPARATORS = new Set(['&&', '||', ';', '|', '\n'])
const WRAPPERS = new Set(['time', 'env', 'command', 'nice', 'nohup', 'sudo', 'exec', 'timeout', 'xargs', 'doas'])
/** Options of those wrappers that take the next word as their value (`sudo -u ops`, `nice -n 5`, `timeout -s KILL`). */
const WRAPPER_VALUE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T'],
  doas: ['-u', '-C'],
  env: ['-u', '-C', '-S'],
  nice: ['-n'],
  timeout: ['-s', '-k'],
  xargs: ['-I', '-L', '-n', '-P', '-d', '-E', '-s', '-a'],
}
const SHELLS = /^(?:ba|z|da|k)?sh$/
const MAX_NESTING = 3
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const VERBS = new Set(['apply', 'replace', 'delete'])
/** Flags that take a value in the next word when not written `--flag=value`. */
const VALUE_FLAGS = new Set([
  '-f', '--filename', '-k', '--kustomize', '-l', '--selector', '-n', '--namespace', '--context', '--kubeconfig', '--cluster',
  '--user', '-s', '--server', '--as', '--as-group', '--as-uid', '--token', '--field-manager', '-o', '--output', '--grace-period',
  '--timeout', '--cascade', '--prune-allowlist', '--field-selector', '--request-timeout', '--cache-dir', '--certificate-authority',
  '--client-certificate', '--client-key', '--tls-server-name', '--username', '--password', '--template', '--subresource', '--raw',
])
/** What `kubectl diff` takes of an apply's or replace's words: its sources and the connection. */
const DIFF_FLAGS = new Set([
  '-f', '--filename', '-k', '--kustomize', '-R', '--recursive', '-l', '--selector', '--server-side', '--field-manager',
  '--force-conflicts', '-n', '--namespace', '--context', '--kubeconfig', '--cluster', '--user', '-s', '--server', '--as',
  '--as-group', '--as-uid', '--token', '--request-timeout', '--cache-dir', '--certificate-authority', '--client-certificate',
  '--client-key', '--tls-server-name', '--username', '--password', '--insecure-skip-tls-verify',
])
const HEREDOC_MARK = '<<HEREDOC'
const MAX_OBJECT_DIFF = 20_000

const flagName = (word: string): string => (word.startsWith('-') ? (word.split('=')[0] ?? word) : word)
const hasInlineValue = (word: string): boolean => word.startsWith('--') && word.includes('=')

/** Takes heredoc bodies out of a command: the command with `<<HEREDOC` in their place, and the bodies in order. */
const extractHeredocs = (command: string): { command: string; bodies: string[] } => {
  const bodies: string[] = []
  const lines = command.split('\n')
  const kept: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const opener = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line)
    if (opener === null) {
      kept.push(line)
      continue
    }
    const delimiter = opener[2] ?? ''
    kept.push(line.replace(opener[0], HEREDOC_MARK))
    const body: string[] = []
    for (i += 1; i < lines.length && (lines[i] ?? '').trim() !== delimiter; i += 1) body.push(lines[i] ?? '')
    bodies.push(body.join('\n') + '\n')
  }
  return { command: kept.join('\n'), bodies }
}

/** Splits a command line into words and separators, honouring quotes and backslashes. */
const tokenize = (command: string): string[] => {
  const tokens: string[] = []
  let word = ''
  let hasWord = false
  let quote: '"' | "'" | null = null
  const flush = () => {
    if (hasWord) tokens.push(word)
    word = ''
    hasWord = false
  }
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i] ?? ''
    if (quote !== null) {
      if (char === quote) quote = null
      else if (char === '\\' && quote === '"' && i + 1 < command.length) word += command[++i] ?? ''
      else word += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      hasWord = true
    } else if (char === '\\' && command[i + 1] === '\n') {
      i += 1
    } else if (char === '\\' && i + 1 < command.length) {
      word += command[++i] ?? ''
      hasWord = true
    } else if (char === ' ' || char === '\t') {
      flush()
    } else if (char === '\n' || char === ';') {
      flush()
      tokens.push(char)
    } else if ((char === '&' || char === '|') && command[i + 1] === char) {
      flush()
      tokens.push(char + char)
      i += 1
    } else if (char === '|') {
      flush()
      tokens.push('|')
    } else {
      word += char
      hasWord = true
    }
  }
  flush()
  return tokens
}

/** The value of `--flag value`, `--flag=value` or `-f value` among the words. */
const valueOf = (words: readonly string[], names: readonly string[]): string | undefined => {
  let value: string | undefined
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] ?? ''
    const name = flagName(word)
    if (!names.includes(name)) continue
    value = hasInlineValue(word) ? word.slice(word.indexOf('=') + 1) : words[i + 1]
  }
  return value
}

const isDryRun = (word: string): boolean => /^--dry-run(?:=(?:client|server|true))?$/.test(word)

const count = (text: string, char: string): number => text.split(char).length - 1

/** A simple command without what only wraps it: `VAR=x`, `sudo -u ops`, `timeout 60`, `nice -n 5`, a subshell's `(` and `)`. */
const unwrap = (segment: readonly string[]): string[] => {
  let words = [...segment]
  if (words[0]?.startsWith('(') === true) words = [words[0].replace(/^\(+/, ''), ...words.slice(1)].filter((word, i) => i > 0 || word !== '')
  while (words.at(-1) === ')') words = words.slice(0, -1)
  const last = words.at(-1)
  if (last !== undefined && last.endsWith(')') && count(last, ')') > count(last, '(')) words = [...words.slice(0, -1), last.replace(/\)+$/, '')]
  for (;;) {
    const head = words[0] ?? ''
    if (ASSIGNMENT.test(head)) {
      words = words.slice(1)
      continue
    }
    if (!WRAPPERS.has(head)) return words
    let i = 1
    while ((words[i] ?? '').startsWith('-')) i += WRAPPER_VALUE_OPTIONS[head]?.includes(words[i] ?? '') === true ? 2 : 1
    // `timeout` takes a duration before the command it runs.
    if (head === 'timeout' && /^\d/.test(words[i] ?? '')) i += 1
    words = words.slice(i)
  }
}

/** The script of `bash -c '<script>'` (also sh, zsh, `-lc`, ...), if this simple command is one. */
const nestedScript = (words: readonly string[]): string | undefined => {
  const shell = words[0] ?? ''
  if (!SHELLS.test(shell.slice(shell.lastIndexOf('/') + 1))) return undefined
  for (let i = 1; i < words.length && (words[i] ?? '').startsWith('-'); i += 1) {
    if (/^-[a-z]*c[a-z]*$/.test(words[i] ?? '')) return words[i + 1]
  }
  return undefined
}

/**
 * The first kubectl apply, replace or delete in a Bash command that is not a
 * dry run already, with what its dry run needs; undefined when there is none.
 */
export const findKubectl = (command: string): KubectlCall | undefined => findKubectls(command)[0]

/**
 * Every kubectl apply, replace or delete in a Bash command that is not a dry
 * run already (also inside `bash -c '…'`), each with what its dry run needs.
 */
export const findKubectls = (command: string, depth = 0): KubectlCall[] => {
  const calls: KubectlCall[] = []
  const { command: plain, bodies } = extractHeredocs(command)
  const segments: { words: string[]; isPiped: boolean }[] = [{ words: [], isPiped: false }]
  for (const token of tokenize(plain)) {
    if (SEPARATORS.has(token)) segments.push({ words: [], isPiped: token === '|' })
    else segments.at(-1)?.words.push(token)
  }

  let cd: string | undefined
  let heredocs = 0
  /** What the segment before fed into a pipe: `cat` of a heredoc or of one file. */
  let feed: { heredoc?: number; file?: string } = {}
  for (const segment of segments) {
    const words = unwrap(segment.words)
    const heredoc = segment.words.includes(HEREDOC_MARK) ? heredocs++ : undefined
    const piped = segment.isPiped ? feed : {}
    const script = depth < MAX_NESTING ? nestedScript(words) : undefined
    if (script !== undefined) {
      const outer = cd
      calls.push(...findKubectls(script, depth + 1).map(call => ({ ...call, cd: outer === undefined || call.cd?.startsWith('/') === true ? call.cd : call.cd === undefined ? outer : `${outer}/${call.cd}` })))
      continue
    }
    const head = words[0]
    feed = head === 'cat' && words.length === 2 ? (heredoc !== undefined ? { heredoc } : { file: words[1] }) : {}
    if (head === 'cd' && words[1] !== undefined) cd = cd === undefined || words[1].startsWith('/') ? words[1] : `${cd}/${words[1]}`
    if (head === undefined || head.slice(head.lastIndexOf('/') + 1) !== 'kubectl') continue

    const rest = words.slice(1)
    let verbAt = 0
    while (verbAt < rest.length && (rest[verbAt] ?? '').startsWith('-')) {
      const word = rest[verbAt] ?? ''
      verbAt += VALUE_FLAGS.has(flagName(word)) && !hasInlineValue(word) ? 2 : 1
    }
    const verb = rest[verbAt]
    if (verb === undefined || !VERBS.has(verb)) continue
    if (rest.some(isDryRun) || rest.includes('--help') || rest.includes('-h')) continue
    if (verb === 'apply' && /^(?:view|edit|set)-last-applied$/.test(rest[verbAt + 1] ?? '')) continue

    const redirect = rest.findIndex(word => word === '<' || (word.startsWith('<') && word !== HEREDOC_MARK))
    const redirected = redirect < 0 ? undefined : rest[redirect] === '<' ? rest[redirect + 1] : rest[redirect]?.slice(1)
    const kept = redirect < 0 ? rest : rest.filter((_, i) => i !== redirect && !(rest[redirect] === '<' && i === redirect + 1))
    const args = kept.filter(word => word !== HEREDOC_MARK)
    const readsStdin = valueOf(args, ['-f', '--filename']) === '-'
    const fromFile = redirected ?? piped.file
    const body = heredoc ?? piped.heredoc
    const stdin = readsStdin && body !== undefined ? bodies[body] : undefined
    const sourced =
      readsStdin && stdin === undefined && fromFile !== undefined
        ? args.map(word => (word === '-' ? fromFile : word.replace(/^(--filename=)-$/, `$1${fromFile}`)))
        : args

    calls.push({
      verb: verb as KubectlCall['verb'],
      words: sourced,
      context: valueOf(sourced, ['--context']),
      namespace: valueOf(sourced, ['-n', '--namespace']),
      kubeconfig: valueOf(sourced, ['--kubeconfig']),
      cd,
      stdin,
      unpreviewable: readsStdin && stdin === undefined && fromFile === undefined ? 'its manifests come from another command' : undefined,
    })
  }
  return calls
}

/** The command that previews a call without changing anything: `kubectl diff`, or a server-side dry-run delete. */
export const previewArgv = (call: KubectlCall): string[] | undefined => {
  const verbAt = call.words.indexOf(call.verb)
  if (call.verb === 'delete') {
    const words: string[] = []
    for (let i = 0; i < call.words.length; i += 1) {
      const word = call.words[i] ?? ''
      const name = flagName(word)
      if (name === '-o' || name === '--output') {
        if (!hasInlineValue(word)) i += 1
        continue
      }
      if (name === '--wait' || name === '--now' || name === '-i' || name === '--interactive') continue
      words.push(word)
    }
    return ['kubectl', ...words, '--dry-run=server', '-o', 'name']
  }

  const kept: string[] = []
  let hasSource = false
  for (let i = 0; i < call.words.length; i += 1) {
    if (i === verbAt) continue
    const word = call.words[i] ?? ''
    const name = flagName(word)
    if (!word.startsWith('-')) continue
    const takesValue = VALUE_FLAGS.has(name) && !hasInlineValue(word)
    if (DIFF_FLAGS.has(name)) {
      kept.push(word)
      if (takesValue && call.words[i + 1] !== undefined) kept.push(call.words[i + 1] ?? '')
      if (['-f', '--filename', '-k', '--kustomize'].includes(name)) hasSource = true
    }
    if (takesValue) i += 1
  }
  return hasSource ? ['kubectl', 'diff', ...kept] : undefined
}

/** `apps.v1.Deployment.default.web` → `Deployment default/web`; another name as it is. */
export const objectName = (file: string): string => {
  const base = file.slice(file.lastIndexOf('/') + 1).trim()
  const match = /^(?:(.*?)\.)?(v\d+(?:(?:alpha|beta)\d+)?)\.([A-Z][A-Za-z0-9]*)\.([a-z0-9-]*)\.(.+)$/.exec(base)
  if (match === null) return base
  const [, , , kind = '', namespace = '', name = ''] = match
  return namespace === '' ? `${kind} ${name}` : `${kind} ${namespace}/${name}`
}

/** The objects `kubectl diff` (diff -u -N) reports, each with its hunks and line counts. */
export const parseDiff = (output: string): K8sDryRunObject[] => {
  const objects: K8sDryRunObject[] = []
  let current: { name: string; lines: string[] } | undefined
  const close = () => {
    if (current === undefined) return
    const hunks = current.lines
    const adds = hunks.filter(line => line.startsWith('+')).length
    const dels = hunks.filter(line => line.startsWith('-')).length
    const first = hunks.find(line => line.startsWith('@@')) ?? ''
    const change = /^@@ -0,0 /.test(first) ? 'create' : /^@@ -\d+(?:,\d+)? \+0,0 @@/.test(first) ? 'delete' : 'update'
    let diff = hunks.join('\n')
    if (diff.length > MAX_OBJECT_DIFF) {
      const cut = diff.lastIndexOf('\n@@', MAX_OBJECT_DIFF)
      diff = diff.slice(0, cut > 0 ? cut : diff.lastIndexOf('\n', MAX_OBJECT_DIFF))
    }
    if (adds + dels > 0) objects.push({ name: current.name, change, adds, dels, diff })
    current = undefined
  }
  for (const line of output.split('\n')) {
    const header = /^diff (?:-\S+ )*(\S+) (\S+)\s*$/.exec(line)
    if (header !== null) {
      close()
      current = { name: objectName(header[2] ?? header[1] ?? ''), lines: [] }
      continue
    }
    if (current === undefined || line.startsWith('--- ') || line.startsWith('+++ ')) continue
    if (current.lines.length > 0 || line.startsWith('@@')) current.lines.push(line)
  }
  close()
  return objects
}

/** The objects a server-side dry-run delete names (`deployment.apps/web`). */
export const parseDeleted = (output: string): K8sDryRunObject[] =>
  output
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^[\w.-]+\/[\w.:-]+$/.test(line))
    .map(name => ({ name, change: 'delete' as const, adds: 0, dels: 0, diff: '' }))

/** The exact command on its context, the key an approval is kept under. */
export const approvalKey = (command: string, context: string | null): string => `${command.trim().replace(/\s+/g, ' ')}\u0000${context ?? ''}`
