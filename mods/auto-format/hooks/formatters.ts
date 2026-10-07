import { extension, hasPackage, pyprojectMatches } from './project'
import type { Project } from './project'

export type Formatter = {
  /** The name shown to people and matched by the `disabled` option. */
  name: string
  extensions: ReadonlySet<string>
  /** Whether the project asks for this formatter (canonical ones always do). */
  isWanted: (project: Project) => Promise<boolean>
  /** The executable, looked up under `localFolders` before PATH. */
  bin: string
  localFolders: readonly string[]
  /** Where the formatter's config lives, used as its working directory. */
  configDir: (project: Project) => string | undefined
  args: (file: string, project: Project) => Promise<string[]>
}

const NODE_BIN = ['node_modules/.bin']
const PYTHON_BIN = ['.venv/bin', 'venv/bin']
const SCRIPT_EXTENSIONS = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts']

const BIOME_CONFIGS = ['biome.json', 'biome.jsonc']
const PRETTIER_CONFIGS = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.json5',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  '.prettierrc.toml',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  '.prettierrc.ts',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
  'prettier.config.ts',
]
const RUFF_CONFIGS = ['ruff.toml', '.ruff.toml']
const CLANG_CONFIGS = ['.clang-format', '_clang-format']
const PHP_CS_CONFIGS = ['.php-cs-fixer.php', '.php-cs-fixer.dist.php']

const always = async () => true
const nearest = (names: string[]) => (project: Project) => project.find(...names)
const fileOnly = async (file: string) => [file]

/** Every formatter, in the order they are tried for a file. */
const FORMATTERS: readonly Formatter[] = [
  {
    name: 'biome',
    extensions: new Set([...SCRIPT_EXTENSIONS, 'json', 'jsonc', 'css', 'graphql', 'gql']),
    isWanted: async project =>
      project.find(...BIOME_CONFIGS) !== undefined || (await hasPackage(project, '@biomejs/biome')),
    bin: 'biome',
    localFolders: NODE_BIN,
    configDir: nearest([...BIOME_CONFIGS, 'package.json']),
    args: async file => ['format', '--write', file],
  },
  {
    name: 'prettier',
    extensions: new Set([
      ...SCRIPT_EXTENSIONS,
      'json',
      'jsonc',
      'json5',
      'css',
      'scss',
      'less',
      'md',
      'mdx',
      'yaml',
      'yml',
      'html',
      'vue',
      'svelte',
      'graphql',
      'gql',
    ]),
    isWanted: async project =>
      project.find(...PRETTIER_CONFIGS) !== undefined || (await hasPackage(project, 'prettier')),
    bin: 'prettier',
    localFolders: NODE_BIN,
    configDir: nearest([...PRETTIER_CONFIGS, 'package.json']),
    args: async file => ['--write', file],
  },
  {
    name: 'ruff',
    extensions: new Set(['py', 'pyi']),
    isWanted: async project =>
      project.find(...RUFF_CONFIGS) !== undefined || (await pyprojectMatches(project, /\[tool\.ruff[\].]/)),
    bin: 'ruff',
    localFolders: PYTHON_BIN,
    configDir: nearest([...RUFF_CONFIGS, 'pyproject.toml']),
    args: async file => ['format', '--quiet', file],
  },
  {
    name: 'black',
    extensions: new Set(['py', 'pyi']),
    isWanted: project => pyprojectMatches(project, /\[tool\.black\]|["'\s]black\s*[>=<~!"',\]]/),
    bin: 'black',
    localFolders: PYTHON_BIN,
    configDir: nearest(['pyproject.toml']),
    args: async file => ['--quiet', file],
  },
  {
    name: 'gofmt',
    extensions: new Set(['go']),
    isWanted: always,
    bin: 'gofmt',
    localFolders: [],
    configDir: nearest(['go.mod']),
    args: async file => ['-w', file],
  },
  {
    name: 'rustfmt',
    extensions: new Set(['rs']),
    isWanted: always,
    bin: 'rustfmt',
    localFolders: [],
    configDir: nearest(['Cargo.toml']),
    args: async (file, project) => {
      const [cargo] = await project.readAll('Cargo.toml')
      const edition = cargo?.text.match(/^\s*edition\s*=\s*"(\d{4})"/m)?.[1]
      return edition === undefined ? [file] : ['--edition', edition, file]
    },
  },
  {
    name: 'shfmt',
    extensions: new Set(['sh', 'bash']),
    isWanted: always,
    bin: 'shfmt',
    localFolders: [],
    configDir: nearest(['.editorconfig']),
    args: async file => ['-w', file],
  },
  {
    name: 'clang-format',
    extensions: new Set(['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'm', 'mm', 'proto']),
    isWanted: async project => project.find(...CLANG_CONFIGS) !== undefined,
    bin: 'clang-format',
    localFolders: [],
    configDir: nearest(CLANG_CONFIGS),
    args: async file => ['-i', file],
  },
  {
    name: 'php-cs-fixer',
    extensions: new Set(['php']),
    isWanted: async project => project.find(...PHP_CS_CONFIGS) !== undefined,
    bin: 'php-cs-fixer',
    localFolders: ['vendor/bin'],
    configDir: nearest(PHP_CS_CONFIGS),
    args: async file => ['fix', '--quiet', file],
  },
]

/** The formatters that handle this file's extension, ignoring disabled ones. */
const candidatesFor = (file: string, disabled: ReadonlySet<string>): Formatter[] => {
  const ext = extension(file)
  return FORMATTERS.filter(formatter => formatter.extensions.has(ext) && !disabled.has(formatter.name))
}

/** The first candidate the project asks for, or undefined. */
export const pickFormatter = async (
  file: string,
  project: Project,
  disabled: ReadonlySet<string>,
): Promise<Formatter | undefined> => {
  for (const formatter of candidatesFor(file, disabled)) {
    if (await formatter.isWanted(project)) return formatter
  }
  return undefined
}
