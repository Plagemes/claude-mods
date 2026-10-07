/**
 * Guardian's own fallback guard: the few cases bad enough to stop at the strict level when the guard mod that
 * would normally catch them is not installed. Deliberately compact and conservative; the guard mods do the full job.
 * Pure: no `$`, no I/O.
 */
import type { FallbackRule } from './policy'
import { baseName, operands, simpleCommands } from './shared/shell'
import type { ShellCommand } from './shared/shell'
import { hasSecret } from './shared/secrets'

export type Finding = {
  rule: FallbackRule
  /** The guard mod this case belongs to. */
  guard: string
  reason: string
  command?: string
  path?: string
}

export const RULE_GUARD: Readonly<Record<FallbackRule, string>> = {
  'rm-root': 'rm-rf-guard',
  'force-push': 'force-push-guard',
  'curl-pipe': 'curl-pipe-guard',
  'secret-write': 'secret-shield',
  'env-read': 'env-guard',
  'prod-destroy': 'prod-guard',
}

/** Targets whose recursive deletion loses a machine or a home folder, or the whole project. */
const ROOT_TARGETS = new Set(['/', '/*', '~', '~/', '~/*', '$HOME', '$HOME/', '$HOME/*', '${HOME}', '${HOME}/', '${HOME}/*', '.', './', './*', '..', '../', '*'])
const SYSTEM_DIRS = /^\/(?:bin|boot|dev|etc|home|lib|lib64|opt|root|sbin|srv|sys|usr|var|Users|Applications|System|Library)\/?\*?$/
const PROTECTED_BRANCH = /^(?:refs\/heads\/)?(?:main|master|production|prod|release)$/
const DOWNLOADERS = new Set(['curl', 'wget', 'fetch', 'http', 'https', 'xh'])
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'python', 'python3', 'node', 'perl', 'ruby', 'php'])
const PROCESS_SUBSTITUTION = /(?:^|[\s;&|])(?:(?:ba|z|da|k)?sh|source|\.)\s+<\(\s*(?:curl|wget)\b/
const ENV_FILE = /^\.env(?:\.[\w.-]+)?$/
const ENV_TEMPLATE = /\.(?:example|sample|template|dist)$/
const READERS = new Set(['cat', 'less', 'more', 'head', 'tail', 'bat', 'source', '.', 'grep', 'rg', 'awk', 'sed', 'cut', 'sort', 'strings', 'xxd', 'od', 'base64', 'cp', 'scp', 'curl'])
const PROD = /(^|[-_./:=\s])(prod|production|prd|live)([-_./:=\s]|$)/i
const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])

const isRecursive = (args: readonly string[]): boolean =>
  args.some(arg => arg === '--recursive' || arg === '-R' || (/^-[a-zA-Z]+$/.test(arg) && /[rR]/.test(arg)))

function rmRoot(cmd: ShellCommand): string | undefined {
  if (cmd.name !== 'rm' || !isRecursive(cmd.argv.slice(1))) return undefined
  if (cmd.argv.includes('--no-preserve-root')) return 'rm --no-preserve-root'
  const target = operands(cmd.argv.slice(1)).find(arg => ROOT_TARGETS.has(arg) || SYSTEM_DIRS.test(arg))
  return target === undefined ? undefined : `rm -r ${target} deletes far more than a project file`
}

/** `git [global options] push …` → the push's own arguments, or undefined. */
function pushArgs(cmd: ShellCommand): string[] | undefined {
  if (cmd.name !== 'git') return undefined
  let at = 1
  while (at < cmd.argv.length && (cmd.argv[at] ?? '').startsWith('-')) at += GIT_VALUED.has(cmd.argv[at] ?? '') ? 2 : 1
  return cmd.argv[at] === 'push' ? cmd.argv.slice(at + 1) : undefined
}

function forcePush(cmd: ShellCommand): string | undefined {
  const args = pushArgs(cmd)
  if (args === undefined) return undefined
  const isDelete = args.includes('--delete') || args.includes('-d')
  const isForce = args.some(arg => arg === '--force' || arg === '--mirror' || arg.startsWith('--force-with-lease') || (/^-[a-zA-Z]+$/.test(arg) && arg.includes('f')))
  const refspecs = operands(args).slice(1)
  const branchOf = (spec: string): string => spec.replace(/^\+/, '').split(':').pop() ?? ''
  const hitsProtected = refspecs.some(spec => PROTECTED_BRANCH.test(branchOf(spec)))
  if (isDelete && hitsProtected) return 'deleting a protected branch on the remote'
  if (refspecs.some(spec => spec.startsWith(':') && PROTECTED_BRANCH.test(branchOf(spec)))) return 'deleting a protected branch on the remote'
  const isPlusForce = refspecs.some(spec => spec.startsWith('+'))
  if (!isForce && !isPlusForce) return undefined
  if (hitsProtected) return 'force-pushing a protected branch rewrites shared history'
  if (refspecs.length === 0) return 'force push without naming a branch (it may be main); name a feature branch explicitly'
  return undefined
}

function curlPipe(commands: readonly ShellCommand[], line: string): string | undefined {
  if (PROCESS_SUBSTITUTION.test(line)) return 'running a downloaded script straight from the network'
  for (const cmd of commands) {
    if (cmd.stage === 0 || !INTERPRETERS.has(cmd.name)) continue
    const takesStdin = operands(cmd.argv.slice(1)).length === 0 || cmd.argv.includes('-') || cmd.argv.includes('-s')
    const feeder = commands.find(other => other.pipeline === cmd.pipeline && other.depth === cmd.depth && other.stage < cmd.stage && DOWNLOADERS.has(other.name))
    if (takesStdin && feeder !== undefined) return `piping ${feeder.name} into ${cmd.name} runs an unreviewed script`
  }
  const nested = commands.find(cmd => cmd.via === '$()' && DOWNLOADERS.has(cmd.name))
  if (nested !== undefined && commands.some(cmd => cmd.depth === 0 && INTERPRETERS.has(cmd.name) && cmd.argv.some(arg => arg === '-c'))) {
    return `running the output of ${nested.name} as a script`
  }
  return undefined
}

const isEnvFile = (path: string): boolean => {
  const name = baseName(path)
  return ENV_FILE.test(name) && !ENV_TEMPLATE.test(name)
}

function envRead(cmd: ShellCommand): string | undefined {
  if (!READERS.has(cmd.name) && !cmd.redirects.some(redirect => redirect.op === '<')) return undefined
  const files = [...operands(cmd.argv.slice(1)), ...cmd.redirects.filter(redirect => redirect.op === '<').map(redirect => redirect.target)]
  const hit = files.find(isEnvFile)
  return hit === undefined ? undefined : `reading ${hit} puts its secrets into the conversation`
}

function prodDestroy(cmd: ShellCommand): string | undefined {
  const words = cmd.argv.slice(1)
  const sub = words.find(word => !word.startsWith('-'))
  if ((cmd.name === 'terraform' || cmd.name === 'tofu') && (sub === 'destroy' || (sub === 'apply' && words.includes('-destroy')))) return `${cmd.name} destroy tears down real infrastructure`
  if (cmd.name === 'pulumi' && sub === 'destroy') return 'pulumi destroy tears down real infrastructure'
  const verb = cmd.name === 'kubectl' ? words.find(word => word === 'delete') : cmd.name === 'helm' ? words.find(word => word === 'uninstall' || word === 'delete') : undefined
  if (verb !== undefined && words.some(word => PROD.test(word))) return `${cmd.name} ${verb} against production`
  return undefined
}

/** Every critical case in one Bash command line. */
export function bashFindings(command: string): Finding[] {
  const commands = simpleCommands(command)
  const findings: Finding[] = []
  const add = (rule: FallbackRule, reason: string | undefined, path?: string): void => {
    if (reason !== undefined && !findings.some(finding => finding.rule === rule)) {
      findings.push({ rule, guard: RULE_GUARD[rule], reason, command, ...(path === undefined ? {} : { path }) })
    }
  }
  for (const cmd of commands) {
    add('rm-root', rmRoot(cmd))
    add('force-push', forcePush(cmd))
    add('env-read', envRead(cmd))
    add('prod-destroy', prodDestroy(cmd))
  }
  add('curl-pipe', curlPipe(commands, command))
  return findings
}

/** Every critical case in one tool call (Bash, Read, Write, Edit, NotebookEdit). */
export function criticalFindings(tool: string, input: Readonly<Record<string, unknown>>): Finding[] {
  const text = (key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '')
  if (tool === 'Bash') return bashFindings(text('command'))
  const path = text('file_path') || text('notebook_path')
  if (tool === 'Read' && isEnvFile(path)) {
    return [{ rule: 'env-read', guard: RULE_GUARD['env-read'], reason: `reading ${baseName(path)} puts its secrets into the conversation`, path }]
  }
  const written = tool === 'Write' ? text('content') : tool === 'Edit' ? text('new_string') : tool === 'NotebookEdit' ? text('new_source') : ''
  if (written !== '' && !isEnvFile(path) && hasSecret(written)) {
    return [{ rule: 'secret-write', guard: RULE_GUARD['secret-write'], reason: 'the new text holds what looks like a real key or token; read it from the environment instead', path }]
  }
  return []
}
