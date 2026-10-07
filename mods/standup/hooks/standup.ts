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

/** What mods-hub's sessions.json says about the other Claude sessions on this project: how many, their turns and cost, and the commits their heartbeats carry. */
export type Neighbours = { commits: Commit[]; sessions: number; turns: number; usd: number }

const NONE: Neighbours = { commits: [], sessions: 0, turns: 0, usd: 0 }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

const isInside = (cwd: unknown, root: string): boolean => typeof cwd === 'string' && (cwd === root || cwd.startsWith(`${root.replace(/[\\/]+$/, '')}/`))

/**
 * Reads the hub's `sessions.json` (session id → heartbeat): the sessions that work inside `root` other than `own`, and the
 * `git.commit` events any of them (this one included) published with scope `global` since `sinceMs`. `day` formats a time as `YYYY-MM-DD`.
 */
export const neighboursOf = (raw: unknown, root: string, own: string, sinceMs: number, day: (ms: number) => string): Neighbours => {
  if (!isRecord(raw)) return NONE
  const result: Neighbours = { commits: [], sessions: 0, turns: 0, usd: 0 }
  for (const [id, entry] of Object.entries(raw)) {
    if (!isRecord(entry) || !isInside(entry.cwd, root)) continue
    if (id !== own) {
      result.sessions += 1
      result.turns += number(entry.turns)
      result.usd += number(entry.usd)
    }
    for (const event of Array.isArray(entry.events) ? entry.events : []) {
      if (!isRecord(event) || event.topic !== 'git.commit' || number(event.at) < sinceMs || !isRecord(event.data)) continue
      const { sha, message } = event.data
      if (typeof sha === 'string' && typeof message === 'string' && message.trim() !== '') {
        result.commits.push({ date: day(number(event.at)), hash: sha.slice(0, 7), subject: (message.split('\n')[0] ?? '').trim() })
      }
    }
  }
  return result
}

/** The commits of `extra` that `known` (from git log) does not list, by hash, each once. */
export const unseenCommits = (known: readonly Commit[], extra: readonly Commit[]): Commit[] => {
  const seen = new Set(known.map(commit => commit.hash))
  return extra.filter(commit => !seen.has(commit.hash) && (seen.add(commit.hash), true))
}
