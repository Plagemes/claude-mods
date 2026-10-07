/**
 * The project's side, pure: which files are dependency manifests, what each
 * one depends on, which folders a scan skips, and what a shell command may
 * have changed (installed something, created files, switched branches).
 */
import { normalizeDep } from './score'

/** Folders a scan records but never walks into: dependencies, build output, caches, VCS internals. */
export const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'vendor', 'dist', 'build', 'out', 'target', '.next', '.nuxt', '.svelte-kit', '.turbo',
  '.venv', 'venv', 'env', '__pycache__', '.mypy_cache', '.pytest_cache', '.tox', '.cache', 'coverage', '.terraform', '.idea',
  'Pods', 'bin', 'obj', '.gradle', '.dart_tool', 'tmp', 'temp', 'logs',
])

const MANIFEST = /^(?:package\.json|pyproject\.toml|requirements[\w.-]*\.txt|Pipfile|go\.mod|Cargo\.toml|composer\.json|Gemfile)$/

/** Whether a project path lies inside a folder scans skip (`node_modules/x/package.json`). */
export const isSkipped = (rel: string): boolean => rel.split('/').slice(0, -1).some(part => SKIP_DIRS.has(part))

export const baseName = (path: string): string => path.slice(path.replace(/\\/g, '/').lastIndexOf('/') + 1)

/** Whether a project path is a dependency manifest the advisor reads. */
export const isManifest = (path: string): boolean => MANIFEST.test(baseName(path))

/** `path` relative to `root` with forward slashes, or undefined when it lies outside. */
export function relativeTo(root: string, path: string): string | undefined {
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const full = path.replace(/\\/g, '/')
  if (!full.startsWith('/') && !/^[A-Za-z]:\//.test(full)) {
    const rel = full.replace(/^\.\//, '').replace(/\/+$/, '')
    return rel === '' || rel.startsWith('../') || rel === '..' ? undefined : rel
  }
  if (full === base) {
    return undefined
  }

  return full.startsWith(`${base}/`) ? full.slice(base.length + 1).replace(/\/+$/, '') : undefined
}

export const joinPath = (root: string, rel: string): string => (rel === '' ? root : `${root.replace(/[\\/]+$/, '')}/${rel}`)

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const keysOf = (record: Record<string, unknown> | undefined, ...fields: string[]): string[] =>
  fields.flatMap(field => Object.keys(asRecord(record?.[field]) ?? {}))

const NAME_AT_START = /^\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)/

/** The keys of the TOML sections `isWanted` picks (`[dependencies]`, `[tool.poetry.dependencies]`). */
function tomlKeys(text: string, isWanted: (section: string) => boolean): string[] {
  const names: string[] = []
  let section = ''
  for (const line of text.split('\n')) {
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*$/.exec(line)
    if (header !== null) {
      section = (header[1] ?? '').trim()
      continue
    }
    const key = /^\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*=/.exec(line)
    if (key !== null && isWanted(section)) {
      names.push(key[1] ?? '')
    }
  }

  return names
}

/** PEP 621 / PEP 735 dependency arrays: the quoted requirements inside `dependencies = [...]` and their kin. */
function pyprojectArrays(text: string): string[] {
  const names: string[] = []
  let section = ''
  let isInArray = false
  for (const line of text.split('\n')) {
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*$/.exec(line)
    if (header !== null) {
      section = (header[1] ?? '').trim()
      isInArray = false
      continue
    }
    const opens = /^\s*([A-Za-z0-9_-]+)\s*=\s*\[/.exec(line)
    const isDependencyArray = opens !== null &&
      ((section === 'project' && opens[1] === 'dependencies') || section === 'project.optional-dependencies' || section === 'dependency-groups')
    if (isDependencyArray) {
      isInArray = true
    }
    if (isInArray) {
      const body = isDependencyArray ? line.slice(line.indexOf('[') + 1) : line
      for (const match of body.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)[^"']*["']/g)) {
        names.push(match[1] ?? '')
      }
      if (body.includes(']')) {
        isInArray = false
      }
    }
  }

  return names
}

/** What a manifest depends on, by its file name; [] for a file it cannot read. Names come back normalized. */
export function depsOf(fileName: string, text: string): string[] {
  let names: string[] = []
  try {
    if (fileName === 'package.json') {
      names = keysOf(asRecord(JSON.parse(text)), 'dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies')
    } else if (fileName === 'composer.json') {
      names = keysOf(asRecord(JSON.parse(text)), 'require', 'require-dev').filter(name => name !== 'php' && !name.startsWith('ext-'))
    } else if (/^requirements[\w.-]*\.txt$/.test(fileName)) {
      names = text.split('\n')
        .map(line => line.replace(/#.*$/, '').trim())
        .filter(line => line !== '' && !line.startsWith('-'))
        .map(line => NAME_AT_START.exec(line)?.[1] ?? '')
    } else if (fileName === 'pyproject.toml') {
      names = [...pyprojectArrays(text), ...tomlKeys(text, section => /^tool\.poetry(?:\.group\.[^.]+)?\.(?:dev-)?dependencies$/.test(section))]
        .filter(name => name.toLowerCase() !== 'python')
    } else if (fileName === 'Pipfile') {
      names = tomlKeys(text, section => section === 'packages' || section === 'dev-packages')
    } else if (fileName === 'Cargo.toml') {
      names = tomlKeys(text, section => /(?:^|\.)(?:dev-|build-)?dependencies$/.test(section))
    } else if (fileName === 'go.mod') {
      const modules = [...text.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}\/[^\s]+)\s+v[\d.]/gim)].map(match => match[1] ?? '')
      // A module is known by its path and by its last segment (`github.com/gin-gonic/gin` and `gin`), a `/v2` suffix aside.
      names = modules.flatMap(path => [path, path.replace(/\/v\d+$/, '').split('/').pop() ?? ''])
    } else if (fileName === 'Gemfile') {
      names = [...text.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)].map(match => match[1] ?? '')
    }
  } catch {
    return []
  }

  return [...new Set(names.filter(name => name !== '').map(normalizeDep))]
}

// ── Shell commands ───────────────────────────────────────────────────────────

/** What a shell command may have changed in the project. */
export type CommandChange = {
  /** Dependencies may have changed: re-read the manifests. */
  installs: boolean
  /** Much may have changed (a checkout, a scaffolder): rescan the project. */
  isFull: boolean
  /** Paths it created or moved into place, as written (relative to where it ran, or absolute). */
  paths: string[]
}

const INSTALLS: readonly RegExp[] = [
  /^(?:npm|pnpm|yarn|bun)(?:\s+(?:add|install|i|remove|uninstall|rm|up|upgrade|update)\b|\s*$)/,
  /^(?:pip3?|uv)\s+(?:install|uninstall|add|remove|sync)\b/,
  /^uv\s+pip\s+(?:install|uninstall)\b/,
  /^python3?\s+-m\s+pip\s+(?:install|uninstall)\b/,
  /^(?:poetry|pipenv|pdm|rye)\s+(?:add|install|remove|sync)\b/,
  /^go\s+(?:get|install|mod\s+tidy)\b/,
  /^cargo\s+(?:add|remove|install)\b/,
  /^composer\s+(?:require|install|remove|update)\b/,
  /^(?:bundle\s+(?:add|install)|gem\s+install)\b/,
]

const RESCANS: readonly RegExp[] = [
  /^git\s+(?:clone|checkout|switch|pull|merge|rebase|reset|restore|stash|worktree|cherry-pick)\b/,
  /^(?:npx|pnpx|bunx)\s+(?:-\S+\s+)*\S*create/,
  /^(?:npm|pnpm|yarn|bun)\s+(?:create|init|dlx)\b/,
  /^(?:npm|pnpm)\s+exec\s+\S*create/,
  /^django-admin\s+(?:startproject|startapp)\b/,
  /^python3?\s+manage\.py\s+startapp\b/,
  /^cargo\s+(?:new|init)\b/,
  /^rails\s+new\b/,
  /^composer\s+create-project\b/,
  /^go\s+mod\s+init\b/,
  /^(?:poetry\s+(?:new|init)|uv\s+init)\b/,
  /^(?:terraform|tofu)\s+init\b/,
  /^(?:ng|nest)\s+new\b/,
  /^(?:vue|cookiecutter|degit|tar|unzip)\b/,
]

/** Splits a shell line into its simple commands (`&&`, `||`, `;`, `|`, newlines). */
const segmentsOf = (command: string): string[] =>
  command.split(/&&|\|\||[;|\n]/).map(part => part.trim()).filter(part => part !== '')

/** A command's words: quotes dropped, leading `VAR=value` and `sudo` skipped. */
function wordsOf(segment: string): string[] {
  const words = (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(word => word.replace(/^["']|["']$/g, ''))
  while (words.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '') || words[0] === 'sudo')) {
    words.shift()
  }

  return words
}

const operands = (words: readonly string[]): string[] => words.slice(1).filter(word => !word.startsWith('-'))

/** Reads what a Bash command may have changed; the advisor rescans only that. */
export function changesOf(command: string): CommandChange {
  const change: CommandChange = { installs: false, isFull: false, paths: [] }
  for (const segment of segmentsOf(command)) {
    const words = wordsOf(segment)
    const line = words.join(' ')
    const program = words[0] ?? ''
    change.installs ||= INSTALLS.some(pattern => pattern.test(line))
    change.isFull ||= RESCANS.some(pattern => pattern.test(line))
    if (program === 'touch' || program === 'mkdir') {
      change.paths.push(...operands(words))
    } else if (program === 'cp' || program === 'mv' || program === 'ln') {
      const last = operands(words).pop()
      if (last !== undefined) change.paths.push(last)
    } else if (program === 'tee') {
      change.paths.push(...operands(words))
    }
    for (const match of segment.matchAll(/(?:^|[^>&\d])>>?\s*(["']?)([^\s"'&|;<>]+)\1/g)) {
      const target = match[2] ?? ''
      if (target !== '' && !target.startsWith('/dev/') && !target.startsWith('&')) change.paths.push(target)
    }
    const output = /\s(?:-o|-O|--output)\s+(\S+)/.exec(segment)
    if ((program === 'curl' || program === 'wget') && output?.[1] !== undefined) {
      change.paths.push(output[1].replace(/^["']|["']$/g, ''))
    }
  }
  change.paths = [...new Set(change.paths.filter(path => path !== '' && path !== '.' && !path.includes('*')))]

  return change
}
