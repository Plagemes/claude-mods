/** The package manager whose filter syntax scopes a script. */
export type Manager = 'pnpm' | 'npm' | 'yarn' | 'bun'

/** One package of the workspace: its name, its folder relative to the root, its scripts, and its Nx project name. */
export type Package = { name: string; dir: string; scripts: string[]; project: string }

/** A command rewritten to one package: the new command and the script or task it runs. */
export type Scoped = { command: string; task: string }

const ENV_PREFIX = /^((?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+)*)/
const UNSAFE = /[;&|<>`$()\n]|\bcd\b/
/** Flags that already pick packages (or all of them): the command is left as written. */
const PICKS = /(?:^|\s)(?:--filter(?:=|\s)|-F\s|-F\S|--workspace(?:=|\s)|-w\s|-ws\b|--workspaces\b|-r\b|--recursive\b|--projects?(?:=|\s)|-p\s|--all\b|--affected\b|workspace\s|workspaces\s)/

/** The globs `pnpm-workspace.yaml` lists under `packages:` (exclusions left out). */
export const pnpmGlobs = (yaml: string): string[] => {
  const globs: string[] = []
  let isInPackages = false
  for (const line of yaml.split('\n')) {
    if (/^packages\s*:/.test(line)) {
      isInPackages = true
      continue
    }
    if (isInPackages && /^\S/.test(line)) break
    const item = isInPackages ? /^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/.exec(line) : null
    if (item !== null && !(item[1] ?? '').startsWith('!')) globs.push(item[1] ?? '')
  }
  return globs
}

/** The globs a package.json `workspaces` field lists: an array, or `{ packages: [...] }`. */
export const packageJsonGlobs = (manifest: Record<string, unknown>): string[] => {
  const field = manifest.workspaces
  const list = Array.isArray(field) ? field : typeof field === 'object' && field !== null && Array.isArray((field as { packages?: unknown }).packages) ? (field as { packages: unknown[] }).packages : []
  return list.filter((glob): glob is string => typeof glob === 'string' && !glob.startsWith('!'))
}

/** The package that holds `path` (relative to the root): the one with the longest folder that contains it. */
export const packageOf = (packages: readonly Package[], path: string): Package | undefined =>
  packages
    .filter(pkg => path === pkg.dir || path.startsWith(`${pkg.dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length)[0]

/** The package `/scope-pkg <arg>` names: by name, by name without its scope, or by folder. */
export const findPackage = (packages: readonly Package[], arg: string): Package | undefined => {
  const wanted = arg.trim().replace(/^\.\//, '').replace(/\/$/, '')
  return (
    packages.find(pkg => pkg.name === wanted || pkg.dir === wanted || pkg.project === wanted) ??
    packages.find(pkg => pkg.name.split('/').pop() === wanted || pkg.dir.split('/').pop() === wanted)
  )
}

const selector = (pkg: Package): string => (pkg.name !== '' ? pkg.name : `./${pkg.dir}`)

/**
 * `pnpm test` run at the workspace root, rewritten to the package:
 * `pnpm --filter <pkg> test`, `npm run test -w <pkg>`, `yarn workspace <pkg> test`,
 * `bun run --filter <pkg> test`, `turbo run test --filter=<pkg>`, `nx test <project>`.
 * Undefined when the command is not a root-level run of a scoped script,
 * already picks packages, is compound, or the package has no such script.
 */
export const scopeCommand = (command: string, pkg: Package, manager: Manager, scoped: ReadonlySet<string>): Scoped | undefined => {
  const trimmed = command.trim()
  if (UNSAFE.test(trimmed.replace(ENV_PREFIX, '')) || PICKS.test(trimmed)) return undefined
  const env = ENV_PREFIX.exec(trimmed)?.[1] ?? ''
  const rest = trimmed.slice(env.length)
  const hasScript = (script: string) => scoped.has(script) && pkg.scripts.includes(script)

  // Task words are split by required whitespace, so a failing match cannot backtrack through every split of a word.
  const turbo = /^((?:npx|pnpm(?:\s+exec)?|yarn|bunx)\s+)?turbo\s+(?:run\s+)?([\w:-]+(?:\s+[\w:-]+)*?)(\s+-.*)?$/.exec(rest)
  if (turbo !== null) {
    const tasks = (turbo[2] ?? '').trim().split(/\s+/)
    if (!tasks.some(task => scoped.has(task))) return undefined
    return { command: `${env}${rest} --filter=${selector(pkg)}`, task: tasks.join(' ') }
  }

  const nx = /^((?:npx|pnpm(?:\s+exec)?|yarn|bunx)\s+)?nx\s+(.*)$/.exec(rest)
  if (nx !== null) {
    const prefix = `${nx[1] ?? ''}nx`
    const args = nx[2] ?? ''
    const many = /^run-many\s+(?:-t|--targets?)(?:=|\s+)([\w:,-]+)(.*)$/.exec(args)
    if (many !== null) {
      const tasks = (many[1] ?? '').split(',')
      return tasks.some(task => scoped.has(task)) ? { command: `${env}${prefix} run-many -t ${many[1]} -p ${pkg.project}${many[2] ?? ''}`, task: tasks.join(',') } : undefined
    }
    const single = /^([\w:-]+)(\s+-.*)?$/.exec(args)
    if (single === null || !scoped.has(single[1] ?? '')) return undefined
    return { command: `${env}${prefix} ${single[1]} ${pkg.project}${single[2] ?? ''}`, task: single[1] ?? '' }
  }

  const script = /^(pnpm|npm|yarn|bun)\s+(?:(run|run-script)\s+)?([\w:-]+)(\s.*)?$/.exec(rest)
  if (script === null) return undefined
  const [, tool = '', run, name = '', tail = ''] = script
  const task = tool === 'npm' && (name === 't' || name === 'tst') ? 'test' : name
  if (!hasScript(task) || (tool === 'bun' && run === undefined) || (tool !== manager && !(tool === 'npm' && manager === 'npm'))) return undefined
  switch (tool) {
    case 'pnpm':
      return { command: `${env}pnpm --filter ${selector(pkg)} ${run === undefined ? '' : 'run '}${task}${tail}`, task }
    case 'npm':
      return { command: `${env}npm ${run === undefined && task === 'test' ? 'test' : `run ${task}`} -w ${selector(pkg)}${tail}`, task }
    case 'yarn':
      return pkg.name === '' ? undefined : { command: `${env}yarn workspace ${pkg.name} ${task}${tail}`, task }
    default:
      return { command: `${env}bun run --filter ${selector(pkg)} ${task}${tail}`, task }
  }
}

/** The command that runs a script in every package, for the note that tells Claude how to run them all. */
export const everywhere = (manager: Manager, task: string): string => {
  switch (manager) {
    case 'pnpm':
      return `pnpm -r ${task}`
    case 'npm':
      return `npm run ${task} --workspaces`
    case 'yarn':
      return `yarn workspaces foreach -A run ${task}`
    default:
      return `bun run --filter '*' ${task}`
  }
}
