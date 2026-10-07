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
