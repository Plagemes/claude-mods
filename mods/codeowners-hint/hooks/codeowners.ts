// CODEOWNERS parsing and matching, with GitHub's semantics: patterns are gitignore-style, the last
// matching rule wins, and a rule with no owners clears ownership for what it matches.

export type Rule = { line: number; pattern: string; owners: string[]; regex: RegExp }

const escapeRegExp = (text: string): string => text.replace(/[.+^${}()|[\]\\*?]/g, '\\$&')

// Turns one pattern into a regular expression over repository-relative paths ("src/app.ts").
const patternToRegExp = (pattern: string): RegExp => {
  const isDirectory = pattern.endsWith('/')
  const glob = (isDirectory ? pattern.slice(0, -1) : pattern).replace(/^\/+/, '')
  // A slash at the start or in the middle pins the pattern to the repository root.
  const isAnchored = pattern.startsWith('/') || glob.includes('/')

  let body = ''
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob.charAt(i)
    const atSegmentStart = i === 0 || glob.charAt(i - 1) === '/'
    if (ch === '\\' && i + 1 < glob.length) {
      i += 1
      body += escapeRegExp(glob.charAt(i))
    } else if (ch === '*' && glob.charAt(i + 1) === '*' && atSegmentStart && glob.charAt(i + 2) === '/') {
      body += '(?:.*/)?' // "**/": any number of directories
      i += 2
    } else if (ch === '*' && glob.charAt(i + 1) === '*' && atSegmentStart && i + 2 >= glob.length) {
      body += '.+' // "/**": everything inside
      i += 1
    } else if (ch === '*') {
      body += '[^/]*'
      if (glob.charAt(i + 1) === '*') i += 1
    } else if (ch === '?') {
      body += '[^/]'
    } else {
      body += escapeRegExp(ch)
    }
  }

  const hasWildcardEnd = /[*?]/.test(glob.split('/').at(-1) ?? '')
  // A directory (or a plain name) owns everything beneath it; `docs/*` reaches one level only.
  const suffix = isDirectory ? '/.*' : hasWildcardEnd ? '' : '(?:/.*)?'
  return new RegExp(`^${isAnchored ? '' : '(?:.*/)?'}${body}${suffix}$`)
}

// The pattern is the first whitespace-separated word ("\ " escapes a space); owners follow, up to a "#" comment.
const splitLine = (line: string): { pattern: string; owners: string[] } => {
  let pattern = ''
  let i = 0
  for (; i < line.length && !/\s/.test(line.charAt(i)); i += 1) {
    if (line.charAt(i) === '\\' && line.charAt(i + 1) === ' ') {
      pattern += '\\ '
      i += 1
    } else {
      pattern += line.charAt(i)
    }
  }
  const owners: string[] = []
  for (const word of line.slice(i).split(/\s+/)) {
    if (word.startsWith('#')) break
    if (word !== '') owners.push(word)
  }
  return { pattern, owners }
}

export const parseCodeowners = (text: string): Rule[] => {
  const rules: Rule[] = []
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim()
    // Blank lines and comments; "[Section]" headers belong to GitLab's dialect.
    if (line === '' || line.startsWith('#') || line.startsWith('[') || line.startsWith('^[')) return
    const { pattern, owners } = splitLine(line)
    rules.push({ line: index + 1, pattern, owners, regex: patternToRegExp(pattern.replace(/\\ /g, ' ')) })
  })
  return rules
}

// The last rule that matches wins, whoever it names.
export const matchRule = (rules: readonly Rule[], path: string): Rule | undefined =>
  [...rules].reverse().find(rule => rule.regex.test(path))

const collapse = (path: string): string[] => {
  const parts: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '' && part !== '.') parts.push(part)
  }
  return parts
}

export const isAbsolutePath = (path: string): boolean => /^(?:[\\/]|[A-Za-z]:[\\/])/.test(path)

// `path` relative to `root` with forward slashes, or undefined when it lies outside.
export const relativeTo = (root: string, path: string): string | undefined => {
  const base = collapse(root)
  const target = collapse(path)
  const isInside = base.length < target.length && base.every((part, index) => part === target[index])
  return isInside ? target.slice(base.length).join('/') : undefined
}
