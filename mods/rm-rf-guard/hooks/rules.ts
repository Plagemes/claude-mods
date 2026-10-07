import { baseName, simpleCommands, type ShellCommand } from './shared/shell'

/** What is dangerous (`rule` names the case, for mods-hub's risk.blocked), and the safer way. */
export type Danger = { rule: string; what: string; instead: string }

const SYSTEM_DIRS = new Set([
  '/', '/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/opt', '/proc', '/root', '/sbin', '/srv',
  '/sys', '/usr', '/usr/bin', '/usr/lib', '/usr/local', '/usr/share', '/var', '/var/lib', '/home', '/mnt',
  '/media', '/System', '/Library', '/Applications', '/Users', '/Volumes', '/private',
])
const HOME_FORMS = new Set(['~', '$HOME', '${HOME}'])
const WIPE_ALL = new Set(['*', '.*', '.', '..'])
const BLOCK_DEVICE = /^\/dev\/(?:sd|hd|vd|xvd|nvme|mmcblk|disk|rdisk|loop|dm-|md|mapper\/|sr)/
const FORK_BOMB = /(\w+|:)\(\)\{\1\|\1&\};\1/
const WORLD_WRITABLE = /^0?777$|^[ugoa]*[+=]rwx$/
const NOT_A_COMMAND = new Set(['echo', 'printf', 'man', 'which', 'whereis', 'type', 'alias', 'help', 'apropos'])
const DISK_WIPERS = new Set(['shred', 'wipefs', 'blkdiscard'])
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])
const DANGEROUS_NAME = /^(?:rm|git|chmod|chown|chgrp|find|dd|shred|wipefs|blkdiscard|mkfs(?:\..+)?)$/

/** Targets that take a home or a system directory with them (and, if asked, the whole working tree). */
function isCatastrophic(target: string, includeWorkingTree = true): boolean {
  const flat = target.replace(/\/+/g, '/').replace(/^\.\//, '').replace(/\/\.(?=\/|$)/g, '')
  const base = flat.replace(/\/\*$/, '').replace(/\/+$/, '')
  const resolved = base === '' && flat.startsWith('/') ? '/' : base
  return (
    SYSTEM_DIRS.has(resolved) ||
    HOME_FORMS.has(resolved) ||
    (includeWorkingTree && WIPE_ALL.has(resolved)) ||
    /^\/(?:home|Users)\/[^/]+$/.test(resolved) ||
    /^~[^/]+$/.test(resolved)
  )
}

function flagsOf(args: readonly string[]): string[] {
  const end = args.indexOf('--')
  return (end === -1 ? args : args.slice(0, end)).filter(arg => arg.startsWith('-'))
}

function operandsOf(args: readonly string[]): string[] {
  const end = args.indexOf('--')
  const after = end === -1 ? [] : args.slice(end + 1)
  return [...args.slice(0, end === -1 ? args.length : end).filter(arg => !arg.startsWith('-')), ...after]
}

function hasShortFlag(flags: readonly string[], letters: string): boolean {
  const pattern = new RegExp(`^-[a-zA-Z]*[${letters}]`)
  return flags.some(flag => !flag.startsWith('--') && pattern.test(flag))
}

function isRecursive(flags: readonly string[]): boolean {
  return hasShortFlag(flags, 'rR') || flags.includes('--recursive')
}

function gitSubcommand(args: readonly string[]): { name: string; rest: string[] } | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (GIT_OPTIONS_WITH_VALUE.has(arg)) i += 1
    else if (!arg.startsWith('-')) return { name: arg, rest: args.slice(i + 1) }
  }
  return undefined
}

function gitDanger(args: readonly string[], allowGitReset: boolean): Danger | undefined {
  const sub = gitSubcommand(args)
  if (!sub || allowGitReset) return undefined
  const flags = flagsOf(sub.rest)
  if (sub.name === 'reset' && flags.includes('--hard')) {
    return { rule: 'git-reset-hard', what: 'git reset --hard throws away every uncommitted change', instead: 'git stash first, or git reset --keep. Enable allowGitReset to permit it.' }
  }
  const isDryRun = flags.includes('--dry-run') || hasShortFlag(flags, 'n')
  const isForced = flags.includes('--force') || hasShortFlag(flags, 'f')
  const reachesFar = hasShortFlag(flags, 'dxX')
  if (sub.name === 'clean' && isForced && reachesFar && !isDryRun) {
    return { rule: 'git-clean', what: 'git clean -fd/-fdx deletes untracked (and ignored) files for good', instead: 'preview with git clean -n, or delete the specific paths. Enable allowGitReset to permit it.' }
  }
  return undefined
}

function rmDanger(args: readonly string[]): Danger | undefined {
  const flags = flagsOf(args)
  if (flags.includes('--no-preserve-root')) {
    return { rule: 'no-preserve-root', what: 'rm --no-preserve-root disables the safeguard that protects /', instead: 'name the exact directory you mean to delete.' }
  }
  if (!isRecursive(flags)) return undefined
  const target = operandsOf(args).find(operand => isCatastrophic(operand))
  return target === undefined
    ? undefined
    : { rule: 'rm-catastrophic', what: `recursive rm of "${target}" would wipe a home, system or whole working directory`, instead: 'delete the specific paths (rm -rf ./build) or move them to a trash folder.' }
}

function permissionDanger(name: string, args: readonly string[]): Danger | undefined {
  const flags = flagsOf(args)
  if (!isRecursive(flags)) return undefined
  const operands = operandsOf(args)
  if (name === 'chmod' && operands.some(operand => WORLD_WRITABLE.test(operand))) {
    return { rule: 'chmod-777', what: 'chmod -R 777 makes everything world-writable', instead: 'use chmod -R u+rwX,go+rX, or fix the one path that needs it.' }
  }
  const target = operands.find(operand => isCatastrophic(operand))
  return target === undefined
    ? undefined
    : { rule: 'recursive-permissions', what: `recursive ${name} of "${target}" would rewrite permissions system-wide`, instead: 'limit it to the project directory that needs it.' }
}

function diskDanger(name: string, args: readonly string[]): Danger | undefined {
  const instead = 'run it yourself outside Claude, against a device you have double-checked.'
  if (/^mkfs(?:\..+)?$/.test(name)) return { rule: 'mkfs', what: `${name} formats a filesystem`, instead }
  if (name === 'dd' && args.some(arg => arg.startsWith('of=') && BLOCK_DEVICE.test(arg.slice(3)))) {
    return { rule: 'dd-to-disk', what: 'dd writing straight to a disk device', instead }
  }
  if (DISK_WIPERS.has(name) && args.some(arg => BLOCK_DEVICE.test(arg))) return { rule: 'disk-wipe', what: `${name} on a disk device`, instead }
  return undefined
}

function findDanger(args: readonly string[]): Danger | undefined {
  const firstOption = args.findIndex(arg => arg.startsWith('-') || arg === '(' || arg === '!')
  const roots = firstOption === -1 ? args : args.slice(0, firstOption)
  const target = args.includes('-delete') ? roots.find(root => isCatastrophic(root, false)) : undefined
  return target === undefined ? undefined : { rule: 'find-delete', what: `find ${target} -delete would wipe it`, instead: 'narrow the starting directory and preview with -print first.' }
}

function commandDanger(command: ShellCommand, allowGitReset: boolean): Danger | undefined {
  const redirect = command.redirects.find(({ op, target }) => op.includes('>') && BLOCK_DEVICE.test(target))
  if (redirect !== undefined) return { rule: 'device-redirect', what: `redirecting output onto ${redirect.target}`, instead: 'write to a file, not a disk device.' }
  if (NOT_A_COMMAND.has(command.name)) return undefined

  // Wrappers the shared reader does not know (`strace rm …`, `setsid rm …`) still reach the dangerous word.
  const names = command.argv.map(baseName)
  const index = names.findIndex(name => DANGEROUS_NAME.test(name))
  const name = names[index]
  if (index === -1 || name === undefined) return undefined
  const args = command.argv.slice(index + 1)

  if (name === 'rm') return rmDanger(args)
  if (name === 'git') return gitDanger(args, allowGitReset)
  if (name === 'chmod' || name === 'chown' || name === 'chgrp') return permissionDanger(name, args)
  if (name === 'find') return findDanger(args)
  return diskDanger(name, args)
}

/**
 * The first catastrophic thing a command line does, or undefined. The shared shell reader opens the scripts
 * handed to `bash -c`, `su -c`, `eval`, `$(…)`, backticks and heredocs fed to a shell, so they are judged too.
 */
export function dangerIn(raw: string, allowGitReset: boolean): Danger | undefined {
  if (FORK_BOMB.test(raw.replace(/\s+/g, ''))) return { rule: 'fork-bomb', what: 'this is a fork bomb', instead: 'do not run it.' }
  for (const command of simpleCommands(raw)) {
    const danger = commandDanger(command, allowGitReset)
    if (danger) return danger
  }
  return undefined
}
