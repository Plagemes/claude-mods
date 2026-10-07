// Pure map building: paths in, markdown out. No `$` here, so tests can call it directly.

export type MapSource = 'git' | 'walk'

export type MapOptions = {
  name: string
  depth: number
  maxChars: number
  now: number
  source: MapSource
}

export type BuiltMap = {
  markdown: string
  files: number
  dirs: number
  depth: number
  isTruncated: boolean
}

type KeyKind = 'entry' | 'config' | 'docs' | 'ci'

type DirNode = {
  name: string
  dirs: Map<string, DirNode>
  files: string[]
  count: number
}

const ROOT_FILES_SHOWN = 25
const FILES_SHOWN_PER_DIR = 12
const DIRS_SHOWN_PER_LEVEL = 30
const KEY_FILES_LISTED = 30
const LANGUAGES_SHOWN = 5
const META_PREFIX = '<!-- codebase-map'

const CONFIG_NAMES = new Set([
  'package.json', 'tsconfig.json', 'jsconfig.json', 'deno.json', 'deno.jsonc', 'bunfig.toml',
  'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'pipfile', 'tox.ini',
  'cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle',
  'settings.gradle.kts', 'gemfile', 'composer.json', 'mix.exs', 'cmakelists.txt', 'makefile',
  'dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml',
  '.env.example', 'turbo.json', 'nx.json', 'pnpm-workspace.yaml', 'lerna.json', 'procfile',
  'vercel.json', 'netlify.toml', 'fly.toml', 'serverless.yml', 'justfile', 'flake.nix',
])
const CONFIG_PATTERN =
  /^(vite|vitest|webpack|rollup|next|nuxt|svelte|astro|tailwind|postcss|jest|playwright|babel|eslint|prettier|tsup|esbuild|metro|remix)\.config\.[cm]?[jt]s$|^\.eslintrc|^\.prettierrc/
const ENTRY_PATTERN =
  /^(index|main|app|server|cli)\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|c|cc|cpp)$|^(__main__|manage|wsgi|asgi)\.py$|^lib\.rs$|^program\.cs$/
const VENDORED = /(^|\/)(node_modules|vendor|third_party|dist|build)\//
const DOC_NAMES = new Set(['readme.md', 'claude.md', 'agents.md', 'contributing.md', 'architecture.md'])

const LANGUAGES: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', go: 'Go', rs: 'Rust', rb: 'Ruby', java: 'Java', kt: 'Kotlin', swift: 'Swift',
  c: 'C', h: 'C', cc: 'C++', cpp: 'C++', hpp: 'C++', cs: 'C#', php: 'PHP', ex: 'Elixir',
  exs: 'Elixir', scala: 'Scala', dart: 'Dart', vue: 'Vue', svelte: 'Svelte', md: 'Markdown',
  mdx: 'Markdown', json: 'JSON', yml: 'YAML', yaml: 'YAML', toml: 'TOML', css: 'CSS',
  scss: 'CSS', html: 'HTML', sql: 'SQL', sh: 'Shell', lua: 'Lua', zig: 'Zig',
}

const KIND_LABEL: Record<KeyKind, string> = {
  entry: 'entry point',
  config: 'config',
  docs: 'docs',
  ci: 'CI',
}

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

export const keyKindOf = (path: string): KeyKind | undefined => {
  const name = baseName(path).toLowerCase()
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) || name === '.gitlab-ci.yml') return 'ci'
  if (CONFIG_NAMES.has(name) || CONFIG_PATTERN.test(name)) return 'config'
  if (ENTRY_PATTERN.test(name)) return 'entry'
  if (DOC_NAMES.has(name)) return 'docs'
  return undefined
}

export const normalizePaths = (paths: readonly string[]): string[] =>
  [...new Set(paths.map(p => p.trim().replace(/^\.\//, '').replace(/\\/g, '/')).filter(Boolean))].sort()

const newDir = (name: string): DirNode => ({ name, dirs: new Map(), files: [], count: 0 })

const buildTree = (paths: readonly string[]): { root: DirNode; dirs: number } => {
  const root = newDir('')
  let dirs = 0
  for (const path of paths) {
    const parts = path.split('/')
    const file = parts.pop() ?? path
    let node = root
    node.count += 1
    for (const part of parts) {
      let child = node.dirs.get(part)
      if (child === undefined) {
        child = newDir(part)
        node.dirs.set(part, child)
        dirs += 1
      }
      child.count += 1
      node = child
    }
    node.files.push(file)
  }
  return { root, dirs }
}

const languageSummary = (paths: readonly string[]): string => {
  const counts = new Map<string, number>()
  for (const path of paths) {
    const name = baseName(path)
    const dot = name.lastIndexOf('.')
    if (dot <= 0) continue
    const language = LANGUAGES[name.slice(dot + 1).toLowerCase()]
    if (language !== undefined) counts.set(language, (counts.get(language) ?? 0) + 1)
  }
  const total = paths.length
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, LANGUAGES_SHOWN)
    .map(([language, n]) => `${language} ${Math.round((n / total) * 100)}%`)
    .join(', ')
}

const fileLine = (dir: string, file: string): string => {
  const kind = keyKindOf(dir === '' ? file : `${dir}/${file}`)
  return kind === undefined ? file : `${file}  · ${KIND_LABEL[kind]}`
}

const soleChild = (node: DirNode): DirNode | undefined =>
  node.files.length === 0 && node.dirs.size === 1 ? [...node.dirs.values()][0] : undefined

/** `showAll` lists every file (a few per dir); otherwise below the root only key files are named. */
const renderTree = (root: DirNode, name: string, depth: number, showAll: boolean): string[] => {
  const lines = [`${name}/ (${root.count} files)`]
  const walk = (node: DirNode, path: string, prefix: string, level: number): void => {
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))
    const shownDirs = dirs.slice(0, DIRS_SHOWN_PER_LEVEL)
    const isRoot = level === 1
    const listsAll = isRoot || showAll
    const named = listsAll ? node.files : node.files.filter(f => keyKindOf(`${path}/${f}`) !== undefined)
    const files = named.slice(0, isRoot ? ROOT_FILES_SHOWN : listsAll ? FILES_SHOWN_PER_DIR : named.length)
    const rest: string[] = []
    if (dirs.length > shownDirs.length) rest.push(`… ${dirs.length - shownDirs.length} more dirs`)
    if (listsAll && node.files.length > files.length) rest.push(`… ${node.files.length - files.length} more files`)
    const entries: { label: string; dir?: DirNode; name?: string }[] = [
      ...shownDirs.map(dir => {
        // Fold a chain of single-child dirs into one line: `a/b/c/ (12)`.
        let name = dir.name
        let deepest = dir
        for (let only = soleChild(deepest); only !== undefined; only = soleChild(deepest)) {
          name = `${name}/${only.name}`
          deepest = only
        }
        return { label: `${name}/ (${dir.count})`, dir: deepest, name }
      }),
      ...files.map(file => ({ label: fileLine(path, file) })),
      ...rest.map(label => ({ label })),
    ]
    entries.forEach((entry, index) => {
      const isLast = index === entries.length - 1
      lines.push(`${prefix}${isLast ? '└── ' : '├── '}${entry.label}`)
      if (entry.dir !== undefined && entry.name !== undefined && level < depth) {
        const childPath = path === '' ? entry.name : `${path}/${entry.name}`
        walk(entry.dir, childPath, `${prefix}${isLast ? '    ' : '│   '}`, level + 1)
      }
    })
  }
  walk(root, '', '', 1)
  return lines
}

const stamp = (now: number): string => `${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC`

const compose = (
  head: string,
  keyFiles: readonly string[],
  tree: readonly string[],
  isTruncated: boolean,
): string =>
  [
    head,
    '',
    '## Key files',
    keyFiles.length === 0 ? '_None recognised._' : keyFiles.join('\n'),
    '',
    '## Layout',
    '```text',
    ...tree,
    ...(isTruncated ? ['… (cut to fit the size cap)'] : []),
    '```',
    '',
  ].join('\n')

/** Builds the map, lowering the depth (then cutting lines) until it fits `maxChars`. */
export const buildMap = (rawPaths: readonly string[], options: MapOptions): BuiltMap => {
  const paths = normalizePaths(rawPaths)
  const { root, dirs } = buildTree(paths)
  const languages = languageSummary(paths)
  const meta = `${META_PREFIX} files=${paths.length} dirs=${dirs} generated=${options.now} source=${options.source} -->`
  const head = [
    meta,
    `# Codebase map: ${options.name}`,
    '',
    `${paths.length} files in ${dirs} directories${languages === '' ? '' : ` · ${languages}`} · generated ${stamp(options.now)}`,
  ].join('\n')
  const keyFiles = paths
    .map(path => ({ path, kind: keyKindOf(path) }))
    .filter((entry): entry is { path: string; kind: KeyKind } => entry.kind !== undefined && !VENDORED.test(entry.path))
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))
    .slice(0, KEY_FILES_LISTED)
    .map(entry => `- \`${entry.path}\` (${KIND_LABEL[entry.kind]})`)

  // Most detail first: every file, then key files only, then fewer levels.
  const depth = Math.max(1, options.depth)
  const attempts = [
    { depth, showAll: true },
    ...Array.from({ length: depth }, (_, i) => ({ depth: depth - i, showAll: false })),
  ]
  for (const attempt of attempts) {
    const markdown = compose(head, keyFiles, renderTree(root, options.name, attempt.depth, attempt.showAll), false)
    if (markdown.length <= options.maxChars) {
      return { markdown, files: paths.length, dirs, depth: attempt.depth, isTruncated: false }
    }
  }
  // Even one level is too long: keep as many top-level lines as fit.
  const kept: string[] = []
  let size = compose(head, keyFiles, [], true).length
  for (const line of renderTree(root, options.name, 1, false)) {
    if (size + line.length + 1 > options.maxChars) break
    kept.push(line)
    size += line.length + 1
  }
  return { markdown: compose(head, keyFiles, kept, true), files: paths.length, dirs, depth: 1, isTruncated: true }
}

export type MapMeta = { files: number; dirs: number; generatedAt: number; source: MapSource }

/** Reads the stats line a saved map starts with; undefined for a file this mod did not write. */
export const parseMeta = (markdown: string): MapMeta | undefined => {
  const match = /^<!-- codebase-map files=(\d+) dirs=(\d+) generated=(\d+) source=(git|walk) -->/.exec(markdown)
  if (match === null) return undefined
  return {
    files: Number(match[1]),
    dirs: Number(match[2]),
    generatedAt: Number(match[3]),
    source: match[4] === 'git' ? 'git' : 'walk',
  }
}

/** The map without its stats comment: what Claude and the pane read. */
export const bodyOf = (markdown: string): string =>
  markdown.startsWith(META_PREFIX) ? markdown.slice(markdown.indexOf('-->') + 3).trimStart() : markdown
