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
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (cut < 0) return '.'
  return cut === 0 ? path.slice(0, 1) : path.slice(0, cut)
}

export const basename = (path: string): string =>
  path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

export const join = (dir: string, name: string): string =>
  dir.endsWith('/') || dir.endsWith('\\') ? `${dir}${name}` : `${dir}/${name}`

export const isAbsolute = (path: string): boolean => /^([\\/]|[A-Za-z]:[\\/])/.test(path)

/** The lower-cased extension without its dot ('' for none, or a dotfile). */
export const extension = (path: string): string => {
  const base = basename(path)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/** `path` shown relative to `root` when it lies inside it. */
export const shorten = (path: string, root: string | undefined): string =>
  root !== undefined && path.startsWith(join(root, '')) ? path.slice(join(root, '').length) : path

/** Whether any package.json up the chain names `name` as a dependency or a top-level key. */
export const hasPackage = async (project: Project, name: string): Promise<boolean> => {
  for (const { text } of await project.readAll('package.json')) {
    const manifest = parseJson(text)
    if (manifest === undefined) continue
    if (name in manifest) return true
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const deps = manifest[field]
      if (typeof deps === 'object' && deps !== null && name in deps) return true
    }
  }
  return false
}

/** Whether the nearest pyproject.toml matches `pattern`. */
export const pyprojectMatches = async (project: Project, pattern: RegExp): Promise<boolean> => {
  const [nearest] = await project.readAll('pyproject.toml')
  return nearest !== undefined && pattern.test(nearest.text)
}

const parseJson = (text: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** True when `$.process.run` rejected because the executable could not start. */
export const isNotInstalled = (error: unknown): boolean =>
  /failed to start|ENOENT|not found/i.test(String(error))
