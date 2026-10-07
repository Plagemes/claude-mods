// Pure path and glob matching for scope-lock: `**`, `*`, `?`, `[abc]` and `{a,b}`. No `$` here.

const SPECIAL = /[.+^$()|\\]/g

/** `./src/auth/` → `src/auth/**`; backslashes become slashes; empty parts and `./` go. */
export const normalizeGlob = (glob: string): string => {
  let clean = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/')
  if (clean.endsWith('/')) clean += '**'
  return clean
}

export const hasWildcard = (glob: string): boolean => /[*?[{]/.test(glob)

/** A glob as a RegExp over whole `/`-separated paths. */
export const globToRegExp = (glob: string): RegExp => {
  let source = ''
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i] as string
    if (char === '*' && glob[i + 1] === '*') {
      const isSegment = (i === 0 || glob[i - 1] === '/') && (glob[i + 2] === '/' || i + 2 === glob.length)
      if (isSegment && glob[i + 2] === '/') {
        source += '(?:[^/]+/)*'
        i += 2
      } else {
        source += '.*'
        i += 1
      }
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else if (char === '[') {
      const end = glob.indexOf(']', i + 1)
      if (end === -1) source += '\\['
      else {
        source += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`
        i = end
      }
    } else if (char === '{') {
      const end = glob.indexOf('}', i)
      if (end === -1) source += '\\{'
      else {
        source += `(?:${glob.slice(i + 1, end).split(',').map(part => globToRegExp(part).source.slice(1, -1)).join('|')})`
        i = end
      }
    } else {
      source += char.replace(SPECIAL, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

export const isAbsolute = (path: string): boolean => /^(?:[A-Za-z]:)?[\\/]/.test(path)

/** Joins `path` onto `cwd` (unless absolute) and folds `.` and `..` lexically. */
export const resolvePath = (path: string, cwd: string): string => {
  const joined = (isAbsolute(path) ? path : `${cwd}/${path}`).replace(/\\/g, '/')
  const drive = /^[A-Za-z]:/.exec(joined)?.[0] ?? ''
  const parts: string[] = []
  for (const part of joined.slice(drive.length).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `${drive}/${parts.join('/')}`
}

/** `path` relative to `root`, '' for the root itself, undefined outside it. */
export const relativeTo = (root: string, path: string): string | undefined => {
  const base = resolvePath(root, '/')
  if (path === base) return ''
  return path.startsWith(`${base === '/' ? '' : base}/`) ? path.slice(base === '/' ? 1 : base.length + 1) : undefined
}

/** Whether a resolved absolute path is inside the scope: relative globs match from the root, absolute ones as they are. */
export const isInScope = (absolute: string, root: string, globs: readonly string[]): boolean => {
  const relative = relativeTo(root, absolute)
  return globs.some(raw => {
    const glob = normalizeGlob(raw)
    const subject = isAbsolute(glob) ? absolute : relative
    if (subject === undefined) return false
    const pattern = isAbsolute(glob) ? resolvePath(glob, '/') : glob
    if (!hasWildcard(pattern)) return subject === pattern || subject.startsWith(`${pattern}/`)
    return globToRegExp(pattern).test(subject)
  })
}
