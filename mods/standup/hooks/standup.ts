// Pure standup helpers: dates, the model's sections, and the paste-ready text. No `$` here.

export type Style = 'plain' | 'markdown' | 'slack'

export type Sections = { yesterday: string[]; today: string[]; blockers: string[] }

export type Commit = { date: string; hash: string; subject: string }

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAY_MS = 86_400_000
const MONDAY = 1
const MAX_FALLBACK_ITEMS = 8

/** One day back, or back to Friday on a Monday. */
export const defaultDays = (now: number): number => (new Date(now).getDay() === MONDAY ? 3 : 1)

/** "Mon 6 Oct": the first day the standup covers. */
export const sinceLabel = (now: number, days: number): string => {
  const since = new Date(now - days * DAY_MS)
  return `${WEEKDAYS[since.getDay()]} ${since.getDate()} ${MONTHS[since.getMonth()]}`
}

/** Reads `YYYY-MM-DD<TAB>hash<TAB>subject` lines from git log. */
export const parseLog = (stdout: string): Commit[] =>
  stdout
    .split('\n')
    .map(line => line.split('\t'))
    .filter((parts): parts is [string, string, string] => parts.length >= 3 && parts[2] !== '')
    .map(([date, hash, ...subject]) => ({ date, hash, subject: subject.join('\t').trim() }))

const HEADINGS: Record<keyof Sections, RegExp> = {
  yesterday: /^\W*yesterday\W*$/i,
  today: /^\W*today\W*$/i,
  blockers: /^\W*blockers?\W*$/i,
}

/** Splits the model's `YESTERDAY: / TODAY: / BLOCKERS:` answer; undefined when it is not in that shape. */
export const parseSections = (text: string): Sections | undefined => {
  const sections: Sections = { yesterday: [], today: [], blockers: [] }
  let current: keyof Sections | undefined
  let headings = 0
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const heading = (Object.keys(HEADINGS) as (keyof Sections)[]).find(key => HEADINGS[key].test(line.replace(/[:*_#]/g, ' ').trim()))
    if (heading !== undefined) {
      current = heading
      headings += 1
      continue
    }
    if (current === undefined) continue
    const item = line.replace(/^([-*•]|\d+[.)])\s*/, '').trim()
    if (item !== '') sections[current].push(item)
  }
  return headings >= 2 && sections.yesterday.length + sections.today.length > 0 ? sections : undefined
}

/** A standup built from the facts alone, for when the model cannot write one. */
export const fallbackSections = (commits: readonly Commit[], branch: string, dirtyFiles: number): Sections => {
  const subjects = [...new Set(commits.map(commit => commit.subject.replace(/^\w+(\([^)]*\))?!?:\s*/, '')))]
  const yesterday = subjects.slice(0, MAX_FALLBACK_ITEMS).map(s => s.charAt(0).toUpperCase() + s.slice(1))
  if (subjects.length > MAX_FALLBACK_ITEMS) yesterday.push(`…and ${subjects.length - MAX_FALLBACK_ITEMS} more`)
  const today = [`Continue on ${branch}${dirtyFiles > 0 ? ` (${dirtyFiles} files in progress)` : ''}`]
  return { yesterday: yesterday.length > 0 ? yesterday : ['No commits'], today, blockers: ['None'] }
}

/** The paste-ready text: plain (works anywhere), markdown, or Slack's own bold and bullets. */
export const formatSections = (sections: Sections, style: Style): string => {
  const heading = (title: string): string =>
    style === 'markdown' ? `**${title}**` : style === 'slack' ? `*${title}*` : `${title}:`
  const bullet = style === 'slack' ? '•' : '-'
  const block = (title: string, items: readonly string[]): string =>
    [heading(title), ...(items.length > 0 ? items : ['None']).map(item => `${bullet} ${item}`)].join('\n')
  return [
    block('Yesterday', sections.yesterday),
    block('Today', sections.today),
    block('Blockers', sections.blockers),
  ].join('\n\n')
}
