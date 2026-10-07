/**
 * The policy: which guard mods a level recommends and the option values it gives each of them, mapped to the
 * guards' real `userConfig` keys, and the diff between a policy and the user's settings.json `pluginConfigs`.
 * Pure: no `$`, no I/O.
 */

export type Level = 'permissive' | 'standard' | 'strict'
export type PolicyLevel = Level | 'custom'
export type OptionValue = string | number | boolean
export type Area = 'secrets' | 'shell' | 'git' | 'network' | 'supply-chain' | 'data' | 'privacy' | 'cloud' | 'quality'
/** The critical cases guardian's own fallback covers for a guard that is not installed (strict only). */
export type FallbackRule = 'rm-root' | 'force-push' | 'curl-pipe' | 'secret-write' | 'env-read' | 'prod-destroy'

export type GuardSpec = {
  name: string
  /** What it protects, in a few words. */
  title: string
  area: Area
  /** How much it counts towards the safety score. */
  weight: 1 | 2 | 3
  /** The lowest level that recommends installing it; absent: optional at every level. */
  from?: Level
  /** Files or folders at the project root that make it relevant; absent: relevant everywhere. */
  markers?: readonly string[]
  /** userConfig key → value at permissive, standard, strict. The standard value is always the guard's own default. */
  settings: Readonly<Record<string, readonly [OptionValue, OptionValue, OptionValue]>>
  fallback?: FallbackRule
}

export const LEVELS: readonly Level[] = ['permissive', 'standard', 'strict']
export const POLICY_LEVELS: readonly PolicyLevel[] = ['permissive', 'standard', 'strict', 'custom']

const PYTHON = ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile', 'uv.lock', 'poetry.lock']
const PACKAGES = ['package.json', ...PYTHON, 'Cargo.toml', 'go.mod', 'Gemfile', 'composer.json']
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Cargo.lock', 'go.sum', 'Gemfile.lock', 'composer.lock']
const DATABASE = ['migrations', 'db', 'prisma', 'alembic', 'alembic.ini', 'supabase', 'knexfile.js', 'knexfile.ts', 'drizzle.config.ts', 'ormconfig.json', 'manage.py', 'schema.sql', 'seeds']
const DOCKER = ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']
const REDACTOR_ALLOW = '^git@|^noreply@|@users\\.noreply\\.github\\.com$|@example\\.(com|org|net)$'
const PROD_PATTERN = '(^|[-_./:=\\s])(prod|production|prd|live)([-_./:=\\s]|$)'
const PROD_PATTERN_STRICT = '(^|[-_./:=\\s])(prod|production|prd|live|stage|staging|stg|preprod)([-_./:=\\s]|$)'

/**
 * Every guard mod guardian knows, most important first. The keys and value types were read from each guard's
 * plugin.json; the standard column repeats its defaults, so applying `standard` to a fresh install changes nothing.
 */
export const GUARDS: readonly GuardSpec[] = [
  {
    name: 'secret-shield', title: 'secrets in edits', area: 'secrets', weight: 3, from: 'permissive', fallback: 'secret-write',
    settings: { allowlist: ['(^|/)(tests?|fixtures?|__mocks__|examples?)/|EXAMPLE', '', ''] },
  },
  { name: 'rm-rf-guard', title: 'destructive deletes', area: 'shell', weight: 3, from: 'permissive', fallback: 'rm-root', settings: { allowGitReset: [true, false, false] } },
  {
    name: 'force-push-guard', title: 'force pushes', area: 'git', weight: 3, from: 'permissive', fallback: 'force-push',
    settings: { protectedBranches: ['main,master', 'main,master,develop,release/*', 'main,master,develop,release/*,hotfix/*,staging,production'] },
  },
  {
    name: 'env-guard', title: '.env and key files', area: 'secrets', weight: 3, from: 'permissive', fallback: 'env-read',
    settings: { extraProtected: ['', '', '*.pem,*.key,*.p12,*.pfx,*.tfvars,secrets/*,credentials*'], allowed: ['.env.test,.env.development', '', ''] },
  },
  {
    name: 'curl-pipe-guard', title: 'curl | sh', area: 'network', weight: 3, from: 'standard', fallback: 'curl-pipe',
    settings: { allowedHosts: ['sh.rustup.rs,get.docker.com,bun.sh,deno.land,astral.sh,install.python-poetry.org', '', ''] },
  },
  { name: 'prod-guard', title: 'production clusters', area: 'cloud', weight: 3, from: 'standard', fallback: 'prod-destroy', settings: { prodPattern: [PROD_PATTERN, PROD_PATTERN, PROD_PATTERN_STRICT] } },
  {
    name: 'redactor', title: 'secrets and PII in output', area: 'privacy', weight: 2, from: 'standard',
    settings: {
      secrets: [true, true, true], emails: [false, true, true], phones: [false, true, true], ibans: [true, true, true],
      cards: [true, true, true], privateIps: [false, false, true], allowlist: [REDACTOR_ALLOW, REDACTOR_ALLOW, '^noreply@|@users\\.noreply\\.github\\.com$'],
    },
  },
  { name: 'path-jail', title: 'writes outside the project', area: 'shell', weight: 2, from: 'standard', settings: { allowedRoots: ['/tmp,~/.cache', '/tmp', '/tmp'], blockUncheckable: [false, true, true] } },
  {
    name: 'dependency-sentinel', title: 'new and typosquatted packages', area: 'supply-chain', weight: 2, from: 'standard', markers: PACKAGES,
    settings: { minAgeDays: [7, 30, 90], minVersions: [1, 2, 5], checkRegistry: [true, true, true] },
  },
  { name: 'lockfile-guard', title: 'hand-edited lockfiles', area: 'supply-chain', weight: 1, from: 'standard', markers: LOCKFILES, settings: {} },
  { name: 'no-upload', title: 'uploads of local files', area: 'privacy', weight: 2, from: 'standard', settings: { allowWord: ['UPLOAD-OK', 'UPLOAD-OK', ''] } },
  { name: 'seed-guard', title: 'seeding remote databases', area: 'data', weight: 2, from: 'standard', markers: DATABASE, settings: { denyUnknown: [false, false, true] } },
  { name: 'migration-guard', title: 'edits to applied migrations', area: 'data', weight: 2, from: 'standard', markers: DATABASE, settings: { allowUncommitted: [true, false, false] } },
  { name: 'sql-safety', title: 'DROP / DELETE without WHERE', area: 'data', weight: 1, from: 'standard', markers: DATABASE, settings: { mode: ['warn', 'warn', 'block'] } },
  { name: 'docker-prune-guard', title: 'docker prune of volumes', area: 'shell', weight: 1, from: 'standard', markers: DOCKER, settings: {} },
  { name: 'gitignore-guard', title: 'staging ignored or huge files', area: 'git', weight: 1, from: 'standard', settings: { maxFileMb: [20, 5, 2] } },
  { name: 'main-branch-warn', title: 'edits on main', area: 'git', weight: 1, from: 'strict', settings: { block: [false, false, true] } },
  { name: 'url-allowlist', title: 'fetches to unknown hosts', area: 'network', weight: 1, from: 'strict', settings: { mode: ['block', 'allow', 'allow'], checkBash: [false, false, true] } },
  { name: 'tracker-guard', title: 'analytics trackers', area: 'privacy', weight: 1, from: 'strict', settings: { allowWord: ['TRACKER-OK', 'TRACKER-OK', ''], blockErrorTracking: [false, false, true] } },
  { name: 'pii-in-logs', title: 'personal data in logs', area: 'privacy', weight: 1, from: 'strict', settings: { mode: ['warn', 'warn', 'block'] } },
  { name: 'crypto-guard', title: 'weak cryptography', area: 'secrets', weight: 1, from: 'strict', settings: { mode: ['warn', 'warn', 'block'] } },
  { name: 'scope-lock', title: 'writes outside a set scope', area: 'shell', weight: 1, from: 'strict', settings: { allowTemp: [true, true, false], blockUncheckable: [false, true, true] } },
  { name: 'venv-guard', title: 'pip outside a virtualenv', area: 'quality', weight: 1, from: 'strict', markers: PYTHON, settings: { allowGlobal: [true, false, false] } },
  { name: 'cloud-cost-warn', title: 'expensive cloud resources', area: 'cloud', weight: 1, from: 'strict', settings: { largeSize: ['16xlarge', '8xlarge', '2xlarge'] } },
  { name: 'backup-before-migrate', title: 'migrations without a backup', area: 'data', weight: 1, markers: DATABASE, settings: { requireBackup: [false, false, true] } },
  { name: 'rate-limit-guard', title: 'API hammering', area: 'network', weight: 1, settings: { maxCalls: [40, 20, 10] } },
  { name: 'license-checker', title: 'incompatible licenses', area: 'supply-chain', weight: 1, markers: PACKAGES, settings: { checkDev: [false, false, true] } },
  { name: 'no-skip-tests', title: 'skipped tests', area: 'quality', weight: 1, settings: { allowWord: ['SKIP-OK', 'SKIP-OK', ''] } },
  { name: 'edit-limit', title: 'runaway multi-file edits', area: 'quality', weight: 1, settings: { max: [30, 15, 8] } },
  { name: 'loop-breaker', title: 'retry loops', area: 'quality', weight: 1, settings: { limit: [5, 3, 2] } },
  { name: 'offline-mode', title: 'network off switch', area: 'network', weight: 1, settings: {} },
]

export const GUARD_NAMES: ReadonlySet<string> = new Set(GUARDS.map(guard => guard.name))
export const guardSpec = (name: string): GuardSpec | undefined => GUARDS.find(guard => guard.name === name)

const levelIndex = (level: Level): 0 | 1 | 2 => (level === 'permissive' ? 0 : level === 'standard' ? 1 : 2)

export const isPolicyLevel = (value: unknown): value is PolicyLevel => typeof value === 'string' && (POLICY_LEVELS as readonly string[]).includes(value)
export const isLevel = (value: unknown): value is Level => typeof value === 'string' && (LEVELS as readonly string[]).includes(value)

/** Whether a level recommends installing a guard. */
export const isRecommendedAt = (guard: GuardSpec, level: Level): boolean =>
  guard.from !== undefined && levelIndex(level) >= levelIndex(guard.from)

export type GuardPolicy = { options: Record<string, OptionValue>; isRecommended: boolean }

/** Per-guard overrides a project's `.claude/guardian.json` may hold for the `custom` level. */
export type Overrides = Readonly<Record<string, Readonly<Record<string, unknown>>>>

export type Policy = {
  level: PolicyLevel
  /** The level the values come from (custom builds on one). */
  base: Level
  /** The fallback option as chosen. */
  fallback: boolean
  /** Whether guardian's fallback guard runs (strict base and the option on). */
  isFallbackOn: boolean
  guards: Record<string, GuardPolicy>
}

/**
 * The policy of a level. `custom` takes `base` (standard by default) and then each override whose guard and key
 * exist and whose value has the key's type; anything else in the overrides is ignored.
 */
export function policyFor(level: PolicyLevel, options: { base?: Level; overrides?: Overrides; fallback?: boolean } = {}): Policy {
  const base: Level = level === 'custom' ? (options.base ?? 'standard') : level
  const index = levelIndex(base)
  const guards: Record<string, GuardPolicy> = {}
  for (const guard of GUARDS) {
    const values: Record<string, OptionValue> = {}
    for (const [key, column] of Object.entries(guard.settings)) values[key] = column[index]
    const custom = level === 'custom' && Object.hasOwn(options.overrides ?? {}, guard.name) ? options.overrides?.[guard.name] : undefined
    for (const [key, value] of Object.entries(custom ?? {})) {
      const column = guard.settings[key]
      if (column !== undefined && typeof value === typeof column[0]) values[key] = value as OptionValue
    }
    guards[guard.name] = { options: values, isRecommended: isRecommendedAt(guard, base) }
  }
  return { level, base, fallback: options.fallback !== false, isFallbackOn: base === 'strict' && options.fallback !== false, guards }
}

/** The guard's own default for a key (the standard column). */
const defaultOf = (guard: GuardSpec, key: string): OptionValue | undefined => guard.settings[key]?.[1]

// ── settings.json pluginConfigs ─────────────────────────────────────────────────────────────────────

export type Json = Readonly<Record<string, unknown>>

export type Change = {
  /** The `pluginConfigs` key it is written under. */
  key: string
  guard: string
  option: string
  /** What settings.json holds now; undefined when the option is not set (the guard's default applies). */
  before: OptionValue | undefined
  after: OptionValue
}

export const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

const isOptionValue = (value: unknown): value is OptionValue =>
  typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))

/** Where a guard's options live: its `name@marketplace` key, else a bare `name` key that already exists. */
export const configKey = (configs: Json, name: string, marketplace: string): string => {
  const qualified = `${name}@${marketplace}`
  return Object.hasOwn(configs, qualified) || !Object.hasOwn(configs, name) ? qualified : name
}

/** The options settings.json holds for a guard (empty when none). */
export function currentOptions(settings: Json, name: string, marketplace: string): Json {
  const configs = isObject(settings.pluginConfigs) ? settings.pluginConfigs : {}
  const entry = configs[configKey(configs, name, marketplace)]
  return isObject(entry) && isObject(entry.options) ? entry.options : {}
}

/**
 * What applying `policy` would change for the installed guards: every option whose stored value differs from the
 * policy's. An unset option whose policy value is the guard's own default needs no write.
 */
export function planApply(settings: Json, policy: Policy, installed: ReadonlySet<string>, marketplace: string): Change[] {
  const configs = isObject(settings.pluginConfigs) ? settings.pluginConfigs : {}
  const changes: Change[] = []
  for (const guard of GUARDS) {
    if (!installed.has(guard.name)) continue
    const key = configKey(configs, guard.name, marketplace)
    const stored = currentOptions(settings, guard.name, marketplace)
    for (const [option, after] of Object.entries(policy.guards[guard.name]?.options ?? {})) {
      const raw = stored[option]
      const before = isOptionValue(raw) ? raw : undefined
      if (before === after || (before === undefined && after === defaultOf(guard, option))) continue
      changes.push({ key, guard: guard.name, option, before, after })
    }
  }
  return changes
}

/** `settings` with the changes written in; every other key, and their order, kept as they were. */
export function applyChanges(settings: Json, changes: readonly Change[]): Record<string, unknown> {
  const configs: Record<string, unknown> = isObject(settings.pluginConfigs) ? { ...settings.pluginConfigs } : {}
  for (const { key, option, after } of changes) {
    const entry: Record<string, unknown> = isObject(configs[key]) ? { ...configs[key] } : {}
    entry.options = { ...(isObject(entry.options) ? entry.options : {}), [option]: after }
    configs[key] = entry
  }
  return { ...settings, pluginConfigs: configs }
}

const show = (value: OptionValue | undefined, max: number): string => {
  if (value === undefined) return '(default)'
  const text = JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** One line per change, each value cut to `max` characters: `force-push-guard.protectedBranches: "main" → "main,master"`. */
export const describeChange = (change: Change, max = 44): string => `${change.guard}.${change.option}: ${show(change.before, max)} → ${show(change.after, max)}`

/** Whether the installed guard's stored options already match the policy. */
export const isConfigured = (settings: Json, policy: Policy, name: string, marketplace: string): boolean =>
  planApply(settings, policy, new Set([name]), marketplace).length === 0

/** `YYYYMMDD-HHMMSS` (UTC) for a backup's name. */
export const stamp = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-')

// ── The policy files ────────────────────────────────────────────────────────────────────────────────

/** What `.claude/guardian.json` (per project) and `~/.claude/claude-mods/guardian/policy.json` (the chosen one) hold. */
export type PolicyFile = {
  version: 1
  level: PolicyLevel
  base: Level
  fallback: boolean
  /** The project the policy was chosen in (policy.json only). */
  project?: string
  updatedAt: string
  /** Per guard, its userConfig values under this policy; for `custom`, the values to keep. */
  guards: Record<string, Record<string, OptionValue>>
}

export function policyFile(policy: Policy, updatedAt: string, project?: string): PolicyFile {
  const guards: Record<string, Record<string, OptionValue>> = {}
  for (const [name, guard] of Object.entries(policy.guards)) if (Object.keys(guard.options).length > 0) guards[name] = guard.options
  return { version: 1, level: policy.level, base: policy.base, fallback: policy.fallback, ...(project === undefined ? {} : { project }), updatedAt, guards }
}

/** Reads a project's `.claude/guardian.json`: its level, base and (custom) overrides; undefined when it is not one. */
export function readPolicyFile(text: string): { level: PolicyLevel; base?: Level; fallback?: boolean; overrides: Overrides } | undefined {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isObject(data) || !isPolicyLevel(data.level)) return undefined
  const overrides: Record<string, Record<string, unknown>> = {}
  if (isObject(data.guards)) {
    for (const [name, options] of Object.entries(data.guards)) if (GUARD_NAMES.has(name) && isObject(options)) overrides[name] = { ...options }
  }
  return {
    level: data.level,
    ...(isLevel(data.base) ? { base: data.base } : {}),
    ...(typeof data.fallback === 'boolean' ? { fallback: data.fallback } : {}),
    overrides,
  }
}
