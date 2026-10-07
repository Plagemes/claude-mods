import type { Register } from 'claude-code'

const DEFAULT_MAX_KB = 256
const BYTES_PER_KB = 1024
/** Generated files below this size are harmless to read whole. */
const SMALL_FILE_BYTES = 16 * BYTES_PER_KB

const LOCK_FILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'composer.lock',
  'Podfile.lock',
  'go.sum',
])
const GENERATED_NAME = /(\.min\.(js|mjs|cjs|css)|\.(bundle|chunk)\.(js|mjs|cjs|css)|\.(js|css)\.map|\.lock)$/i
/** Files the Read tool opens in a way of their own (pages, image blocks). */
const NOT_LINE_BASED = /\.(pdf|png|jpe?g|gif|webp)$/i

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

const isGenerated = (path: string): boolean => {
  const name = basename(path)

  return LOCK_FILES.has(name) || GENERATED_NAME.test(name)
}

const formatSize = (bytes: number): string =>
  bytes >= BYTES_PER_KB * BYTES_PER_KB
    ? `${(bytes / (BYTES_PER_KB * BYTES_PER_KB)).toFixed(1)} MB`
    : `${Math.round(bytes / BYTES_PER_KB)} KB`

const HOW_TO_READ =
  'Use Read with offset and limit for the part you need, or find it with Grep first.'

export const register: Register = (on, options) => {
  const maxBytes =
    (typeof options.maxKb === 'number' && options.maxKb > 0 ? options.maxKb : DEFAULT_MAX_KB) *
    BYTES_PER_KB

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const isBounded = e.limit !== undefined || e.pages !== undefined
    const isElsewhere = e._host !== undefined

    if (isBounded || isElsewhere || NOT_LINE_BASED.test(e.file_path)) {
      return next(e)
    }

    let size: number
    try {
      const stat = await $.fs.stat(e.file_path)
      if (stat.kind !== 'file') {
        return next(e)
      }
      size = stat.size
    } catch {
      // Missing or unreadable: let the Read tool report it.
      return next(e)
    }

    if (size > maxBytes) {
      return {
        deny: `big-read-guard: ${e.file_path} is ${formatSize(size)}, over the ${formatSize(maxBytes)} limit for a full read. ${HOW_TO_READ}`,
      }
    }

    if (size > SMALL_FILE_BYTES && isGenerated(e.file_path)) {
      return {
        deny: `big-read-guard: ${e.file_path} is a minified, bundled or lock file (${formatSize(size)}); reading it whole wastes context. ${HOW_TO_READ}`,
      }
    }

    return next(e)
  })
}
