import { TRACKERS, trackerOfPackage } from './trackers'
import type { Tracker } from './trackers'

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const PREFIXES = new Set(['sudo', 'command', 'exec', 'time', 'nohup'])
/** A cheap test before parsing: does the command mention an installer at all? */
export const INSTALLER_HINT = /\b(?:npm|pnpm|yarn|bun|pip3?|python3?|uv|poetry)\b/

/** Splits a command line into simple commands, each a list of words; quotes are honoured, expansions kept as text. */
const simpleCommands = (command: string): string[][] => {
  const commands: string[][] = []
  let words: string[] = []
  let word = ''
  let isOpen = false
  const endWord = (): void => {
    if (isOpen) words.push(word)
    word = ''
    isOpen = false
  }
  const endCommand = (): void => {
    endWord()
    if (words.length > 0) commands.push(words)
    words = []
  }
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i] as string
    if (char === '\\' && i + 1 < command.length) {
      word += command[i + 1]
      isOpen = true
      i += 1
    } else if (char === "'" || char === '"') {
      const end = command.indexOf(char, i + 1)
      const stop = end === -1 ? command.length : end
      word += command.slice(i + 1, stop)
      isOpen = true
      i = stop
    } else if (char === ' ' || char === '\t') {
      endWord()
    } else if (char === ';' || char === '|' || char === '&' || char === '\n' || char === '(' || char === ')') {
      endCommand()
    } else {
      word += char
      isOpen = true
    }
  }
  endCommand()
  return commands
}

/** Operands of an install command: options dropped, and the values of the options in `valued` with them. */
const operandsOf = (args: readonly string[], valued: ReadonlySet<string>): string[] => {
  const operands: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string
    if (arg === '--') {
      operands.push(...args.slice(i + 1))
      break
    }
    if (arg.startsWith('-')) {
      if (valued.has(arg)) i += 1
    } else {
      operands.push(arg)
    }
  }
  return operands
}

const NPM_INSTALL = new Set(['install', 'i', 'add'])
const NPM_VALUED = new Set(['--registry', '--tag', '--prefix', '-w', '--workspace', '--filter', '-F', '-C', '--dir', '--cwd'])
const PIP_VALUED = new Set([
  '-r', '--requirement', '-c', '--constraint', '-e', '--editable', '-i', '--index-url', '--extra-index-url', '-f', '--find-links',
  '-t', '--target', '--prefix', '--root', '--python', '-p', '--group', '--extra', '--optional', '--source',
])

/** `@scope/name@1.2` and `name@latest` as the package name; undefined for paths, URLs and git specs. */
const npmName = (spec: string): string | undefined => {
  const target = /^[^@/]+@npm:(.+)$/.exec(spec)?.[1] ?? spec
  if (/^[./~]|:|\.t(?:ar\.)?gz$/.test(target) || (!target.startsWith('@') && target.includes('/'))) return undefined
  const at = target.indexOf('@', 1)
  return (at === -1 ? target : target.slice(0, at)).toLowerCase()
}

/** `Mixpanel[extra]>=2` as `mixpanel` (PEP 503 normalised); undefined for paths, URLs and archives. */
const pypiName = (spec: string): string | undefined => {
  if (/^[./~]|:\/\/|^git\+|\.(?:whl|zip|tar\.gz)$/.test(spec)) return undefined
  const name = /^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(spec)?.[0]
  return name?.toLowerCase().replace(/[-_.]+/g, '-')
}

const packagesOf = (argv: readonly string[]): string[] => {
  let start = 0
  while (start < argv.length && (PREFIXES.has(argv[start] as string) || ASSIGNMENT.test(argv[start] as string))) start += 1
  const [tool = '', sub = '', third = '', ...rest] = argv.slice(start)
  const name = tool.replace(/^.*\//, '')
  const afterSub = argv.slice(start + 2)
  const names = (specs: readonly string[], nameOf: (spec: string) => string | undefined): string[] =>
    specs.flatMap(spec => nameOf(spec) ?? [])

  if (name === 'npm' || name === 'pnpm' || name === 'bun' || name === 'yarn') {
    const isAdd = name === 'yarn' ? sub === 'add' : NPM_INSTALL.has(sub) || (name === 'bun' && sub === 'a')
    return isAdd ? names(operandsOf(afterSub, NPM_VALUED), npmName) : []
  }
  if (/^pip3?(?:\.\d+)?$/.test(name) && sub === 'install') return names(operandsOf(afterSub, PIP_VALUED), pypiName)
  if (/^python3?(?:\.\d+)?$/.test(name) && sub === '-m' && /^pip3?$/.test(third) && rest[0] === 'install') {
    return names(operandsOf(rest.slice(1), PIP_VALUED), pypiName)
  }
  if (name === 'uv' && sub === 'pip' && third === 'install') return names(operandsOf(rest, PIP_VALUED), pypiName)
  if ((name === 'uv' || name === 'poetry') && sub === 'add') return names(operandsOf(afterSub, PIP_VALUED), pypiName)
  return []
}

const unique = (trackers: readonly Tracker[]): Tracker[] => [...new Set(trackers)]

/** The trackers an install command adds to a project. */
export const trackersInstalledBy = (command: string): Tracker[] => {
  if (!INSTALLER_HINT.test(command)) return []
  return unique(simpleCommands(command).flatMap(packagesOf).flatMap(name => trackerOfPackage(name) ?? []))
}

const MANIFEST = /(?:^|[/\\])(?:package\.json|requirements[\w.-]*\.txt|constraints[\w.-]*\.txt|pyproject\.toml|Pipfile|setup\.py|setup\.cfg)$/i
const CODE =
  /\.(?:html?|xhtml|[cm]?[jt]sx?|vue|svelte|astro|php|erb|ejs|hbs|handlebars|liquid|njk|twig|pug|jade|cshtml|razor|jinja2?|j2|tmpl|py|rb|go|java|kt|cs|swift|dart)$/i

/** Files that can add a tracker: dependency manifests, and code or templates that load one. Docs and data files cannot. */
export const isWatchedFile = (path: string): boolean => MANIFEST.test(path) || CODE.test(path)

const JS_IMPORT = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g
const PY_IMPORT = /^\s*(?:from|import)\s+([A-Za-z_]\w*)/gm
const JSON_KEY = /"((?:@[\w.-]+\/)?[\w.-]+)"\s*:/g
const REQUIREMENT_LINE = /^\s*([A-Za-z0-9][\w.-]*)/gm
const QUOTED_NAME = /["']([A-Za-z0-9][\w.-]*)(?:\[[^\]]*\])?\s*(?:[<>=!~;,\s]|["'])/g
const TOML_KEY = /^\s*([A-Za-z0-9][\w.-]*)\s*=/gm

const rootOf = (specifier: string): string => (specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : (specifier.split('/')[0] ?? ''))
const normalisePypi = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, '-')

const namesIn = (text: string, pattern: RegExp): string[] => [...text.matchAll(pattern)].map(found => found[1] as string)

/** Trackers a piece of a dependency manifest declares. */
const declared = (path: string, text: string): Tracker[] => {
  const base = path.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  const names =
    base === 'package.json'
      ? namesIn(text, JSON_KEY)
      : base.startsWith('requirements') || base.startsWith('constraints')
        ? namesIn(text, REQUIREMENT_LINE).map(normalisePypi)
        : [...namesIn(text, QUOTED_NAME), ...namesIn(text, TOML_KEY)].map(normalisePypi)
  return names.flatMap(name => trackerOfPackage(name) ?? [])
}

/** Trackers a piece of code or markup loads: script URLs and imports of their SDKs. */
const loaded = (text: string): Tracker[] => {
  const byUrl = TRACKERS.filter(tracker => (tracker.urls ?? []).some(url => url.test(text)))
  const byJsImport = namesIn(text, JS_IMPORT).flatMap(specifier => trackerOfPackage(rootOf(specifier)) ?? [])
  const pyModules = namesIn(text, PY_IMPORT)
  const byPyImport = TRACKERS.filter(tracker =>
    pyModules.some(module => (tracker.imports ?? []).includes(module) || (tracker.packages ?? []).includes(normalisePypi(module))),
  )
  return [...byUrl, ...byJsImport, ...byPyImport]
}

/** The trackers `text` of the file at `path` adds a reference to. */
export const trackersIn = (path: string, text: string): Tracker[] =>
  unique(MANIFEST.test(path) ? declared(path, text) : isWatchedFile(path) ? loaded(text) : [])

/** The trackers `after` references that `before` did not: a file that already had one is not a new decision. */
export const trackersAdded = (path: string, before: string, after: string): Tracker[] => {
  const known = new Set(trackersIn(path, before))
  return trackersIn(path, after).filter(tracker => !known.has(tracker))
}

/** A cheap test for text that could involve a tracker, to decide whether a failed check must fail closed. */
export const LOOKS_LIKE_TRACKING =
  /analytics|tracking|tracker|pixel|gtag|gtm|mixpanel|segment|amplitude|hotjar|fullstory|posthog|clarity|tiktok|heap|fbq|ttq|sentry|bugsnag|rollbar|logrocket|plausible|fathom|matomo|hubspot|rudder/i
