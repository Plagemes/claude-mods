export type BranchType = 'fix' | 'feat' | 'chore' | 'docs' | 'refactor' | 'test'

export type BranchName = { name: string; type: BranchType }

// Checked in this order, so "add tests for the parser" is a test and "fix a typo in the readme" is docs.
const KEYWORDS: ReadonlyArray<readonly [BranchType, ReadonlySet<string>]> = [
  ['test', new Set(['test', 'tests', 'testing', 'spec', 'specs', 'coverage', 'e2e'])],
  ['docs', new Set(['doc', 'docs', 'documentation', 'readme', 'changelog', 'comment', 'comments', 'typo', 'typos'])],
  ['fix', new Set(['fix', 'fixes', 'fixed', 'fixing', 'bug', 'bugs', 'bugfix', 'hotfix', 'repair', 'patch', 'crash', 'crashes', 'broken', 'regression', 'resolve'])],
  ['refactor', new Set(['refactor', 'refactoring', 'restructure', 'cleanup', 'simplify', 'rename', 'extract', 'reorganize', 'rewrite', 'deduplicate'])],
  ['chore', new Set(['chore', 'bump', 'upgrade', 'dependency', 'dependencies', 'deps', 'lint', 'ci', 'release', 'tooling'])],
  ['feat', new Set(['add', 'implement', 'create', 'introduce', 'support', 'new', 'feature', 'enable', 'allow'])],
]
const CONVENTIONAL_TYPES: Readonly<Record<string, BranchType>> = {
  feat: 'feat', fix: 'fix', docs: 'docs', chore: 'chore', refactor: 'refactor', test: 'test',
  perf: 'refactor', style: 'chore', build: 'chore', ci: 'chore',
}
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'to', 'for', 'of', 'in', 'on', 'and', 'or', 'please', 'we', 'i', 'you', 'should', 'need',
  'needs', 'can', 'could', 'would', 'that', 'this', 'it', 'its', 'is', 'are', 'be', 'with', 'from', 'into', 'so', 'just',
])
const CONVENTIONAL_PREFIX = /^(\w+)(?:\([^)]*\))?!?:\s*/

function wordsOf(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(word => word !== '')
}

function inferType(words: readonly string[]): BranchType {
  for (const [type, keywords] of KEYWORDS) {
    if (words.some(word => keywords.has(word))) return type
  }
  return 'feat'
}

function isKeyword(word: string): boolean {
  return KEYWORDS.some(([, keywords]) => keywords.has(word))
}

/** Whole words only, joined with "-", at most `maxLength` characters. */
function joinWords(words: readonly string[], maxLength: number): string {
  let slug = ''
  for (const word of words) {
    const next = slug === '' ? word : `${slug}-${word}`
    if (next.length > maxLength) break
    slug = next
  }
  return slug === '' ? (words[0] ?? '').slice(0, maxLength) : slug
}

/** `<prefix>/<type>/<kebab-slug>` for a task description, or undefined when it has no usable words. */
export function nameBranch(description: string, prefix: string, maxSlugLength: number): BranchName | undefined {
  const firstLine = description.trim().split('\n')[0] ?? ''
  const conventional = CONVENTIONAL_PREFIX.exec(firstLine)
  const hinted = conventional ? CONVENTIONAL_TYPES[(conventional[1] as string).toLowerCase()] : undefined
  const text = hinted ? firstLine.slice((conventional as RegExpExecArray)[0].length) : firstLine

  const words = wordsOf(text)
  const type = hinted ?? inferType(words)
  const content = words.filter(word => !STOP_WORDS.has(word))
  // "fix login bug" is already a fix/ branch: the leading verb adds nothing to the slug.
  const trimmed = content.length > 1 && isKeyword(content[0] as string) ? content.slice(1) : content
  const slug = joinWords(trimmed.length > 0 ? trimmed : words, maxSlugLength)
  if (slug === '') return undefined

  const cleanPrefix = wordsOf(prefix).join('-')
  return { type, name: [cleanPrefix, type, slug].filter(part => part !== '').join('/') }
}
