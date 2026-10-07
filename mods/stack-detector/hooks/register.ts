import type { EngineInterface, Register } from 'claude-code'

import { GUIDES, TECH_IDS } from './guides'
import type { TechId } from './guides'

const COMMAND = 'stack'
const SECTION_ID = 'stack-detector:conventions'

/** Lockfiles that name the Node package manager, most specific first. */
const LOCKFILES: readonly (readonly [string, string])[] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
]

/** package.json dependencies that reveal a technology. */
const NODE_DEPENDENCIES: readonly (readonly [string, TechId])[] = [
  ['next', 'next'],
  ['react', 'react'],
  ['vue', 'vue'],
  ['nuxt', 'vue'],
  ['svelte', 'svelte'],
  ['@sveltejs/kit', 'svelte'],
  ['@nestjs/core', 'nest'],
  ['express', 'express'],
  ['typescript', 'typescript'],
]

const PYTHON_FILES = ['pyproject.toml', 'requirements.txt', 'requirements-dev.txt', 'Pipfile', 'setup.py', 'setup.cfg']
const PYTHON_FRAMEWORKS: readonly TechId[] = ['django', 'fastapi', 'flask']
const JVM_FILES = ['pom.xml', 'build.gradle', 'build.gradle.kts']
const DOCKER_FILES = ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']

type Finding = { id: TechId; evidence: string }

type Detection = {
  root: string
  findings: Finding[]
  packageManager?: { name: string; evidence: string }
  testScript?: string
}

const settings = { inject: true, skip: new Set<string>() }
let detection: Detection | undefined

const joinPath = (root: string, file: string): string => `${root.replace(/[\\/]+$/, '')}/${file}`

/** Whether a dependency list's text names `name` as a whole word (`flask`, not `flask-cors`). */
const mentions = (text: string, name: string): boolean => new RegExp(`(^|[^\\w-])${name}([^\\w-]|$)`, 'im').test(text)

const parseJson = (text: string | undefined): Record<string, unknown> | undefined => {
  if (text === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const dependenciesOf = (pkg: Record<string, unknown>, ...fields: string[]): Record<string, unknown> =>
  Object.assign({}, ...fields.map(field => (typeof pkg[field] === 'object' ? pkg[field] : {})))

const activeFindings = (found: Detection): Finding[] => found.findings.filter(finding => !settings.skip.has(finding.id))

const rulesFor = (finding: Finding, found: Detection): readonly string[] => {
  if (finding.id !== 'node' || found.packageManager === undefined) return GUIDES[finding.id].rules
  const { name, evidence } = found.packageManager
  return [
    `Use ${name} for installs and scripts (${evidence}); never add a second lockfile.`,
    ...(found.testScript === undefined ? [] : [`Run the tests with \`${name} test\` (\`${found.testScript}\`).`]),
  ]
}

const sectionText = (found: Detection): string | undefined => {
  const findings = activeFindings(found)
  if (findings.length === 0) return undefined
  return [
    '# Project stack and conventions',
    `Detected from the project's root files: ${findings.map(finding => GUIDES[finding.id].name).join(', ')}. Follow these conventions unless the codebase clearly does otherwise:`,
    ...findings.map(finding => [``, `## ${GUIDES[finding.id].name}`, ...rulesFor(finding, found).map(rule => `- ${rule}`)].join('\n')),
  ].join('\n')
}

/** Reads the project root: its file names, then the manifests among them. */
async function scan($: EngineInterface): Promise<Detection> {
  const root = await $.session.root()
  const entries = await $.fs.list(root)
  const files = new Set(entries.filter(entry => entry.kind !== 'dir').map(entry => entry.name))
  const readIf = async (file: string): Promise<string | undefined> =>
    files.has(file) ? $.fs.read(joinPath(root, file)).catch(() => undefined) : undefined
  const found = new Map<TechId, string>()
  const note = (id: TechId, evidence: string) => {
    if (!found.has(id)) found.set(id, evidence)
  }

  let packageManager: Detection['packageManager']
  let testScript: string | undefined
  const pkg = parseJson(await readIf('package.json'))
  if (pkg !== undefined) {
    const deps = dependenciesOf(pkg, 'dependencies', 'devDependencies', 'peerDependencies')
    for (const [dep, id] of NODE_DEPENDENCIES) {
      if (dep in deps) note(id, `package.json: ${dep} ${String(deps[dep])}`)
    }
    note('node', 'package.json')
    const lock = LOCKFILES.find(([file]) => files.has(file))
    const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : undefined
    if (lock !== undefined) packageManager = { name: lock[1], evidence: lock[0] }
    else if (declared !== undefined && declared !== '') packageManager = { name: declared, evidence: 'package.json packageManager' }
    const test = (pkg.scripts as Record<string, unknown> | undefined)?.test
    if (typeof test === 'string' && !/no test specified/.test(test)) testScript = test
  }
  if (files.has('tsconfig.json')) note('typescript', 'tsconfig.json')

  const pythonFiles = PYTHON_FILES.filter(file => files.has(file))
  if (pythonFiles.length > 0) {
    const texts = await Promise.all(pythonFiles.map(async file => [file, (await readIf(file)) ?? ''] as const))
    for (const framework of PYTHON_FRAMEWORKS) {
      const source = texts.find(([, text]) => mentions(text, framework))
      if (source !== undefined) note(framework, `${source[0]}: ${framework}`)
    }
    note('python', pythonFiles.join(', '))
  }

  if (files.has('go.mod')) note('go', 'go.mod')
  if (files.has('Cargo.toml')) note('rust', 'Cargo.toml')
  const gemfile = await readIf('Gemfile')
  if (gemfile !== undefined && /^\s*gem\s+['"]rails['"]/m.test(gemfile)) note('rails', 'Gemfile: rails')
  const composer = parseJson(await readIf('composer.json'))
  if (composer !== undefined && 'laravel/framework' in dependenciesOf(composer, 'require')) {
    note('laravel', 'composer.json: laravel/framework')
  }
  for (const file of JVM_FILES.filter(name => files.has(name))) {
    if (/spring-boot/.test((await readIf(file)) ?? '')) note('spring', `${file}: spring-boot`)
  }
  const dockerFile = DOCKER_FILES.find(file => files.has(file))
  if (dockerFile !== undefined) note('docker', dockerFile)
  const terraform = [...files].filter(file => file.endsWith('.tf'))
  if (terraform.length > 0) note('terraform', terraform.length === 1 ? (terraform[0] ?? '') : `${terraform.length} .tf files`)

  const findings = TECH_IDS.filter(id => found.has(id)).map(id => ({ id, evidence: found.get(id) ?? '' }))
  return { root, findings, packageManager, testScript }
}

async function rescan($: EngineInterface): Promise<Detection | undefined> {
  try {
    detection = await scan($)
  } catch (error) {
    $.ui.log(`stack-detector: could not scan the project root: ${String(error)}`, { to: 'debug' })
  }
  return detection
}

export const register: Register = (on, options) => {
  settings.inject = options.inject !== false
  settings.skip = new Set(
    (typeof options.skip === 'string' ? options.skip : '')
      .split(',')
      .map(id => id.trim().toLowerCase())
      .filter(id => id !== ''),
  )

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: "Show the project's detected stack and the conventions Claude is given for it",
      argumentHint: '[rescan]',
    })
    await rescan($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    try {
      if (detection === undefined || detection.root !== (await $.session.root())) await rescan($)
    } catch (error) {
      $.ui.log(`stack-detector: ${String(error)}`, { to: 'debug' })
    }
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!settings.inject || e.traits.includes('bare')) return composed
    const found = detection ?? (await rescan($))
    const text = found === undefined ? undefined : sectionText(found)
    if (text === undefined) return composed
    return {
      sections: [
        ...composed.sections.filter(section => section.id !== SECTION_ID),
        { id: SECTION_ID, text, scope: 'session' },
      ],
    }
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const found = e.args.trim().toLowerCase() === 'rescan' || detection === undefined ? await rescan($) : detection
    if (found === undefined) return { text: 'stack-detector: the project root could not be read.' }
    if (found.findings.length === 0) {
      return { text: `stack-detector: nothing recognised in ${found.root}. Nothing is added to the system prompt.` }
    }
    const width = Math.max(...found.findings.map(finding => `${GUIDES[finding.id].name} (${finding.id})`.length))
    const rows = found.findings.map(finding => {
      const label = `${GUIDES[finding.id].name} (${finding.id})`.padEnd(width)
      const mark = settings.skip.has(finding.id) ? '–' : '✓'
      const manager = finding.id === 'node' && found.packageManager !== undefined ? `, ${found.packageManager.evidence}` : ''
      return `  ${mark} ${label}  ${finding.evidence}${manager}`
    })
    const text = sectionText(found)
    const footer = !settings.inject
      ? 'Conventions are not injected (inject is off).'
      : text === undefined
        ? 'Every detected technology is skipped; nothing is injected.'
        : `Conventions for the ✓ rows are in the system prompt (${text.length.toLocaleString('en-US')} characters). /stack rescan scans again.`
    return {
      text: [`stack-detector: ${found.findings.length} detected in ${found.root}`, ...rows, '', footer].join('\n'),
    }
  })
}
