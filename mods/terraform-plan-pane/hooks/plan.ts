import type { TfPlan, TfPlanAction, TfPlanResource } from '../types'
import { simpleCommands } from './shared/shell'

/** How a Bash command ran a plan: which tool, in which folder, and the plan file it wrote. */
export type PlanCommand = {
  tool: TfPlan['tool']
  /** Where `cd` moved before the plan, relative or absolute; undefined when it did not. */
  cd: string | undefined
  /** The `-chdir=<dir>` global option, when given. */
  chdir: string | undefined
  /** The `-out` plan file, when given. */
  out: string | undefined
}

/** What a plan's output or JSON says. */
export type ParsedPlan = Pick<TfPlan, 'resources' | 'summary' | 'isNoChanges' | 'error'>

/** Actions in the order the pane lists them: the dangerous ones first. */
export const ACTION_ORDER: readonly TfPlanAction[] = ['destroy', 'replace', 'update', 'create', 'import', 'move', 'read']

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g
const HEADER =
  /^\s*#\s+(.+?)\s+(will be created|will be updated in-place|will be destroyed|must be replaced|is tainted, so must be replaced|will be replaced, as requested|will be read during apply|will be imported|has moved to\s+\S+)\s*$/
const DEPOSED = /\s+\(deposed object [^)]*\)$/
const REASON = /^\s*#\s+\((.+)\)\s*$/
const FORCES = /^\s*[-+~]?\s*("?[\w.\-[\]"]+"?)\s*(?:=|\{).*#\s*forces replacement/
const SUMMARY = /Plan:\s+(?:(\d+) to import,\s+)?(\d+) to add,\s+(\d+) to change,\s+(\d+) to destroy/
const NO_CHANGES = /No changes\.\s+(?:Your infrastructure matches|Infrastructure is up-to-date)/
const ERROR_LINE = /^[\s│╷╵]*Error:\s*(.+)$/m

const ACTION_OF: Record<string, TfPlanAction> = {
  'will be created': 'create',
  'will be updated in-place': 'update',
  'will be destroyed': 'destroy',
  'must be replaced': 'replace',
  'is tainted, so must be replaced': 'replace',
  'will be replaced, as requested': 'replace',
  'will be read during apply': 'read',
  'will be imported': 'import',
}

const JSON_REASONS: Record<string, string> = {
  replace_because_tainted: 'tainted',
  replace_by_request: 'replacement requested',
  replace_because_cannot_update: 'cannot update in place',
  delete_because_no_resource_config: 'not in configuration',
  delete_because_no_module: 'its module is gone',
  delete_because_wrong_repetition: 'count/for_each changed',
  delete_because_count_index: 'count index out of range',
  delete_because_each_key: 'key not in for_each',
  delete_because_no_move_target: 'moved target missing',
}

export const stripAnsi = (text: string): string => text.replace(ANSI, '')

const joinPath = (base: string | undefined, next: string): string =>
  base === undefined || next.startsWith('/') || next.startsWith('~') ? next : `${base.replace(/\/$/, '')}/${next}`

/**
 * The plan a Bash command runs, if it runs one: `terraform plan`, `tofu plan`, after `cd dir &&`, with `-chdir=dir`
 * and `-out=file` read off the words. Commands come from the shared shell reader (wrappers and `NAME=value` peeled,
 * pipelines, `bash -c "…"` opened).
 */
export const parsePlanCommand = (command: string): PlanCommand | undefined => {
  let cd: string | undefined
  for (const { name, argv } of simpleCommands(command)) {
    if (name === 'cd' || name === 'pushd') {
      const target = argv[1]
      if (target !== undefined && target !== '-') cd = joinPath(cd, target)
      continue
    }
    if (name !== 'terraform' && name !== 'tofu') continue

    let chdir: string | undefined
    let index = 1
    for (; index < argv.length && (argv[index] ?? '').startsWith('-'); index += 1) {
      const option = /^--?chdir=(.+)$/.exec(argv[index] ?? '')
      if (option !== null) chdir = option[1]
    }
    if (argv[index] !== 'plan') continue

    let out: string | undefined
    for (let i = index + 1; i < argv.length; i += 1) {
      const word = argv[i] ?? ''
      const inline = /^--?out=(.+)$/.exec(word)
      if (inline !== null) out = inline[1]
      else if ((word === '-out' || word === '--out') && argv[i + 1] !== undefined) out = argv[i + 1]
    }
    return { tool: name, cd, chdir, out }
  }
  return undefined
}

/** The resources, summary line and error a plan printed. */
export const parsePlanText = (output: string): ParsedPlan => {
  const text = stripAnsi(output)
  const resources: TfPlanResource[] = []
  let current: { resource: TfPlanResource; forces: string[]; isInBody: boolean } | undefined

  const close = () => {
    if (current === undefined) return
    if (current.forces.length > 0) current.resource.detail = `forces replacement: ${[...new Set(current.forces)].join(', ')}`
    resources.push(current.resource)
    current = undefined
  }

  for (const line of text.split('\n')) {
    const header = HEADER.exec(line)
    if (header !== null) {
      close()
      const phrase = header[2] ?? ''
      let address = header[1] ?? ''
      let detail: string | null = null
      if (DEPOSED.test(address)) {
        address = address.replace(DEPOSED, '')
        detail = 'deposed object'
      }
      if (phrase.startsWith('has moved to')) {
        detail = `moved to ${phrase.replace(/^has moved to\s+/, '')}`
        current = { resource: { address, action: 'move', detail }, forces: [], isInBody: false }
      } else {
        const action = ACTION_OF[phrase] ?? 'update'
        if (phrase.startsWith('is tainted')) detail = 'tainted'
        if (phrase.startsWith('will be replaced, as requested')) detail = 'replacement requested'
        current = { resource: { address, action, detail }, forces: [], isInBody: false }
      }
      continue
    }
    if (current === undefined) continue
    // The `# (because …)` lines stand between the header and the resource's body.
    const reason = current.isInBody ? null : REASON.exec(line)
    if (reason !== null) {
      current.resource.detail ??= reason[1]?.replace(/^because\s+/, '') ?? null
      continue
    }
    if (line.trim() !== '') current.isInBody = true
    const forced = FORCES.exec(line)
    if (forced !== null) current.forces.push((forced[1] ?? '').replace(/"/g, ''))
  }
  close()

  const summary = SUMMARY.exec(text)
  const isNoChanges = resources.length === 0 && NO_CHANGES.test(text)
  const error = resources.length === 0 && summary === null && !isNoChanges ? (ERROR_LINE.exec(text)?.[1]?.trim() ?? null) : null
  return {
    resources,
    summary:
      summary === null
        ? null
        : { import: Number(summary[1] ?? 0), add: Number(summary[2]), change: Number(summary[3]), destroy: Number(summary[4]) },
    isNoChanges,
    error,
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** The resources `terraform show -json <planfile>` lists; undefined when the text is no plan. */
export const parsePlanJson = (text: string): ParsedPlan | undefined => {
  let plan: unknown
  try {
    plan = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(plan) || !('format_version' in plan)) return undefined
  const changes = Array.isArray(plan.resource_changes) ? plan.resource_changes : []
  const resources: TfPlanResource[] = []
  for (const change of changes) {
    if (!isRecord(change) || typeof change.address !== 'string' || !isRecord(change.change)) continue
    const actions = Array.isArray(change.change.actions) ? change.change.actions.map(String) : []
    const previous = typeof change.previous_address === 'string' && change.previous_address !== change.address ? change.previous_address : undefined
    const reason = typeof change.action_reason === 'string' ? (JSON_REASONS[change.action_reason] ?? null) : null
    const isImport = isRecord(change.change.importing)
    const key = actions.join(',')

    let action: TfPlanAction | undefined
    let detail: string | null = reason
    if (key === 'create') action = isImport ? 'import' : 'create'
    else if (key === 'update') action = 'update'
    else if (key === 'delete') action = 'destroy'
    else if (key === 'read') action = 'read'
    else if (key === 'delete,create' || key === 'create,delete') {
      action = 'replace'
      const paths = Array.isArray(change.change.replace_paths) ? change.change.replace_paths : []
      const names = paths.map(path => (Array.isArray(path) ? path.map(String).join('.') : String(path))).filter(Boolean)
      if (names.length > 0) detail = `forces replacement: ${[...new Set(names)].join(', ')}`
    } else if (key === 'no-op' && isImport) action = 'import'
    else if (key === 'no-op' && previous !== undefined) action = 'move'
    if (action === undefined) continue
    if (previous !== undefined && detail === null) detail = `moved from ${previous}`
    resources.push({ address: change.address, action, detail })
  }
  return { resources, summary: null, isNoChanges: resources.every(resource => resource.action === 'read'), error: null }
}

/** How many resources each action touches. */
export const countsOf = (resources: readonly TfPlanResource[]): Record<TfPlanAction, number> => {
  const counts: Record<TfPlanAction, number> = { destroy: 0, replace: 0, update: 0, create: 0, import: 0, move: 0, read: 0 }
  for (const resource of resources) counts[resource.action] += 1
  return counts
}

/** `+2 ~1 -1 ±1`: a plan in a few characters, for the status line. */
export const shortCounts = (resources: readonly TfPlanResource[]): string => {
  const counts = countsOf(resources)
  const parts = [
    counts.create > 0 ? `+${counts.create}` : null,
    counts.update > 0 ? `~${counts.update}` : null,
    counts.replace > 0 ? `±${counts.replace}` : null,
    counts.destroy > 0 ? `-${counts.destroy}` : null,
    counts.import > 0 ? `⇣${counts.import}` : null,
    counts.move > 0 ? `→${counts.move}` : null,
  ].filter(part => part !== null)
  return parts.length === 0 ? 'no changes' : parts.join(' ')
}

const ENVIRONMENTS: readonly [RegExp, string][] = [
  [/(?:^|[^a-z])(?:prod|production|prd|live)(?:[^a-z]|$)/i, 'production'],
  [/(?:^|[^a-z])(?:stage|staging|stg|preprod|pre-prod)(?:[^a-z]|$)/i, 'staging'],
  [/(?:^|[^a-z])(?:dev|development)(?:[^a-z]|$)/i, 'development'],
  [/(?:^|[^a-z])(?:test|testing|qa|sandbox)(?:[^a-z]|$)/i, 'test'],
]

/** The environment a plan's folder names (`envs/prod`, `stacks/staging-eu`), or `unspecified` when it names none. */
export const environmentOf = (dir: string): string => ENVIRONMENTS.find(([pattern]) => pattern.test(dir))?.[1] ?? 'unspecified'
