import { normalizeLicense } from './licenses'
import { parseToml } from './toml'
import type { TomlTable, TomlValue } from './toml'
import { parseYaml } from './yaml'
import type { YamlMap, YamlValue } from './yaml'

export type Ecosystem = 'npm' | 'pypi' | 'cargo' | 'golang'

/** One third-party package a lockfile pins. `isDev` is undefined where the lockfile does not say. */
export type Dependency = {
  ecosystem: Ecosystem
  name: string
  /** The pinned version; '' for an unpinned requirement. */
  version: string
  isDev?: boolean
  license?: string
}

/** The direct dependencies a manifest (package.json) declares, for lockfiles that do not mark dev ones. */
export type Roots = { prod: Record<string, string>; dev: Record<string, string> }

export type LockfileKind =
  | 'package-lock.json'
  | 'npm-shrinkwrap.json'
  | 'pnpm-lock.yaml'
  | 'yarn.lock'
  | 'poetry.lock'
  | 'uv.lock'
  | 'requirements.txt'
  | 'Cargo.lock'
  | 'go.mod'
  | 'go.sum'

/** The lockfile kind a file name is, if any (`requirements-dev.txt` is a requirements file). */
export const lockfileKind = (name: string): LockfileKind | undefined => {
  if (/^requirements(?:[-_.][\w.-]+)?\.txt$/i.test(name)) return 'requirements.txt'
  const kinds: readonly LockfileKind[] = [
    'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'poetry.lock', 'uv.lock', 'Cargo.lock', 'go.mod', 'go.sum',
  ]
  return kinds.find(kind => kind === name)
}

export const ECOSYSTEM_OF: Record<LockfileKind, Ecosystem> = {
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  'pnpm-lock.yaml': 'npm',
  'yarn.lock': 'npm',
  'poetry.lock': 'pypi',
  'uv.lock': 'pypi',
  'requirements.txt': 'pypi',
  'Cargo.lock': 'cargo',
  'go.mod': 'golang',
  'go.sum': 'golang',
}

// ── Small helpers ───────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/** `@scope/name@1.2.3` → name and the rest; the version separator is the last `@` past the first character. */
export const splitAt = (spec: string): { name: string; rest: string } => {
  const at = spec.indexOf('@', 1)
  return at === -1 ? { name: spec, rest: '' } : { name: spec.slice(0, at), rest: spec.slice(at + 1) }
}

/** PEP 503 normalization: `Jinja2` → `jinja2`, `typing_extensions` → `typing-extensions`. */
export const normalizePythonName = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, '-')

/** Marks dev-only packages by walking the dependency graph from the manifest's prod and dev roots. */
const scopeByGraph = (
  ids: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
  prodRoots: readonly string[],
  devRoots: readonly string[],
): Map<string, boolean> => {
  const walk = (roots: readonly string[]): Set<string> => {
    const seen = new Set<string>()
    const queue = [...roots]
    while (queue.length > 0) {
      const id = queue.pop() as string
      if (seen.has(id)) continue
      seen.add(id)
      queue.push(...(edges.get(id) ?? []))
    }
    return seen
  }
  const prod = walk(prodRoots)
  const dev = walk(devRoots)
  return new Map(ids.map(id => [id, dev.has(id) && !prod.has(id)]))
}

// ── npm ─────────────────────────────────────────────────────────────────────

/** package-lock.json / npm-shrinkwrap.json, lockfile versions 1, 2 and 3. */
export const parsePackageLock = (text: string): Dependency[] => {
  const lock: unknown = JSON.parse(text)
  if (!isRecord(lock)) throw new SyntaxError('package-lock.json is not a JSON object')
  const found: Dependency[] = []

  if (isRecord(lock.packages)) {
    for (const [path, entry] of Object.entries(lock.packages)) {
      const cut = path.lastIndexOf('node_modules/')
      if (cut === -1 || !isRecord(entry) || entry.link === true) continue
      const version = str(entry.version)
      if (version === undefined) continue
      found.push({
        ecosystem: 'npm',
        name: str(entry.name) ?? path.slice(cut + 'node_modules/'.length),
        version,
        isDev: entry.dev === true,
        license: normalizeLicense(str(entry.license)),
      })
    }
    return found
  }

  const visit = (dependencies: unknown): void => {
    if (!isRecord(dependencies)) return
    for (const [name, entry] of Object.entries(dependencies)) {
      if (!isRecord(entry)) continue
      const version = str(entry.version)
      if (version !== undefined && !version.startsWith('file:')) {
        found.push({ ecosystem: 'npm', name, version: version.replace(/^npm:.*@/, ''), isDev: entry.dev === true })
      }
      visit(entry.dependencies)
    }
  }
  visit(lock.dependencies)
  return found
}

const PEER_SUFFIX = /\(.*$/

/** A pnpm package key (`/name@1.0.0(peer@2)`, `name@1.0.0`, or v5's `/name/1.0.0_peer@2`) as name and version. */
export const pnpmKey = (key: string, isSlashFormat: boolean): { name: string; version: string } | undefined => {
  const bare = key.replace(/^\//, '').replace(PEER_SUFFIX, '')
  if (isSlashFormat) {
    const cut = bare.lastIndexOf('/')
    if (cut <= 0) return undefined
    return { name: bare.slice(0, cut), version: bare.slice(cut + 1).replace(/_.*$/, '') }
  }
  const { name, rest } = splitAt(bare)
  return rest === '' ? undefined : { name, version: rest }
}

/** pnpm-lock.yaml, lockfile versions 5.x, 6.x and 9.x. */
export const parsePnpmLock = (text: string): Dependency[] => {
  const lock = parseYaml(text)
  const version = parseFloat(String(lock.lockfileVersion ?? '0').replace(/'/g, ''))
  const isSlashFormat = version > 0 && version < 6
  const packages = isRecord(lock.packages) ? (lock.packages as YamlMap) : {}
  const found = new Map<string, Dependency>()

  for (const [key, value] of Object.entries(packages)) {
    const entry = isRecord(value) ? (value as YamlMap) : {}
    const parsed = pnpmKey(key, isSlashFormat)
    const name = str(entry.name) ?? parsed?.name
    const pinned = str(entry.version) ?? parsed?.version
    if (name === undefined || pinned === undefined) continue
    const dev = entry.dev === 'true' ? true : entry.dev === 'false' ? false : undefined
    found.set(key.replace(/^\//, '').replace(PEER_SUFFIX, ''), { ecosystem: 'npm', name, version: pinned, isDev: dev })
  }

  // Version 9 drops `dev`: walk the snapshots from the importers' dependencies and devDependencies.
  const snapshots = isRecord(lock.snapshots) ? (lock.snapshots as YamlMap) : undefined
  const importers = isRecord(lock.importers) ? (lock.importers as YamlMap) : undefined
  if (snapshots !== undefined && importers !== undefined) {
    const edges = new Map<string, string[]>()
    const childrenOf = (deps: YamlValue | undefined): string[] =>
      isRecord(deps)
        ? Object.entries(deps as YamlMap).flatMap(([name, spec]) => {
            const resolved = isRecord(spec) ? str((spec as YamlMap).version) : str(spec)
            return resolved === undefined || resolved.startsWith('link:') ? [] : [`${name}@${resolved.replace(PEER_SUFFIX, '')}`]
          })
        : []
    for (const [key, value] of Object.entries(snapshots)) {
      const entry = isRecord(value) ? (value as YamlMap) : {}
      const id = key.replace(PEER_SUFFIX, '')
      edges.set(id, [...(edges.get(id) ?? []), ...childrenOf(entry.dependencies), ...childrenOf(entry.optionalDependencies)])
    }
    const prod: string[] = []
    const dev: string[] = []
    for (const importer of Object.values(importers)) {
      if (!isRecord(importer)) continue
      const project = importer as YamlMap
      prod.push(...childrenOf(project.dependencies), ...childrenOf(project.optionalDependencies))
      dev.push(...childrenOf(project.devDependencies))
    }
    const isDev = scopeByGraph([...found.keys()], edges, prod, dev)
    for (const [id, dependency] of found) dependency.isDev = isDev.get(id) ?? false
  }
  return [...found.values()]
}

type YarnEntry = { descriptors: string[]; name: string; version: string; dependencies: string[]; isWorkspace: boolean }

/** The package a yarn descriptor names: `name@^1`, `name@npm:^1`, or an alias `alias@npm:real@^1`. */
const yarnNameOf = (descriptor: string): string => {
  const { name, rest } = splitAt(descriptor)
  const alias = /^npm:(@?[^@]+)@/.exec(rest)
  return alias?.[1] ?? name
}

/** yarn.lock, classic (v1) and Berry (v2+), with dev scope from the manifest's roots when given. */
export const parseYarnLock = (text: string, roots?: Roots): Dependency[] => {
  const isBerry = /^__metadata:/m.test(text)
  const entries: YarnEntry[] = []
  let entry: YarnEntry | undefined
  let inDependencies = false

  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || line.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const content = line.trim()
    if (indent === 0) {
      inDependencies = false
      const header = content.replace(/:$/, '')
      if (header === '__metadata') {
        entry = undefined
        continue
      }
      const descriptors = header.split(/,\s*/).map(part => part.replace(/^"|"$/g, ''))
      entry = { descriptors, name: yarnNameOf(descriptors[0] ?? ''), version: '', dependencies: [], isWorkspace: false }
      entries.push(entry)
      continue
    }
    if (entry === undefined) continue
    if (indent === 2) {
      inDependencies = content === 'dependencies:' || content === 'optionalDependencies:'
      const field = isBerry ? /^(\w+):\s*"?([^"]*)"?$/.exec(content) : /^(\w+)\s+"?([^"]*)"?$/.exec(content)
      if (field?.[1] === 'version') entry.version = field[2] ?? ''
      if (field?.[1] === 'resolution') {
        const resolution = field[2] ?? ''
        entry.isWorkspace = /@(?:workspace|link|portal|file):/.test(resolution)
        entry.name = resolution.slice(0, resolution.indexOf('@', 1)) || entry.name
      }
      continue
    }
    if (inDependencies && indent >= 4) {
      const dep = isBerry ? /^"?([^":]+)"?:\s*"?([^"]*)"?$/.exec(content) : /^"?([^"\s]+)"?\s+"?([^"]*)"?$/.exec(content)
      if (dep !== null) entry.dependencies.push(`${dep[1]}@${dep[2]}`)
    }
  }

  const packages = entries.filter(one => !one.isWorkspace && one.version !== '' && !one.version.startsWith('0.0.0-use.local'))
  const found = packages.map((one): Dependency => ({ ecosystem: 'npm', name: one.name, version: one.version }))
  if (roots === undefined) return found

  const byDescriptor = new Map<string, number>()
  packages.forEach((one, index) => one.descriptors.forEach(descriptor => byDescriptor.set(descriptor, index)))
  const descriptorOf = (name: string, range: string): string =>
    isBerry && !/^[a-z]+:/.test(range) ? `${name}@npm:${range}` : `${name}@${range}`
  const ids = packages.map((_, index) => String(index))
  const resolve = (descriptor: string): string[] => {
    const index = byDescriptor.get(descriptor)
    return index === undefined ? [] : [String(index)]
  }
  const edges = new Map(packages.map((one, index) => [String(index), one.dependencies.flatMap(resolve)]))
  const rootIds = (deps: Record<string, string>) => Object.entries(deps).flatMap(([name, range]) => resolve(descriptorOf(name, range)))
  const isDev = scopeByGraph(ids, edges, rootIds(roots.prod), rootIds(roots.dev))
  return found.map((dependency, index) => ({ ...dependency, isDev: isDev.get(String(index)) ?? false }))
}

/** The prod and dev roots of a package.json. */
export const rootsOfManifest = (text: string): Roots | undefined => {
  let manifest: unknown
  try {
    manifest = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(manifest)) return undefined
  const deps = (field: string): Record<string, string> =>
    isRecord(manifest[field])
      ? Object.fromEntries(Object.entries(manifest[field]).filter((pair): pair is [string, string] => typeof pair[1] === 'string'))
      : {}
  return { prod: { ...deps('dependencies'), ...deps('optionalDependencies') }, dev: deps('devDependencies') }
}

// ── Python ──────────────────────────────────────────────────────────────────

const tomlPackages = (lock: TomlTable): TomlTable[] =>
  Array.isArray(lock.package) ? lock.package.filter((entry): entry is TomlTable => isRecord(entry)) : []

/** poetry.lock: `groups` (Poetry 2) or `category` (Poetry 1) say whether a package is dev-only. */
export const parsePoetryLock = (text: string): Dependency[] =>
  tomlPackages(parseToml(text)).flatMap((entry): Dependency[] => {
    const name = str(entry.name)
    const version = str(entry.version)
    const source = isRecord(entry.source) ? str((entry.source as TomlTable).type) : undefined
    if (name === undefined || version === undefined || source === 'directory') return []
    const groups = Array.isArray(entry.groups) ? entry.groups.map(String) : undefined
    const category = str(entry.category)
    const isDev = groups !== undefined ? !groups.includes('main') : category !== undefined ? category === 'dev' : undefined
    return [{ ecosystem: 'pypi', name: normalizePythonName(name), version, isDev }]
  })

const LOCAL_SOURCES = ['virtual', 'editable', 'directory', 'path']

/** uv.lock: workspace members are left out, and dev scope comes from walking their dependencies and dev-dependencies. */
export const parseUvLock = (text: string): Dependency[] => {
  const packages = tomlPackages(parseToml(text))
  const isLocal = (entry: TomlTable): boolean =>
    isRecord(entry.source) && LOCAL_SOURCES.some(kind => kind in (entry.source as TomlTable))
  const namesIn = (list: TomlValue | undefined): string[] =>
    Array.isArray(list) ? list.flatMap(item => (isRecord(item) && typeof item.name === 'string' ? [normalizePythonName(item.name)] : [])) : []
  const groupsIn = (table: TomlValue | undefined): string[] =>
    isRecord(table) ? Object.values(table as TomlTable).flatMap(namesIn) : []

  const edges = new Map<string, string[]>()
  const prod: string[] = []
  const dev: string[] = []
  for (const entry of packages) {
    const name = normalizePythonName(str(entry.name) ?? '')
    edges.set(name, [...namesIn(entry.dependencies), ...groupsIn(entry['optional-dependencies'])])
    if (isLocal(entry)) {
      prod.push(...namesIn(entry.dependencies), ...groupsIn(entry['optional-dependencies']))
      dev.push(...groupsIn(entry['dev-dependencies']))
    }
  }
  const hasRoots = prod.length + dev.length > 0
  const isDev = scopeByGraph([...edges.keys()], edges, prod, dev)
  return packages.flatMap((entry): Dependency[] => {
    const name = str(entry.name)
    const version = str(entry.version)
    if (name === undefined || version === undefined || isLocal(entry)) return []
    const normalized = normalizePythonName(name)
    return [{ ecosystem: 'pypi', name: normalized, version, isDev: hasRoots ? (isDev.get(normalized) ?? false) : undefined }]
  })
}

/**
 * requirements*.txt: `name==1.2.3` pins (extras, markers, hashes and
 * continuation lines allowed); a looser requirement is listed unpinned.
 * Options (`-r`, `-e`, `--index-url`) and direct URLs are skipped.
 */
export const parseRequirements = (text: string, isDev = false): Dependency[] => {
  const found: Dependency[] = []
  const joined = text.replace(/\\\r?\n/g, ' ')
  for (const raw of joined.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim()
    if (line === '' || line.startsWith('-')) continue
    const requirement = line.split(';')[0]?.replace(/\s--hash=\S+/g, '').trim() ?? ''
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/.exec(requirement)
    if (match === null) continue
    const [, name = '', spec = ''] = match
    if (spec.startsWith('@')) continue
    const pinned = /^===?\s*([^\s,]+)$/.exec(spec.trim())
    found.push({ ecosystem: 'pypi', name: normalizePythonName(name), version: pinned?.[1] ?? '', isDev })
  }
  return found
}

// ── Rust ────────────────────────────────────────────────────────────────────

/** Cargo.lock: packages from a registry or git; workspace members and path crates (no `source`) are left out. */
export const parseCargoLock = (text: string): Dependency[] =>
  tomlPackages(parseToml(text)).flatMap((entry): Dependency[] => {
    const name = str(entry.name)
    const version = str(entry.version)
    if (name === undefined || version === undefined || str(entry.source) === undefined) return []
    return [{ ecosystem: 'cargo', name, version }]
  })

// ── Go ──────────────────────────────────────────────────────────────────────

/** Compares Go module versions (`v1.2.3`, `v0.0.0-2020...-abc`, `+incompatible`) by their numbers. */
export const compareGoVersions = (a: string, b: string): number => {
  const parts = (version: string): number[] =>
    version
      .replace(/^v/, '')
      .split(/[.+-]/)
      .map(part => (/^\d+$/.test(part) ? Number(part) : 0))
  const left = parts(a)
  const right = parts(b)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** go.mod `require` lines (block or single); `// indirect` ones included. */
export const parseGoMod = (text: string): Dependency[] => {
  const found: Dependency[] = []
  let inBlock = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim()
    if (inBlock) {
      if (line === ')') inBlock = false
      else addGoRequirement(found, line)
    } else if (/^require\s*\($/.test(line)) {
      inBlock = true
    } else if (line.startsWith('require ')) {
      addGoRequirement(found, line.slice('require '.length))
    }
  }
  return found
}

const addGoRequirement = (found: Dependency[], line: string): void => {
  const [path, version] = line.split(/\s+/)
  if (path !== undefined && path !== '' && version !== undefined) found.push({ ecosystem: 'golang', name: path, version })
}

/** go.sum: one module per path at its highest version (what minimal version selection keeps); go.mod-only lines skipped. */
export const parseGoSum = (text: string): Dependency[] => {
  const best = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const [path, version] = line.trim().split(/\s+/)
    if (path === undefined || version === undefined || version.endsWith('/go.mod')) continue
    const known = best.get(path)
    if (known === undefined || compareGoVersions(version, known) > 0) best.set(path, version)
  }
  return [...best].map(([name, version]) => ({ ecosystem: 'golang' as const, name, version }))
}

// ── Any ─────────────────────────────────────────────────────────────────────

/** Parses one lockfile by its kind; `manifest` is the package.json beside a yarn.lock, for dev scope. */
export const parseLockfile = (kind: LockfileKind, text: string, options: { fileName?: string; manifest?: string } = {}): Dependency[] => {
  switch (kind) {
    case 'package-lock.json':
    case 'npm-shrinkwrap.json':
      return parsePackageLock(text)
    case 'pnpm-lock.yaml':
      return parsePnpmLock(text)
    case 'yarn.lock':
      return parseYarnLock(text, options.manifest === undefined ? undefined : rootsOfManifest(options.manifest))
    case 'poetry.lock':
      return parsePoetryLock(text)
    case 'uv.lock':
      return parseUvLock(text)
    case 'requirements.txt':
      return parseRequirements(text, /dev|test|lint|doc/i.test(options.fileName ?? ''))
    case 'Cargo.lock':
      return parseCargoLock(text)
    case 'go.mod':
      return parseGoMod(text)
    case 'go.sum':
      return parseGoSum(text)
  }
}
