import { normalizePythonName, lockfileKind } from './lockfiles'
import type { LockfileKind } from './lockfiles'

/** A lockfile found under the project root. */
export type FoundLockfile = { dir: string; name: string; kind: LockfileKind }

/** Folders never searched for lockfiles. */
export const SKIPPED_DIRS = new Set(['node_modules', 'vendor', 'target', 'dist', 'build', 'venv', 'env', '__pycache__', 'site-packages'])

export const joinPath = (...parts: string[]): string =>
  parts
    .filter(part => part !== '')
    .join('/')
    .replace(/\/{2,}/g, '/')

export const relativeTo = (root: string, path: string): string =>
  path === root ? '.' : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path

export const basename = (path: string): string => path.replace(/\/+$/, '').slice(path.replace(/\/+$/, '').lastIndexOf('/') + 1)

/**
 * The lockfiles of one folder worth reading: a Python lock (poetry.lock,
 * uv.lock) makes its folder's requirements files redundant, and a go.mod
 * makes go.sum redundant.
 */
export const pickLockfiles = (dir: string, names: readonly string[]): FoundLockfile[] => {
  const found = names.flatMap(name => {
    const kind = lockfileKind(name)
    return kind === undefined ? [] : [{ dir, name, kind }]
  })
  const has = (kind: LockfileKind) => found.some(one => one.kind === kind)
  return found
    .filter(one => !(one.kind === 'requirements.txt' && (has('poetry.lock') || has('uv.lock'))))
    .filter(one => !(one.kind === 'go.sum' && has('go.mod')))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Where pnpm keeps a package's own package.json: `node_modules/.pnpm/@scope+name@1.0.0/node_modules/@scope/name`. */
export const pnpmStorePath = (dir: string, name: string, version: string): string =>
  joinPath(dir, 'node_modules/.pnpm', `${name.replace('/', '+')}@${version}`, 'node_modules', name, 'package.json')

/** The Go module cache spelling of a path: each capital letter as `!` and the lower-case letter. */
export const escapeGoPath = (path: string): string => path.replace(/[A-Z]/g, letter => `!${letter.toLowerCase()}`)

/** `Jinja2-2.11.2.dist-info` → key `jinja2@2.11.2`, for matching lockfile entries to installed metadata. */
export const distInfoKey = (folder: string): string | undefined => {
  const match = /^(.+)-([^-]+)\.dist-info$/.exec(folder)
  return match === null ? undefined : `${normalizePythonName(match[1] as string)}@${match[2]}`
}

/** The license files a folder lists, best first. */
export const licenseFiles = (names: readonly string[]): string[] =>
  names.filter(name => /^(?:LICEN[CS]E|COPYING)(?:[.-][\w.-]*)?$/i.test(name)).sort((a, b) => a.length - b.length)

/** The project's name: package.json's `name`, else the folder's. */
export const projectNameOf = (root: string, manifest: string | undefined): string => {
  if (manifest !== undefined) {
    try {
      const parsed: unknown = JSON.parse(manifest)
      if (typeof parsed === 'object' && parsed !== null) {
        const name = (parsed as Record<string, unknown>).name
        if (typeof name === 'string' && name !== '') return name
      }
    } catch {
      // Fall back to the folder name.
    }
  }
  return basename(root) || 'project'
}

/** Runs `work` over `items`, at most `limit` at a time. */
export const inBatches = async <T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> => {
  for (let start = 0; start < items.length; start += limit) {
    await Promise.all(items.slice(start, start + limit).map(work))
  }
}
