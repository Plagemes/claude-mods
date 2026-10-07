// Pure Keep a Changelog editing: commit subject → entry → Unreleased section. No `$` here.

export const SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'] as const
export type Section = (typeof SECTIONS)[number]

export type Entry = { section: Section; text: string }

export type ParseOptions = {
  /** What a subject that is not a Conventional Commit becomes. */
  untyped: 'changed' | 'skip'
  /** Keep docs/test/chore/ci/build/style commits too (under Changed). */
  includeChores: boolean
}

export const TEMPLATE = [
  '# Changelog',
  '',
  'All notable changes to this project will be documented in this file.',
  '',
  'The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),',
  'and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).',
  '',
  '## [Unreleased]',
  '',
].join('\n')

const CONVENTIONAL = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/
const NOT_A_CHANGE = /^(merge\b|wip\b|fixup!|squash!|amend!)/i
const UNRELEASED = /^##\s+\[?unreleased\]?/i
const RELEASE = /^##\s/
const SUBSECTION = /^###\s+(.+?)\s*$/

const TYPE_SECTIONS: Record<string, Section> = {
  feat: 'Added', feature: 'Added', add: 'Added',
  fix: 'Fixed', bugfix: 'Fixed', hotfix: 'Fixed',
  perf: 'Changed', refactor: 'Changed', change: 'Changed', improve: 'Changed', revert: 'Changed',
  deprecate: 'Deprecated',
  remove: 'Removed',
  security: 'Security', sec: 'Security',
}
const CHORE_TYPES = new Set(['docs', 'doc', 'test', 'tests', 'chore', 'ci', 'build', 'style', 'release', 'deps'])

const sentence = (text: string): string => {
  const trimmed = text.trim().replace(/\.$/, '')
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}

/** Maps a commit to its changelog entry, or undefined when it does not belong in one. */
export const parseCommit = (subject: string, body: string, options: ParseOptions): Entry | undefined => {
  const line = subject.trim()
  if (line === '' || NOT_A_CHANGE.test(line)) return undefined
  const isBreakingBody = /^BREAKING[ -]CHANGE:/m.test(body)
  const match = CONVENTIONAL.exec(line)
  if (match === null) {
    if (/^revert\b/i.test(line)) return { section: 'Changed', text: sentence(line) }
    return options.untyped === 'changed' ? { section: 'Changed', text: sentence(line) } : undefined
  }
  const [, rawType = '', scope = '', bang, description = ''] = match
  const type = rawType.toLowerCase()
  const isBreaking = bang === '!' || isBreakingBody
  const isChore = CHORE_TYPES.has(type)
  let section = TYPE_SECTIONS[type]
  if (section === 'Fixed' && /^(security|sec|cve)/i.test(scope)) section = 'Security'
  if (section === undefined && (isBreaking || (isChore && options.includeChores))) section = 'Changed'
  if (section === undefined && !isChore && options.untyped === 'changed') section = 'Changed'
  if (section === undefined) return undefined
  const lead = scope.trim() === '' ? '' : `**${scope.trim()}:** `
  return { section, text: `${isBreaking ? '**Breaking:** ' : ''}${lead}${sentence(description)}` }
}

const sectionOrder = (name: string): number =>
  SECTIONS.findIndex(section => section.toLowerCase() === name.trim().toLowerCase())

const lastFilled = (lines: readonly string[], from: number, to: number): number => {
  let at = to - 1
  while (at > from && (lines[at] ?? '').trim() === '') at -= 1
  return at
}

/** Adds `- text` under `## [Unreleased]` → `### section`, creating either when missing. */
export const insertEntry = (markdown: string, entry: Entry, suffix = ''): { markdown: string; isChanged: boolean } => {
  const lines = markdown.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')
  const bullet = `- ${entry.text}${suffix}`

  let start = lines.findIndex(line => UNRELEASED.test(line))
  if (start === -1) {
    const firstRelease = lines.findIndex(line => RELEASE.test(line))
    const at = firstRelease === -1 ? lines.length : firstRelease
    lines.splice(at, 0, ...(at > 0 && (lines[at - 1] ?? '').trim() !== '' ? [''] : []), '## [Unreleased]', '')
    start = lines.findIndex(line => UNRELEASED.test(line))
  }
  const next = lines.findIndex((line, index) => index > start && RELEASE.test(line))
  const end = next === -1 ? lines.length : next

  const isPresent = lines
    .slice(start, end)
    .some(line => line.trim() === bullet || line.trim().startsWith(`- ${entry.text} (`) || line.trim() === `- ${entry.text}`)
  if (isPresent) return { markdown, isChanged: false }

  const headings = lines
    .map((line, index) => ({ index, name: SUBSECTION.exec(line)?.[1] }))
    .filter((h): h is { index: number; name: string } => h.name !== undefined && h.index > start && h.index < end)
  const own = headings.find(h => sectionOrder(h.name) === sectionOrder(entry.section))

  if (own !== undefined) {
    const close = headings.find(h => h.index > own.index)?.index ?? end
    lines.splice(lastFilled(lines, own.index, close) + 1, 0, bullet)
  } else {
    const order = sectionOrder(entry.section)
    const before = headings.find(h => sectionOrder(h.name) > order)?.index ?? end
    const at = lastFilled(lines, start, before) + 1
    lines.splice(at, before - at, '', `### ${entry.section}`, '', bullet, ...(before < lines.length ? [''] : []))
  }
  // A file written with CRLF keeps CRLF: only the new lines should show in a diff.
  const newline = markdown.includes('\r\n') ? '\r\n' : '\n'
  return { markdown: `${lines.join(newline)}${newline}`, isChanged: true }
}

/** The body of `## [Unreleased]`, or undefined when the file has none. */
export const unreleasedOf = (markdown: string): string | undefined => {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex(line => UNRELEASED.test(line))
  if (start === -1) return undefined
  const next = lines.findIndex((line, index) => index > start && RELEASE.test(line))
  return lines.slice(start + 1, next === -1 ? lines.length : next).join('\n').trim()
}

export const countEntries = (section: string): number => section.split('\n').filter(line => /^\s*[-*]\s+\S/.test(line)).length
