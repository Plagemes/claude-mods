/**
 * Where a digest's facts come from, as pure readers: `git log`, the session-journal markdown files, smart-router's
 * daily.json and the hub's events. Each takes text (or a plain object) and returns plain data.
 */

export type Commit = { sha: string; author: string; at: number; subject: string }

export type Journal = { date: string; done: string[]; questions: string[]; todos: string[] }

export type DigestEvent = {
  /** A channel notice's id: the hub delivers at least once, so the same id is kept once. */
  id?: string
  at: number
  kind: 'ci' | 'deploy' | 'pr' | 'decision' | 'test' | 'notice' | 'error' | 'session'
  text: string
  /** ci / deploy / test: how it went. */
  outcome?: 'ok' | 'failed'
  /** notice: how loud it was. */
  level?: 'info' | 'success' | 'warning' | 'error' | 'critical'
  /** ci: the workflow and branch a later result replaces. */
  group?: string
  url?: string
  usd?: number
}

const FIELD = '\u001f'
const RECORD = '\u001e'

/** The argv of the log the digest reads: local branches, merges left out, one record per commit. */
export const gitLogArgv = (sinceIso: string, untilIso: string): string[] => [
  'git',
  'log',
  '--branches',
  '--no-merges',
  `--since=${sinceIso}`,
  `--until=${untilIso}`,
  '-n',
  '300',
  `--pretty=format:%h${FIELD}%an${FIELD}%aI${FIELD}%s${RECORD}`,
]

/** Reads `gitLogArgv`'s output. A commit listed twice (two branches) once. */
export function parseGitLog(stdout: string): Commit[] {
  const seen = new Set<string>()
  const commits: Commit[] = []
  for (const record of stdout.split(RECORD)) {
    const [sha = '', author = '', date = '', ...rest] = record.trim().split(FIELD)
    const at = Date.parse(date)
    if (sha === '' || Number.isNaN(at) || seen.has(sha)) continue
    seen.add(sha)
    commits.push({ sha, author, at, subject: rest.join(FIELD).trim() })
  }
  return commits.sort((a, b) => a.at - b.at)
}

const bullets = (block: string): string[] =>
  block
    .split('\n')
    .map(line => /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.*\S)\s*$/.exec(line)?.[1] ?? '')
    .filter(line => line !== '')

/**
 * One session-journal day file (`.claude/journal/YYYY-MM-DD.md`, entries `## 18:06 · project · branch` with the
 * sections Work done, Open questions, Files changed, Requests, Open todos). Unchecked todos only.
 */
export function parseJournal(markdown: string, date: string): Journal {
  const journal: Journal = { date, done: [], questions: [], todos: [] }
  let section = ''
  for (const line of markdown.split('\n')) {
    const heading = /^#{2,4}\s+(.*?)\s*$/.exec(line)
    if (heading !== null) {
      section = /^\d{1,2}:\d{2}\b/.test(heading[1] ?? '') ? '' : (heading[1] ?? '').toLowerCase()
      continue
    }
    const item = bullets(line)[0]
    if (item === undefined) continue
    const isChecked = /^\s*[-*]\s+\[[xX]\]/.test(line)
    if (section === 'work done') journal.done.push(item)
    else if (section === 'open questions') journal.questions.push(item)
    else if (section === 'open todos' && !isChecked) journal.todos.push(item)
  }
  return journal
}

/** smart-router's `daily.json`: what was spent on one day, across every project. */
export function parseDaily(value: unknown): { date: string; spent: number } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const daily = value as { date?: unknown; spent?: unknown }
  return typeof daily.date === 'string' && typeof daily.spent === 'number' && daily.spent >= 0 ? { date: daily.date, spent: daily.spent } : undefined
}

type HubEvent = { topic: string; data: unknown; at: number }

const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {})
const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/** A hub event as something a digest can say; undefined for the topics a digest has no use for. */
export function eventFromHub(event: HubEvent): DigestEvent | undefined {
  const data = record(event.data)
  const url = str(data.url)
  const withUrl = url === '' ? {} : { url }
  switch (event.topic) {
    case 'ci.result': {
      const outcome = str(data.outcome)
      if (outcome === 'cancelled') return undefined
      const workflow = str(data.workflow) || 'CI'
      const branch = str(data.branch)
      return { at: event.at, kind: 'ci', outcome: outcome === 'passed' ? 'ok' : 'failed', text: branch === '' ? workflow : `${workflow} (${branch})`, group: `${str(data.provider)}:${workflow}:${branch}`, ...withUrl }
    }
    case 'deploy.finished':
      return { at: event.at, kind: 'deploy', outcome: 'ok', text: `${str(data.target)} → ${str(data.environment)}${str(data.version) === '' ? '' : ` ${str(data.version)}`}`, group: `${str(data.target)}:${str(data.environment)}`, ...withUrl }
    case 'deploy.failed':
      return { at: event.at, kind: 'deploy', outcome: 'failed', text: `${str(data.target)} → ${str(data.environment)}: ${str(data.reason)}`, group: `${str(data.target)}:${str(data.environment)}`, ...withUrl }
    case 'pr.opened':
      return { at: event.at, kind: 'pr', text: str(data.title), ...withUrl }
    case 'decision.recorded':
      return { at: event.at, kind: 'decision', text: str(data.summary) === '' ? str(data.title) : `${str(data.title)}: ${str(data.summary)}` }
    case 'test.result': {
      const outcome = str(data.outcome)
      const passed = num(data.passed)
      const failed = num(data.failed)
      const counts = passed === undefined && failed === undefined ? '' : `: ${passed ?? 0} passed, ${failed ?? 0} failed`
      return { at: event.at, kind: 'test', outcome: outcome === 'passed' ? 'ok' : 'failed', text: `${str(data.runner)}${counts}` }
    }
    case 'error.repeated':
      return { at: event.at, kind: 'error', text: `${str(data.tool)}: ${str(data.signature)} (${num(data.count) ?? 0} times)` }
    case 'session.ended': {
      const usd = num(data.usd)
      return { at: event.at, kind: 'session', text: `${Math.round((num(data.durationMs) ?? 0) / 60_000)} min`, ...(usd === undefined ? {} : { usd }) }
    }
    default:
      return undefined
  }
}

/** A notice the hub queued for the email channel. */
export function eventFromNotice(notice: { id?: unknown; level?: unknown; title?: unknown; body?: unknown; at?: unknown; url?: unknown }): DigestEvent | undefined {
  const level = str(notice.level)
  const title = str(notice.title)
  if (title === '' || !['info', 'success', 'warning', 'error', 'critical'].includes(level)) return undefined
  const body = str(notice.body)
  const url = str(notice.url)
  return { ...(str(notice.id) === '' ? {} : { id: str(notice.id) }), at: num(notice.at) ?? 0, kind: 'notice', level: level as NonNullable<DigestEvent['level']>, text: body === '' ? title : `${title}: ${body}`, ...(url === '' ? {} : { url }) }
}

/** The failing ci/deploy events whose latest result for the same workflow (or target) is still a failure. */
export function unresolved(events: readonly DigestEvent[], kind: 'ci' | 'deploy'): DigestEvent[] {
  const latest = new Map<string, DigestEvent>()
  for (const event of [...events].sort((a, b) => a.at - b.at)) {
    if (event.kind === kind && event.group !== undefined) latest.set(event.group, event)
  }
  return [...latest.values()].filter(event => event.outcome === 'failed')
}

const SEEN_KEY = (event: DigestEvent): string => (event.id === undefined ? `${event.kind}|${event.text}|${Math.floor(event.at / 60_000)}` : `id|${event.id}`)

/** Adds fresh events to a list, skipping ones already there, newest last, capped. */
export function mergeEvents(known: readonly DigestEvent[], fresh: readonly DigestEvent[], cap: number): DigestEvent[] {
  const seen = new Set(known.map(SEEN_KEY))
  const merged = [...known]
  for (const event of fresh) {
    const key = SEEN_KEY(event)
    if (!seen.has(key)) {
      seen.add(key)
      merged.push(event)
    }
  }
  return merged.sort((a, b) => a.at - b.at).slice(-cap)
}
