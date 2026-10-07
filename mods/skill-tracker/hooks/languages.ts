/** File extension (lower case, no dot) to the language it is written in. */
const BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', pyi: 'Python', ipynb: 'Jupyter',
  go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', kts: 'Kotlin', scala: 'Scala', groovy: 'Groovy',
  swift: 'Swift', mm: 'Objective-C',
  rb: 'Ruby', php: 'PHP', pl: 'Perl', lua: 'Lua', r: 'R', jl: 'Julia',
  c: 'C', h: 'C', cc: 'C++', cpp: 'C++', cxx: 'C++', hpp: 'C++', hh: 'C++', cs: 'C#', fs: 'F#', vb: 'Visual Basic',
  dart: 'Dart', ex: 'Elixir', exs: 'Elixir', erl: 'Erlang', hs: 'Haskell', clj: 'Clojure', ml: 'OCaml', zig: 'Zig', nim: 'Nim',
  sh: 'Shell', bash: 'Shell', zsh: 'Shell', fish: 'Shell', ps1: 'PowerShell', bat: 'Batch',
  sql: 'SQL', graphql: 'GraphQL', gql: 'GraphQL', proto: 'Protobuf', prisma: 'Prisma',
  html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'CSS', sass: 'CSS', less: 'CSS', vue: 'Vue', svelte: 'Svelte', astro: 'Astro',
  md: 'Markdown', mdx: 'Markdown', rst: 'reStructuredText', tex: 'LaTeX',
  json: 'JSON', jsonc: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', xml: 'XML', ini: 'INI',
  tf: 'Terraform', tfvars: 'Terraform', hcl: 'HCL', nix: 'Nix', sol: 'Solidity',
}

/** Files known by name rather than extension. */
const BY_NAME: Readonly<Record<string, string>> = {
  dockerfile: 'Dockerfile',
  makefile: 'Makefile',
  gemfile: 'Ruby',
  rakefile: 'Ruby',
  jenkinsfile: 'Groovy',
}

/** The language of a file path, or undefined for files that say nothing about it (images, lockfiles, notes). */
export const languageOf = (path: string): string | undefined => {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase()
  if (Object.hasOwn(BY_NAME, name)) return BY_NAME[name]
  if (name.startsWith('dockerfile.')) return 'Dockerfile'
  const dot = name.lastIndexOf('.')
  const extension = dot <= 0 ? '' : name.slice(dot + 1)
  return Object.hasOwn(BY_EXTENSION, extension) ? BY_EXTENSION[extension] : undefined
}

/** Command names worth counting, each mapped to the name it is shown under. */
const TOOLS: Readonly<Record<string, string>> = {
  git: 'git', gh: 'gh', docker: 'docker', 'docker-compose': 'docker', podman: 'podman', kubectl: 'kubectl', helm: 'helm',
  terraform: 'terraform', tofu: 'terraform', ansible: 'ansible', aws: 'aws', gcloud: 'gcloud', az: 'az',
  npm: 'npm', npx: 'npm', pnpm: 'pnpm', yarn: 'yarn', bun: 'bun', bunx: 'bun', node: 'node', deno: 'deno',
  tsc: 'tsc', eslint: 'eslint', prettier: 'prettier', vite: 'vite', jest: 'jest', vitest: 'vitest',
  cargo: 'cargo', rustc: 'rustc', rustup: 'rustup', go: 'go', gofmt: 'gofmt',
  python: 'python', python3: 'python', pip: 'pip', pip3: 'pip', uv: 'uv', poetry: 'poetry', pytest: 'pytest', ruff: 'ruff', black: 'black', mypy: 'mypy',
  java: 'java', mvn: 'mvn', gradle: 'gradle', dotnet: 'dotnet', ruby: 'ruby', bundle: 'bundle', rake: 'rake', rails: 'rails',
  php: 'php', composer: 'composer', swift: 'swift', xcodebuild: 'xcodebuild', flutter: 'flutter', dart: 'dart', mix: 'mix',
  make: 'make', cmake: 'cmake', ninja: 'ninja', gcc: 'gcc', clang: 'clang',
  psql: 'psql', mysql: 'mysql', sqlite3: 'sqlite3', 'redis-cli': 'redis-cli', mongosh: 'mongosh',
  curl: 'curl', wget: 'wget', ssh: 'ssh', scp: 'scp', rsync: 'rsync', jq: 'jq', tmux: 'tmux',
  brew: 'brew', apt: 'apt', 'apt-get': 'apt', systemctl: 'systemctl', journalctl: 'journalctl', nix: 'nix',
}

/** Words that run the next command rather than being one. */
const WRAPPERS = new Set(['sudo', 'time', 'env', 'command', 'nohup', 'exec', 'nice', 'xargs'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** The tools a shell command runs, each once: the first word of every simple command, after env assignments and `sudo`. */
export const toolsOf = (command: string): string[] => {
  const found = new Set<string>()
  for (const part of command.split(/&&|\|\||[;|\n(){}]/)) {
    const words = part.trim().split(/\s+/)
    let at = 0
    while (at < words.length && (ASSIGNMENT.test(words[at] ?? '') || WRAPPERS.has(words[at] ?? ''))) at += 1
    const name = (words[at] ?? '').replace(/^.*\//, '')
    if (Object.hasOwn(TOOLS, name)) found.add(TOOLS[name] as string)
  }
  return [...found]
}
