import type { EngineInterface, PluginOptions, Register } from 'claude-code'

type Kind = 'test' | 'lint' | 'build' | 'typecheck'
type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

type KindSpec = {
  option: string
  noun: string
  fix: string
  scripts: readonly string[]
  makeTargets: readonly string[]
  cargo: string
  go: string
}

const KINDS: Record<Kind, KindSpec> = {
  test: {
    option: 'testCommand',
    noun: 'test suite',
    fix: 'fix any failures',
    scripts: ['test'],
    makeTargets: ['test', 'tests'],
    cargo: 'cargo test',
    go: 'go test ./...',
  },
  lint: {
    option: 'lintCommand',
    noun: 'linter',
    fix: 'fix every issue it reports',
    scripts: ['lint'],
    makeTargets: ['lint'],
    cargo: 'cargo clippy --all-targets',
    go: 'go vet ./...',
  },
  build: {
    option: 'buildCommand',
    noun: 'build',
    fix: 'fix any errors',
    scripts: ['build'],
    makeTargets: ['build'],
    cargo: 'cargo build',
    go: 'go build ./...',
  },
  typecheck: {
    option: 'typecheckCommand',
    noun: 'type checker',
    fix: 'fix every type error',
    scripts: ['typecheck', 'type-check', 'check-types', 'tsc', 'types'],
    makeTargets: ['typecheck', 'type-check', 'types'],
    cargo: 'cargo check',
    go: 'go vet ./...',
  },
}

const LOCKFILES: readonly (readonly [string, PackageManager])[] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
]
const EXEC: Record<PackageManager, string> = { npm: 'npx', pnpm: 'pnpm exec', yarn: 'yarn', bun: 'bunx' }
/** What `npm init` writes as the test script; it is a placeholder, not a test suite. */
const PLACEHOLDER_SCRIPT = /no test specified/

const exists = async ($: EngineInterface, cwd: string, name: string): Promise<boolean> => {
  try {
    return await $.fs.exists(`${cwd}/${name}`)
  } catch {
    return false
  }
}

const readText = async ($: EngineInterface, cwd: string, name: string): Promise<string | undefined> => {
  try {
    const text = await $.fs.read(`${cwd}/${name}`)
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

const packageManager = async ($: EngineInterface, cwd: string): Promise<PackageManager> => {
  for (const [file, manager] of LOCKFILES) {
    if (await exists($, cwd, file)) {
      return manager
    }
  }
  return 'npm'
}

const scriptsOf = (packageJson: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(packageJson)
    const scripts =
      typeof parsed === 'object' && parsed !== null && 'scripts' in parsed ? parsed.scripts : undefined
    return typeof scripts === 'object' && scripts !== null ? { ...scripts } : {}
  } catch {
    return {}
  }
}

const fromPackageJson = async ($: EngineInterface, cwd: string, kind: Kind): Promise<string | undefined> => {
  const packageJson = await readText($, cwd, 'package.json')
  if (packageJson === undefined) {
    return undefined
  }

  const manager = await packageManager($, cwd)
  const scripts = scriptsOf(packageJson)
  const script = KINDS[kind].scripts.find(name => {
    const body = scripts[name]
    return typeof body === 'string' && !PLACEHOLDER_SCRIPT.test(body)
  })

  if (script !== undefined) {
    return `${manager} run ${script}`
  }

  return kind === 'typecheck' && (await exists($, cwd, 'tsconfig.json')) ? `${EXEC[manager]} tsc --noEmit` : undefined
}

const fromMakefile = async ($: EngineInterface, cwd: string, kind: Kind): Promise<string | undefined> => {
  const makefile = await readText($, cwd, 'Makefile')
  const target = KINDS[kind].makeTargets.find(name => makefile !== undefined && new RegExp(`^${name}\\s*:`, 'm').test(makefile))

  return target === undefined ? undefined : `make ${target}`
}

const fromPython = async ($: EngineInterface, cwd: string, kind: Kind): Promise<string | undefined> => {
  const pyproject = await readText($, cwd, 'pyproject.toml')
  const has = (section: string): boolean => pyproject?.includes(section) === true

  switch (kind) {
    case 'test':
      return pyproject !== undefined || (await exists($, cwd, 'pytest.ini')) ? 'pytest' : undefined
    case 'lint':
      return has('[tool.ruff') ? 'ruff check .' : undefined
    case 'build':
      return has('[build-system]') ? 'python -m build' : undefined
    case 'typecheck':
      if (has('[tool.pyright') || (await exists($, cwd, 'pyrightconfig.json'))) {
        return 'pyright'
      }
      return has('[tool.mypy') || (await exists($, cwd, 'mypy.ini')) ? 'mypy .' : undefined
  }
}

const detect = async ($: EngineInterface, cwd: string, kind: Kind): Promise<string | undefined> => {
  const fromJs = await fromPackageJson($, cwd, kind)
  if (fromJs !== undefined) {
    return fromJs
  }

  const fromMake = await fromMakefile($, cwd, kind)
  if (fromMake !== undefined) {
    return fromMake
  }

  if (await exists($, cwd, 'Cargo.toml')) {
    return KINDS[kind].cargo
  }

  const fromPy = await fromPython($, cwd, kind)
  if (fromPy !== undefined) {
    return fromPy
  }

  return (await exists($, cwd, 'go.mod')) ? KINDS[kind].go : undefined
}

const commandFor = async (
  $: EngineInterface,
  options: PluginOptions,
  kind: Kind,
): Promise<string | undefined> => {
  const configured = options[KINDS[kind].option]

  if (typeof configured === 'string' && configured.trim() !== '') {
    return configured.trim()
  }

  return detect($, await $.session.cwd(), kind)
}

const promptFor = (kind: Kind, command: string, focus: string): string => {
  const { noun, fix } = KINDS[kind]
  const scope = focus === '' ? '' : ` Limit it to: ${focus}.`

  return `Run the ${noun} with \`${command}\` and ${fix}.${scope}`
}

const run = async (
  $: EngineInterface,
  options: PluginOptions,
  kind: Kind,
  focus: string,
): Promise<{ text: string }> => {
  const command = await commandFor($, options, kind)

  if (command === undefined) {
    return {
      text: `quick-commands: no ${KINDS[kind].noun} command found. Set "${KINDS[kind].option}" in this mod's settings, or add a script or Makefile target.`,
    }
  }

  // Queued from a timer, after this command's own dispatch has ended: the prompt then starts a turn of its own.
  $.clock.after(1, () => {
    $.prompt.submit({ text: promptFor(kind, command, focus), asUser: true }).catch(() => undefined)
  })

  return { text: `Running the ${KINDS[kind].noun}: ${command}` }
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 't',
      description: 'Run the test suite and fix failures',
      argumentHint: '[what to test]',
    })
    await $.command.register({
      name: 'l',
      description: 'Run the linter and fix what it reports',
      argumentHint: '[what to lint]',
    })
    await $.command.register({
      name: 'b',
      description: 'Run the build and fix errors',
      argumentHint: '[what to build]',
    })
    await $.command.register({
      name: 'tc',
      description: 'Run the type checker and fix type errors',
      argumentHint: '[what to check]',
    })

    return next(e)
  })

  on('command.run', { command: 't' }, ($, e) => run($, options, 'test', e.args.trim()))
  on('command.run', { command: 'l' }, ($, e) => run($, options, 'lint', e.args.trim()))
  on('command.run', { command: 'b' }, ($, e) => run($, options, 'build', e.args.trim()))
  on('command.run', { command: 'tc' }, ($, e) => run($, options, 'typecheck', e.args.trim()))
}
