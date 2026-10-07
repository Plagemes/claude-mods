/** One directory above an edited file, with the names of its entries. */
export type Level = { dir: string; names: ReadonlySet<string> }

/** What the scan learned about the project around one file. */
export type Project = {
  /** The file's own directory first, then each parent up to the repository root. */
  levels: readonly Level[]
  /** The nearest directory holding any of `names`, or undefined. */
  find: (...names: string[]) => string | undefined
  /** The text of the nearest file named `name`, or undefined. */
  readNearest: (name: string) => Promise<string | undefined>
}

export const dirname = (path: string): string => {
  const cut = path.lastIndexOf('/')
  if (cut < 0) return '.'
  return cut === 0 ? '/' : path.slice(0, cut)
}

export const join = (...parts: string[]): string =>
  parts
    .filter(part => part !== '')
    .join('/')
    .replace(/\/{2,}/g, '/')

export const isAbsolute = (path: string): boolean => path.startsWith('/')

/** The lower-cased extension without its dot ('' for none, or a dotfile). */
export const extension = (path: string): string => {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/** `path` relative to `root` when it lies inside it; else `path` unchanged. */
export const relativeTo = (root: string, path: string): string => {
  const prefix = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/** `path` made absolute against `dir` when it is relative. */
export const resolveFrom = (dir: string, path: string): string =>
  isAbsolute(path) ? path : join(dir, path.replace(/^\.\//, ''))

/** True when `$.process.run` rejected because the executable could not start. */
export const isNotInstalled = (error: unknown): boolean => /failed to start|ENOENT|not found/i.test(String(error))

/** JSON with comments and trailing commas (a tsconfig) as plain JSON text. */
const withoutJsonComments = (text: string): string => {
  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? ''
    if (char === '"') {
      const start = i
      for (i += 1; i < text.length && text[i] !== '"'; i += 1) if (text[i] === '\\') i += 1
      out += text.slice(start, i + 1)
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      out += '\n'
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
    } else {
      out += char
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

/**
 * The configs a "solution" tsconfig points at: `{ "files": [], "references": [...] }` checks nothing itself
 * (`tsc -p` on it passes whatever the code holds), so each referenced project is checked instead.
 * Undefined for any other tsconfig, or one that cannot be read.
 */
export const referencedConfigs = (text: string, dir: string): string[] | undefined => {
  let config: unknown
  try {
    config = JSON.parse(withoutJsonComments(text))
  } catch {
    return undefined
  }
  if (typeof config !== 'object' || config === null) return undefined
  const { files, include, references } = config as Record<string, unknown>
  if (!Array.isArray(files) || files.length > 0 || include !== undefined || !Array.isArray(references)) return undefined
  const paths = references.flatMap(reference => {
    const path = (reference as { path?: unknown } | null)?.path
    if (typeof path !== 'string' || path === '') return []
    const resolved = resolveFrom(dir, path.replace(/\/+$/, ''))
    return [resolved.endsWith('.json') ? resolved : join(resolved, 'tsconfig.json')]
  })
  return paths.length > 0 ? paths : undefined
}
