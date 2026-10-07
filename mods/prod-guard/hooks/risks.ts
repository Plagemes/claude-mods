import { baseName, type ShellCommand } from './shell'

export type Risk = {
  what: string
  /** True when the command does not name a kube context, so the current one decides. */
  needsKubeContext?: boolean
}

const KUBECTL_WRITES = new Set([
  'apply', 'delete', 'patch', 'replace', 'scale', 'rollout', 'edit', 'drain', 'cordon', 'uncordon', 'taint',
  'label', 'annotate', 'set', 'create', 'exec', 'cp', 'run', 'expose', 'autoscale', 'debug',
])
const HELM_WRITES = new Set(['upgrade', 'install', 'uninstall', 'delete', 'rollback'])
const OPTIONS_WITH_VALUE = new Set([
  '-n', '--namespace', '--context', '--kube-context', '--kubeconfig', '--cluster', '--user', '-s', '--server',
  '-f', '--values', '-l', '--selector', '-o', '--output', '--set', '--profile', '--region',
])
const IAC_TOOLS = new Set(['terraform', 'tofu', 'terragrunt'])
const SQL_CLIENTS = new Set(['psql', 'mysql', 'mariadb', 'pgcli', 'mycli', 'sqlcmd', 'sqlite3', 'clickhouse-client'])
const INTERESTING = new Set(['kubectl', 'helm', 'pulumi', 'aws', ...IAC_TOOLS, ...SQL_CLIENTS])

const DROP_STATEMENT = /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b/i
const TRUNCATE_STATEMENT = /\bTRUNCATE\s+(?:TABLE\s+)?[\w"`.]/i
const DELETE_STATEMENT = /\bDELETE\s+FROM\s+[^;]*(?:;|$)/gi

/** Values of `--flag value`, `--flag=value` and `-n value` style options. */
function flagValues(args: readonly string[], names: readonly string[]): string[] {
  const values: string[] = []
  args.forEach((arg, i) => {
    for (const name of names) {
      if (arg === name && args[i + 1] !== undefined) values.push(args[i + 1] as string)
      else if (arg.startsWith(`${name}=`)) values.push(arg.slice(name.length + 1))
    }
  })
  return values
}

/** The words that are not options or option values: the verb and what follows it. */
function subcommands(args: readonly string[]): string[] {
  const words: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (OPTIONS_WITH_VALUE.has(arg)) i += 1
    else if (!arg.startsWith('-')) words.push(arg)
  }
  return words
}

function kubeRisk(tool: string, args: readonly string[], isProd: (text: string) => boolean): Risk | undefined {
  const [verb, next] = subcommands(args)
  const isWrite = tool === 'kubectl' ? KUBECTL_WRITES.has(verb ?? '') : HELM_WRITES.has(verb ?? '')
  const isReadOnlyRollout = verb === 'rollout' && (next === 'status' || next === 'history')
  const isDryRun = args.some(arg => arg.startsWith('--dry-run'))
  if (!isWrite || isReadOnlyRollout || isDryRun) return undefined

  const contexts = flagValues(args, ['--context', '--kube-context'])
  const namespaces = flagValues(args, ['-n', '--namespace'])
  const everyValue = tool === 'helm' ? args.filter(arg => !arg.startsWith('-')) : []
  const named = [...contexts, ...namespaces, ...everyValue].find(isProd)
  const what = `${tool} ${verb}`
  if (named !== undefined) return { what: `${what} against "${named}"` }
  return contexts.length === 0 ? { what: `${what} on the current kube context`, needsKubeContext: true } : undefined
}

function awsRisk(args: readonly string[]): Risk | undefined {
  const verb = args.find(arg => /^(?:delete|terminate)-/.test(arg))
  if (verb !== undefined) return { what: `aws ... ${verb}` }
  const [service, action] = subcommands(args)
  const isBucketRemoval = service === 's3' && (action === 'rb' || (action === 'rm' && args.includes('--recursive')))
  return isBucketRemoval ? { what: `aws s3 ${action}` } : undefined
}

function sqlRisk(raw: string): Risk | undefined {
  if (DROP_STATEMENT.test(raw)) return { what: 'a DROP TABLE/DATABASE/SCHEMA statement' }
  if (TRUNCATE_STATEMENT.test(raw)) return { what: 'a TRUNCATE statement' }
  const hasUnscopedDelete = [...raw.matchAll(DELETE_STATEMENT)].some(([statement]) => !/\bWHERE\b/i.test(statement))
  return hasUnscopedDelete ? { what: 'a DELETE FROM without WHERE' } : undefined
}

/** Everything on a command line that can change a production system. */
export function findRisks(raw: string, commands: readonly ShellCommand[], isProd: (text: string) => boolean): Risk[] {
  const risks: Risk[] = []
  let usesSqlClient = false

  for (const { words } of commands) {
    const index = words.findIndex(word => INTERESTING.has(baseName(word)))
    const tool = words[index] === undefined ? '' : baseName(words[index] as string)
    const args = words.slice(index + 1)
    if (index === -1) continue

    if (IAC_TOOLS.has(tool) && subcommands(args).slice(0, 3).some(arg => arg === 'apply' || arg === 'destroy')) {
      risks.push({ what: `${tool} ${subcommands(args).find(arg => arg === 'apply' || arg === 'destroy')}` })
    } else if (tool === 'pulumi' && ['up', 'destroy'].includes(subcommands(args)[0] ?? '')) {
      risks.push({ what: `pulumi ${subcommands(args)[0]}` })
    } else if (tool === 'kubectl' || tool === 'helm') {
      const risk = kubeRisk(tool, args, isProd)
      if (risk) risks.push(risk)
    } else if (tool === 'aws') {
      const risk = awsRisk(args)
      if (risk) risks.push(risk)
    } else if (SQL_CLIENTS.has(tool)) {
      usesSqlClient = true
    }
  }

  const sql = usesSqlClient ? sqlRisk(raw) : undefined
  return sql ? [...risks, sql] : risks
}
