/** What the project's top folder holds, as far as choosing a dev command needs. */
export type Project = {
  /** Entry names in the folder, plus the nested paths detection asks about (`bin/dev`, `.venv/bin/python`) that exist. */
  names: ReadonlySet<string>
  /** package.json's text, when there is one. */
  packageJson?: string
  /** Gemfile's text, when there is one. */
  gemfile?: string
}

/** Nested paths whose presence picks a command, besides VENV_PYTHONS. */
export const NESTED_PATHS = ['bin/dev', 'bin/rails']

/** A dev command and where it came from, for the pane's header. */
export type Detected = { command: string; source: string }

const SCRIPTS = ['dev', 'start', 'serve', 'develop'] as const
export const VENV_PYTHONS = ['.venv/bin/python', 'venv/bin/python', 'env/bin/python']

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

const parseJson = (text: string | undefined): Record<string, unknown> | undefined => {
  if (text === undefined) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** The package manager the project uses: package.json's `packageManager`, else its lockfile, else npm. */
export const packageManagerOf = (project: Project, manifest: Record<string, unknown> | undefined): PackageManager => {
  const declared = typeof manifest?.packageManager === 'string' ? manifest.packageManager.split('@')[0] : undefined
  if (declared === 'pnpm' || declared === 'yarn' || declared === 'bun' || declared === 'npm') return declared
  if (project.names.has('pnpm-lock.yaml')) return 'pnpm'
  if (project.names.has('yarn.lock')) return 'yarn'
  if (project.names.has('bun.lockb') || project.names.has('bun.lock')) return 'bun'
  return 'npm'
}

const runScript = (manager: PackageManager, script: string): string => {
  if (manager === 'yarn' || manager === 'pnpm') return `${manager} ${script}`
  return `${manager} run ${script}`
}

/**
 * The command that starts the project's dev server: a package.json script
 * (dev, start, serve, develop) with its package manager, Django's runserver
 * (a virtualenv's python first), Rails, Phoenix or Laravel; undefined when
 * the folder holds none of them.
 */
export const detectCommand = (project: Project): Detected | undefined => {
  const manifest = parseJson(project.packageJson)
  const scripts = manifest?.scripts
  if (typeof scripts === 'object' && scripts !== null) {
    const script = SCRIPTS.find(name => typeof (scripts as Record<string, unknown>)[name] === 'string')
    if (script !== undefined) {
      return { command: runScript(packageManagerOf(project, manifest), script), source: `package.json "${script}" script` }
    }
  }
  if (project.names.has('manage.py')) {
    const python = VENV_PYTHONS.find(path => project.names.has(path)) ?? 'python3'
    return { command: `${python} manage.py runserver`, source: 'Django manage.py' }
  }
  if (project.names.has('bin/dev')) return { command: 'bin/dev', source: 'Rails bin/dev' }
  if (project.names.has('bin/rails')) return { command: 'bin/rails server', source: 'Rails' }
  if (project.gemfile !== undefined && /^\s*gem\s+["']rails["']/m.test(project.gemfile)) {
    return { command: 'bundle exec rails server', source: 'Rails Gemfile' }
  }
  if (project.names.has('mix.exs')) return { command: 'mix phx.server', source: 'Phoenix mix.exs' }
  if (project.names.has('artisan')) return { command: 'php artisan serve', source: 'Laravel artisan' }
  return undefined
}

/** A short form of a command for the status line: `npm run dev` stays, a long one is cut. */
export const shortCommand = (command: string, width = 32): string =>
  command.length <= width ? command : `${command.slice(0, width - 1)}…`
