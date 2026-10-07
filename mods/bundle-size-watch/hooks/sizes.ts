export type FileInfo = { path: string; size: number; mtimeMs: number }

/** What is kept of a build between sessions: the total, and the largest files by their hash-free names. */
export type Snapshot = { at: number; dir: string; total: number; files: Record<string, number> }

export const KB = 1024
const KEPT_FILES = 30
const MAX_CHANGES_SHOWN = 3
const MIN_CHANGE_BYTES = KB

const BUILD_COMMANDS = [
  /\b(?:npm|pnpm|bun)\s+(?:run\s+)?build[\w:.-]*/,
  /\byarn\s+(?:run\s+)?build[\w:.-]*/,
  /\b(?:vite|next|nuxt|nuxi|astro|ng|parcel|rsbuild|rspack|svelte-kit|vue-cli-service|gatsby|turbo)\s+build\b/,
  /(?:^|[;&|(]\s*|\bnpx\s+|\bbunx\s+|\bpnpm\s+(?:exec\s+|dlx\s+)?|\byarn\s+(?:exec\s+)?)(?:webpack(?:-cli)?|rollup|esbuild|tsup)(?![\w-])/,
]
const WATCHING = /(?:^|\s)(?:--watch|-w|serve|--help|-h|--version)(?:\s|=|$)/

/** True for a command that builds a front-end bundle (and is not a watcher or dev server). */
export const isBuildCommand = (command: string): boolean => {
  // "git commit -m 'npm run build'" is not a build, but `bash -c "npm run build"` is.
  const visible = /\b(?:bash|sh|zsh|eval|xargs)\b/.test(command) ? command : command.replace(/"[^"]*"|'[^']*'/g, '""')
  return BUILD_COMMANDS.some(pattern => pattern.test(visible)) && !WATCHING.test(visible)
}

/** The folder a command starts with `cd` into: `cd web && npm run build` builds in `web`. */
export const leadingCd = (command: string): string | undefined => {
  const match = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:&&|;)/.exec(command)
  return match?.[1] ?? match?.[2] ?? match?.[3]
}

const HASHED = /([.-])([A-Za-z0-9_]{6,20})((?:\.(?:chunk|min|bundle|esm|umd))*\.[A-Za-z0-9]+)$/

/** A digit, or the 8 mixed-case characters of a Vite hash: a word like "Regular" is not one. */
const looksLikeHash = (text: string): boolean => /\d/.test(text) || (text.length === 8 && /[A-Z]/.test(text) && /[a-z]/.test(text))

/** `index-DgWgUv9n.js` and `index-a81f3c.js` are the same file between builds: the hash is replaced. */
export const normalizeName = (path: string): string =>
  path.replace(HASHED, (whole, separator: string, hash: string, extension: string) => (looksLikeHash(hash) ? `${separator}[hash]${extension}` : whole))

const COMPRESSIBLE = /\.(?:js|mjs|cjs|css|html?|svg|json|txt|xml)$/i

export const isCompressible = (path: string): boolean => COMPRESSIBLE.test(path)

/** Source maps are not shipped to users, so they do not count. */
export const bundleFiles = (files: readonly FileInfo[]): FileInfo[] => files.filter(file => !/\.map$/i.test(file.path))

export const totalOf = (files: readonly FileInfo[]): number => files.reduce((sum, file) => sum + file.size, 0)

export const largest = (files: readonly FileInfo[], count: number): FileInfo[] => [...files].sort((a, b) => b.size - a.size).slice(0, count)

export const snapshotOf = (files: readonly FileInfo[], dir: string, at: number): Snapshot => {
  const sizes: Record<string, number> = {}
  for (const file of largest(files, KEPT_FILES * 2)) sizes[normalizeName(file.path)] = (sizes[normalizeName(file.path)] ?? 0) + file.size
  const kept = Object.entries(sizes).sort((a, b) => b[1] - a[1]).slice(0, KEPT_FILES)
  return { at, dir, total: totalOf(files), files: Object.fromEntries(kept) }
}

export const formatSize = (bytes: number): string => {
  const size = Math.abs(bytes)
  if (size < KB) return `${size} B`
  if (size < KB * KB) return `${(size / KB).toFixed(size < 10 * KB ? 1 : 0).replace(/\.0$/, '')} KB`
  return `${(size / (KB * KB)).toFixed(2).replace(/0$/, '')} MB`
}

export const formatDelta = (bytes: number): string => (bytes === 0 ? '±0' : `${bytes > 0 ? '+' : '-'}${formatSize(bytes)}`)

/** The files that changed most between two builds, as "index-[hash].js +14 KB". */
export const biggestChanges = (previous: Snapshot, current: Snapshot): string[] =>
  [...new Set([...Object.keys(previous.files), ...Object.keys(current.files)])]
    .map(name => ({ name, change: (current.files[name] ?? 0) - (previous.files[name] ?? 0) }))
    .filter(item => Math.abs(item.change) >= MIN_CHANGE_BYTES)
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
    .slice(0, MAX_CHANGES_SHOWN)
    .map(item => `${item.name.split('/').slice(-2).join('/')} ${formatDelta(item.change)}`)
