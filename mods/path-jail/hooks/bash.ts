/**
 * Finds the paths a command line would write to (redirections and the usual file commands), and the `cd` in
 * effect where each one is written. The words come from the shared claude-mods shell reader (`shared/shell`:
 * quotes, escapes, heredocs, fd duplication, wrappers); this file walks them in order to keep the `cd` chain.
 * Best effort: a shell is Turing complete.
 */
import { operands, shellReadsStdin, shellScriptArg, tokenize, unwrap, type ShellRedirect } from './shared/shell'

/** One path a command would write, and the `cd` target in effect before it (undefined: the shell's cwd). */
export type WriteTarget = {
  path: string
  /** `cd` arguments seen earlier on the line, in order; the target is relative to the last. */
  cdChain: readonly string[]
  /** What writes it, for messages: `>`, `tee`, `rm`, ... */
  via: string
}

const SEPARATORS = new Set(['&&', '||', ';', '|', '|&', '&', '\n', '(', ')', '{', '}'])
const SAFE_DEVICES = /^\/dev\/(?:null|zero|stdout|stderr|stdin|tty|fd\/\d+)$/
/** How deep scripts handed to a shell (`bash -c`, `eval`, a heredoc fed to `sh`) are opened up. */
const MAX_NESTING = 3

/** `-t DIR` / `--target-directory=DIR` of cp, mv, ln, install. */
const targetDirectory = (args: readonly string[]): string | undefined => {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string
    if (arg === '-t' || arg === '--target-directory') return args[i + 1]
    if (arg.startsWith('--target-directory=')) return arg.slice('--target-directory='.length)
    if (/^-[a-zA-Z]*t$/.test(arg) && !arg.startsWith('--')) return args[i + 1]
  }
  return undefined
}

/** Arguments of options that take a value, so they are not read as operands. */
const withoutOptionValues = (args: readonly string[], valued: ReadonlySet<string>): string[] =>
  args.filter((arg, index) => !valued.has(args[index - 1] ?? '') || arg.startsWith('-'))

/** Options whose value is the next argument, per command, so the value is not read as a path. */
const VALUED_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  touch: new Set(['-r', '-d', '-t', '--reference', '--date']),
  mkdir: new Set(['-m', '--mode']),
  truncate: new Set(['-s', '--size', '-r', '--reference']),
  shred: new Set(['-n', '-s', '--iterations', '--size']),
  mv: new Set(['-t', '-S', '--target-directory', '--suffix']),
  cp: new Set(['-t', '-S', '--target-directory', '--suffix']),
  ln: new Set(['-t', '-S', '--target-directory', '--suffix']),
  install: new Set(['-t', '-S', '-m', '-o', '-g', '--target-directory', '--suffix', '--mode', '--owner', '--group']),
  rsync: new Set(['-e', '--rsh', '--exclude', '--include', '--filter', '-f']),
  sed: new Set(['-e', '-f', '--expression', '--file', '-l', '--line-length']),
  perl: new Set(['-e', '-E', '-M', '-I']),
}
const NO_VALUED: ReadonlySet<string> = new Set()

/** The paths one simple command (`argv`) writes, by what the command is; a nested `sh -c` or `eval` script is read too. */
const writesOf = (argv: readonly string[], depth: number): { path: string; via: string; cdChain?: readonly string[] }[] => {
  const name = (argv[0] ?? '').replace(/^.*\//, '')
  const args = argv.slice(1)
  const list = operands(withoutOptionValues(args, VALUED_OPTIONS[name] ?? NO_VALUED))
  const each = (paths: readonly string[], via = name) => paths.map(path => ({ path, via }))

  switch (name) {
    case 'tee':
    case 'rm':
    case 'rmdir':
    case 'unlink':
    case 'touch':
    case 'mkdir':
    case 'truncate':
    case 'shred':
      return each(list)
    case 'mv': {
      // A move writes its destination and removes its sources: every operand counts.
      const directory = targetDirectory(args)
      return each([...list, ...(directory === undefined ? [] : [directory])])
    }
    case 'cp':
    case 'ln':
    case 'install': {
      const directory = targetDirectory(args)
      if (directory !== undefined) return each([directory])
      return list.length >= 2 ? each([list[list.length - 1] as string]) : []
    }
    case 'rsync': {
      const destination = list.length >= 2 ? (list[list.length - 1] as string) : undefined
      // `host:path` is a remote destination, not a local write.
      return destination === undefined || /^[^/]*:/.test(destination) ? [] : each([destination])
    }
    case 'dd':
      return each(args.filter(arg => arg.startsWith('of=')).map(arg => arg.slice(3)))
    case 'sed':
    case 'perl': {
      const isInPlace = args.some(arg => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith('--in-place'))
      if (!isInPlace) return []
      const hasScriptOption = args.some(arg => ['-e', '-E', '-f', '--expression', '--file'].includes(arg))
      return each(hasScriptOption ? list : list.slice(1))
    }
    case 'chmod':
    case 'chown':
    case 'chgrp':
      return each(list.slice(1))
    case 'find': {
      if (!args.includes('-delete')) return []
      const starts: string[] = []
      for (const arg of args) {
        if (arg.startsWith('-') || arg === '(' || arg === '!') break
        starts.push(arg)
      }
      return each(starts.length === 0 ? ['.'] : starts)
    }
    case 'eval':
      return depth < MAX_NESTING ? writeTargets(args.join(' '), depth + 1) : []
    default: {
      // `bash -c`, `sh -ec`, `su -c` and the like: the script is read with its own `cd`s.
      const script = shellScriptArg(argv)
      return script === undefined || depth >= MAX_NESTING ? [] : writeTargets(script, depth + 1)
    }
  }
}

/** Every path `command` would write to, with the `cd`s that precede it on the line. */
export const writeTargets = (command: string, depth = 0): WriteTarget[] => {
  const targets: WriteTarget[] = []
  const cdChain: string[] = []
  let words: string[] = []
  let heredocBodies: string[] = []
  let isRedirectTarget: ShellRedirect | undefined

  const nestedTargets = (script: string): void => {
    if (depth >= MAX_NESTING) return
    for (const nested of writeTargets(script, depth + 1)) targets.push({ ...nested, cdChain: [...cdChain, ...nested.cdChain] })
  }

  const flush = (): void => {
    // `sudo -u root rm …`, `timeout 5 rm …`, `env A=1 xargs rm …`: wrappers, their options and assignments go.
    const { argv } = unwrap(words)
    if (argv[0] === 'cd' || argv[0] === 'pushd') {
      const directory = operands(argv.slice(1))[0]
      cdChain.push(directory ?? '~')
    } else {
      for (const write of writesOf(argv, depth)) {
        targets.push({ path: write.path, via: write.via, cdChain: [...cdChain, ...(write.cdChain ?? [])] })
      }
      // `bash <<EOF … EOF`, `sh <<< "…"`: the shell runs what it reads.
      if (shellReadsStdin(argv)) for (const body of heredocBodies) nestedTargets(body)
    }
    words = []
    heredocBodies = []
  }

  for (const token of tokenize(command)) {
    if (isRedirectTarget !== undefined) {
      if (token.kind === 'word') {
        if (isRedirectTarget.isWrite && !SAFE_DEVICES.test(token.text)) {
          targets.push({ path: token.text, via: isRedirectTarget.text, cdChain: [...cdChain] })
        }
        if (isRedirectTarget.text === '<<<') heredocBodies.push(token.text)
        isRedirectTarget = undefined
        continue
      }
      isRedirectTarget = undefined
    }
    if (token.kind === 'redirect') {
      if (token.isHeredoc) heredocBodies.push(token.body ?? '')
      else isRedirectTarget = token
      continue
    }
    if (token.kind === 'op') {
      if (SEPARATORS.has(token.text)) flush()
      continue
    }
    words.push(token.text)
    for (const body of token.substitutions) nestedTargets(body)
  }
  flush()
  return targets
}
