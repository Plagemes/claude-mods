// Pure parts of the tour: the project sketch sent to the model, the request, and reading the steps back. No `$` here.

import type { TourStep } from '../types'

export const MIN_STEPS = 4
export const MAX_STEPS = 9
const MAX_FILES_PER_STEP = 6
const TITLE_CHARS = 80
const BODY_CHARS = 2_400

/** Manifests and notes that say how a project is built, run and tested, in the order they are read. */
export const PROJECT_FILES = [
  'README.md',
  'README.rst',
  'README.txt',
  'README',
  'CLAUDE.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'package.json',
  'pyproject.toml',
  'setup.py',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'Gemfile',
  'composer.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'deno.json',
  'Makefile',
  'justfile',
  'docker-compose.yml',
  'tsconfig.json',
]

/** Folders whose first level is listed too: where the code usually lives. */
export const SOURCE_DIRS = ['src', 'app', 'lib', 'packages', 'apps', 'cmd', 'internal', 'pkg', 'server', 'client', 'api', 'services', 'tests', 'test']

export const IGNORED = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'target', '.next', '.venv', 'venv', '__pycache__', 'coverage', '.cache', 'vendor', '.idea', '.vscode'])

export type Entry = { name: string; isDir: boolean }

/** The excerpt of a project file the model reads: package.json reduced to what matters, the rest cut. */
export function excerptOf(name: string, text: string): string {
  if (name === 'package.json') {
    try {
      const json = JSON.parse(text) as Record<string, unknown>
      const keep = ['name', 'description', 'type', 'main', 'module', 'bin', 'exports', 'workspaces', 'scripts', 'engines']
      const picked = Object.fromEntries(keep.filter(key => key in json).map(key => [key, json[key]]))
      const deps = Object.keys((json.dependencies as Record<string, unknown> | undefined) ?? {})
      const devDeps = Object.keys((json.devDependencies as Record<string, unknown> | undefined) ?? {})
      return JSON.stringify({ ...picked, dependencies: deps.slice(0, 40), devDependencies: devDeps.slice(0, 40) }, null, 2)
    } catch {
      // Not valid JSON: shown as text below.
    }
  }
  const limit = /^readme/i.test(name) ? 6_000 : 2_500
  return text.length > limit ? `${text.slice(0, limit)}\n[…cut]` : text
}

/** The tree the model sees: the top level, and the first level of the usual source folders. */
export function treeOf(top: readonly Entry[], nested: ReadonlyMap<string, readonly Entry[]>): string {
  const line = (entry: Entry) => `${entry.name}${entry.isDir ? '/' : ''}`
  const lines: string[] = []
  for (const entry of [...top].sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))) {
    lines.push(line(entry))
    const inner = nested.get(entry.name)
    if (inner !== undefined) {
      const shown = [...inner].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 40)
      lines.push(...shown.map(child => `  ${line(child)}`))
      if (inner.length > shown.length) lines.push(`  … ${inner.length - shown.length} more`)
    }
  }
  return lines.join('\n')
}

export const SYSTEM =
  'You are a senior engineer giving a newcomer a guided tour of a repository. You are accurate: you describe only what the material shows, and when you infer, you say so. You never invent files, commands or features.'

export function tourPrompt(projectName: string, tree: string, files: readonly { name: string; text: string }[]): string {
  return [
    `Plan a guided tour of the repository "${projectName}" for a developer who has never seen it, from the material below.`,
    '',
    `Write ${MIN_STEPS} to ${MAX_STEPS - 1} steps, in the order a newcomer should take them, covering where they apply:`,
    '1. What the project is and who uses it.',
    '2. How to install, run and build it (exact commands from the scripts or docs).',
    '3. The entry points: where execution starts.',
    '4. The main modules or folders and what each is responsible for.',
    '5. How data or a request flows through the main path.',
    '6. How the tests are organised and run.',
    '7. Conventions, and a good first place to make a change.',
    '',
    'Each step: a short "title"; a "body" in Markdown of 60 to 180 words (concrete names, commands in backticks, no headings);',
    'and "files": up to 6 paths, relative to the repository root, that the step is about and that appear in the material.',
    '',
    'Reply with JSON only, no prose and no code fence:',
    '{"steps": [{"title": "…", "body": "…", "files": ["path"]}]}',
    '',
    'Repository tree (top level, and the first level of source folders):',
    tree,
    '',
    ...files.flatMap(file => [`=== ${file.name}`, file.text, '']),
  ].join('\n')
}

const isSafePath = (path: string): boolean => path !== '' && !path.startsWith('/') && !path.split('/').includes('..')

/** The steps of the model's reply that are usable; empty when there are none. */
export function parseSteps(reply: string): TourStep[] {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return []
  }
  const raw = (parsed as { steps?: unknown }).steps
  if (!Array.isArray(raw)) return []
  const steps: TourStep[] = []
  for (const entry of raw) {
    const item = (entry ?? {}) as { title?: unknown; body?: unknown; files?: unknown }
    const title = typeof item.title === 'string' ? item.title.trim().slice(0, TITLE_CHARS) : ''
    const body = typeof item.body === 'string' ? item.body.trim().slice(0, BODY_CHARS) : ''
    if (title === '' || body === '') continue
    const files = (Array.isArray(item.files) ? item.files : [])
      .filter((path): path is string => typeof path === 'string')
      .map(path => path.trim().replace(/^\.\//, '').replace(/\/+$/, ''))
      .filter(isSafePath)
    steps.push({ title, body, files: [...new Set(files)].slice(0, MAX_FILES_PER_STEP) })
    if (steps.length === MAX_STEPS) break
  }
  return steps
}
