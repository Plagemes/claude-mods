/** One directory above an edited file, with the names of its entries. */
export type Level = { dir: string; names: ReadonlySet<string> }

/** What the scan learned about the project around one file. */
export type Project = {
  /** The file's own directory first, then each parent up to the repository root. */
  levels: readonly Level[]
  /** The nearest directory holding any of `names`, or undefined. */
  find: (...names: string[]) => string | undefined
  /** Every file named `name` up the chain, nearest first, with its text. */
  readAll: (name: string) => Promise<{ dir: string; text: string }[]>
}

export const dirname = (path: string): string => {
  const cut = path.lastIndexOf('/')
  if (cut < 0) return '.'
  return cut === 0 ? '/' : path.slice(0, cut)
}

export const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

export const join = (...parts: string[]): string =>
  parts
    .filter(part => part !== '')
    .join('/')
    .replace(/\/{2,}/g, '/')

export const isAbsolute = (path: string): boolean => path.startsWith('/')

/** The lower-cased extension without its dot ('' for none, or a dotfile). */
export const extension = (path: string): string => {
  const base = basename(path)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/** `path` relative to `root` when it lies inside it ('' for the root itself); else `path`. */
export const relativeTo = (root: string, path: string): string => {
  if (path === root) return ''
  const prefix = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/** Whether any package.json up the chain names `name` as a dependency or a top-level key. */
export const hasPackage = async (project: Project, name: string): Promise<boolean> => {
  for (const { text } of await project.readAll('package.json')) {
    let manifest: unknown
    try {
      manifest = JSON.parse(text)
    } catch {
      continue
    }
    if (typeof manifest !== 'object' || manifest === null) continue
    if (name in manifest) return true
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const deps: unknown = (manifest as Record<string, unknown>)[field]
      if (typeof deps === 'object' && deps !== null && name in deps) return true
    }
  }
  return false
}

/** True when `$.process.run` rejected because the executable could not start. */
export const isNotInstalled = (error: unknown): boolean => /failed to start|ENOENT|not found/i.test(String(error))
