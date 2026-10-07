// Pure shell reading for scope-lock: the files a Bash command line would write, with the `cd`s
// before them. The words come from the shared claude-mods shell reader (`shared/shell`: quotes, escapes,
// heredocs, fd duplication, wrappers); this file walks them in order to keep the `cd` chain.
// Best effort and conservative: a shell is a programming language. No `$` here.
import { shellReadsStdin, shellScriptArg, tokenize, unwrap, type ShellRedirect } from './shared/shell'

/** One path a command would write, and the `cd` arguments in effect before it, in order. */
export type WriteTarget = { path: string; via: string; cdChain: readonly string[] }

const SEPARATORS = new Set([';', '&&', '||', '|', '|&', '&', '\n', '(', ')', '{', '}'])
const SAFE_DEVICE = /^\/dev\/(?:null|zero|stdout|stderr|stdin|tty|fd\/\d+)$/
/** How deep scripts handed to a shell (`bash -c`, `eval`, a heredoc fed to `sh`) are opened up. */
const MAX_NESTING = 3
/** Git's own options that take the next word as their value. */
const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])
/** `git stash` subcommands that leave the working tree alone. */
const STASH_READS = new Set(['list', 'show', 'drop', 'clear', 'create', 'store'])
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

/** The paths one simple command writes; a nested `sh -c` or `eval` script is read with its own `cd`s. */
const writesOf = (argv: readonly string[], depth: number): { path: string; via: string; cdChain?: readonly string[] }[] => {
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
    let at = 0
    let directory: string | undefined
    while (at < args.length && (args[at] as string).startsWith('-')) {
      if (args[at] === '-C') directory = args[at + 1]
      at += GIT_VALUED.has(args[at] as string) ? 2 : 1
    }
    const [sub = '', ...rest] = args.slice(at)
    // `git -C app rm x` removes app/x.
    const inRepo = (paths: readonly string[]) => (directory === undefined ? paths : paths.map(path => (/^(?:[A-Za-z]:)?[\\/]/.test(path) ? path : `${directory}/${path}`)))
    const files = operandsOf('git', rest)
    if (sub === 'rm' || sub === 'mv' || sub === 'restore') return each(inRepo(files), `git ${sub}`)
    if (sub === 'checkout' && rest.includes('--')) return each(inRepo(rest.slice(rest.indexOf('--') + 1)), 'git checkout')
    const isStashWrite = sub === 'stash' && !STASH_READS.has(rest[0] ?? '')
    if ((sub === 'clean' && rest.some(arg => /^-[a-zA-Z]*f/.test(arg))) || (sub === 'reset' && rest.includes('--hard')) || isStashWrite) {
      return each(inRepo(['.']), `git ${sub}`)
    }
    return []
  }
  if (depth >= MAX_NESTING) return []
  if (name === 'eval') return writeTargets(args.join(' '), depth + 1)
  // `bash -c`, `sh -lc`, `su -c` and the like.
  const script = shellScriptArg(argv)
  return script === undefined ? [] : writeTargets(script, depth + 1)
}

/** Every path `command` would write, with the `cd`s that precede it on the line. */
export const writeTargets = (command: string, depth = 0): WriteTarget[] => {
  const targets: WriteTarget[] = []
  const cdChain: string[] = []
  let words: string[] = []
  let heredocBodies: string[] = []
  let pending: ShellRedirect | undefined
  const nestedTargets = (script: string) => {
    if (depth >= MAX_NESTING) return
    for (const nested of writeTargets(script, depth + 1)) targets.push({ ...nested, cdChain: [...cdChain, ...nested.cdChain] })
  }
  const flush = () => {
    // Wrappers (`sudo`, `env`, `timeout`, `xargs`, …), their options and `NAME=value` words go.
    const { argv } = unwrap(words)
    if (argv[0] === 'cd' || argv[0] === 'pushd') cdChain.push(operandsOf('cd', argv.slice(1))[0] ?? '~')
    else {
      for (const write of writesOf(argv, depth)) targets.push({ path: write.path, via: write.via, cdChain: [...cdChain, ...(write.cdChain ?? [])] })
      // `bash <<EOF … EOF`, `sh <<< "…"`: the shell runs what it reads.
      if (shellReadsStdin(argv)) for (const body of heredocBodies) nestedTargets(body)
    }
    words = []
    heredocBodies = []
  }
  for (const token of tokenize(command)) {
    if (pending !== undefined) {
      if (token.kind === 'word' && pending.isWrite && !SAFE_DEVICE.test(token.text)) targets.push({ path: token.text, via: pending.text, cdChain: [...cdChain] })
      if (token.kind === 'word' && pending.text === '<<<') heredocBodies.push(token.text)
      pending = undefined
      if (token.kind === 'word') continue
    }
    if (token.kind === 'redirect') {
      if (token.isHeredoc) heredocBodies.push(token.body ?? '')
      else pending = token
    } else if (token.kind === 'op') {
      if (SEPARATORS.has(token.text)) flush()
    } else {
      words.push(token.text)
      for (const body of token.substitutions) nestedTargets(body)
    }
  }
  flush()
  return targets
}
