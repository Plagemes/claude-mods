// The three trackers, as data: the gh arguments, the Jira REST requests and the Linear GraphQL documents, and
// reading their answers into one issue shape. Pure: no `$` here (register.tsx makes the calls).

import type { IssuePilotFilters, IssuePilotIssue, IssuePilotProvider } from '../types'
import { acceptanceCriteria } from './compose'
import { estimate } from './estimate'
import type { LearnedRule } from './estimate'

/** An issue as a tracker gave it, before sizing. */
export type RawIssue = Omit<IssuePilotIssue, 'estimate'>

export const LIST_LIMIT = 50

/** Sizes a raw issue. */
export const sized = (raw: RawIssue, rules: readonly LearnedRule[]): IssuePilotIssue => ({
  ...raw,
  estimate: estimate({ title: raw.title, body: raw.body, labels: raw.labels, points: raw.points, criteria: acceptanceCriteria(raw.body).length }, rules),
})

/** Whether a git remote URL points at GitHub (https, ssh or git@ forms). */
export const isGitHubRemote = (remote: string): boolean => /(^|[@/.])github\.com[:/]/i.test(remote.trim())

/** Which tracker `auto` picks: Linear when its key is set, else Jira when configured, else GitHub. */
export function pickProvider(wanted: string, available: readonly IssuePilotProvider[]): IssuePilotProvider | undefined {
  if (wanted === 'github' || wanted === 'jira' || wanted === 'linear') return available.includes(wanted) ? wanted : undefined
  return (['linear', 'jira', 'github'] as const).find(one => available.includes(one))
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const firstLine = (value: string): string => value.trim().split('\n')[0]?.trim() ?? ''

// ── GitHub (gh) ─────────────────────────────────────────────────────────────────────────────────────

const GH_FIELDS = 'number,title,body,labels,milestone,url,state'

export function ghListArgs(filters: IssuePilotFilters): string[] {
  return [
    'issue', 'list', '--state', 'open', '--limit', String(LIST_LIMIT), '--json', GH_FIELDS,
    ...(filters.isMine ? ['--assignee', '@me'] : []),
    ...(filters.label.trim() === '' ? [] : ['--label', filters.label.trim()]),
    ...(filters.milestone.trim() === '' ? [] : ['--milestone', filters.milestone.trim()]),
  ]
}

export const ghViewArgs = (number: string): string[] => ['issue', 'view', number, '--json', GH_FIELDS]

type GhIssue = { number?: unknown; title?: unknown; body?: unknown; labels?: unknown; milestone?: unknown; url?: unknown; state?: unknown }

function ghIssue(item: GhIssue): RawIssue | undefined {
  if (typeof item.number !== 'number') return undefined
  const labels = Array.isArray(item.labels) ? item.labels.map(label => text((label as { name?: unknown } | null)?.name)).filter(name => name !== '') : []
  const milestone = text((item.milestone as { title?: unknown } | null)?.title)
  return {
    provider: 'github',
    id: String(item.number),
    ref: `#${item.number}`,
    number: String(item.number),
    title: text(item.title),
    body: text(item.body),
    url: text(item.url),
    labels,
    milestone: milestone === '' ? null : milestone,
    state: text(item.state).toLowerCase() || 'open',
    points: null,
  }
}

/** `gh issue list --json` output. */
export function parseGhList(stdout: string): RawIssue[] {
  const parsed: unknown = JSON.parse(stdout.trim() === '' ? '[]' : stdout)
  return Array.isArray(parsed) ? parsed.flatMap(item => ghIssue((item ?? {}) as GhIssue) ?? []) : []
}

/** `gh issue view --json` output. */
export function parseGhView(stdout: string): RawIssue | undefined {
  return ghIssue((JSON.parse(stdout) ?? {}) as GhIssue)
}

/** The PR link `gh pr create` prints last. */
export const prUrlIn = (stdout: string): string | undefined => stdout.match(/https:\/\/\S+\/pull\/\d+/g)?.at(-1)

/** A gh failure in words a person can act on. */
export function explainGh(stderr: string, exitCode: number): string {
  if (/gh auth login|not logged in|authentication required|HTTP 401|bad credentials/i.test(stderr)) return 'the GitHub CLI is not logged in: run `gh auth login`, then refresh.'
  if (/not a git repository|no git remote|could not determine (the )?(base )?repo|none of the git remotes/i.test(stderr)) return 'this folder is not a GitHub repository gh can use.'
  if (/already exists/i.test(stderr) && /pull request/i.test(stderr)) return `a pull request for this branch already exists: ${firstLine(stderr)}`
  const line = firstLine(stderr)
  return line === '' ? `gh exited with code ${exitCode}` : line.length > 200 ? `${line.slice(0, 199)}…` : line
}

export const GH_MISSING = 'the GitHub CLI (gh) is not installed: get it at https://cli.github.com.'

// ── Jira (REST v3, basic auth with an API token) ────────────────────────────────────────────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Base64 of a string's UTF-8 bytes (the module has no btoa). */
export function base64(value: string): string {
  const bytes: number[] = []
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x80) bytes.push(code)
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63))
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
  }
  let out = ''
  for (let at = 0; at < bytes.length; at += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[at], bytes[at + 1], bytes[at + 2]]
    const chunk = (a << 16) | (b << 8) | c
    out += B64[(chunk >> 18) & 63]
    out += B64[(chunk >> 12) & 63]
    out += at + 1 < bytes.length ? B64[(chunk >> 6) & 63] : '='
    out += at + 2 < bytes.length ? B64[chunk & 63] : '='
  }
  return out
}

export type JiraConfig = { baseUrl: string; email: string; token: string; jql: string }

export const jiraIsConfigured = (config: JiraConfig): boolean => config.baseUrl.trim() !== '' && config.email.trim() !== '' && config.token.trim() !== ''
export const jiraBase = (config: JiraConfig): string => config.baseUrl.trim().replace(/\/+$/, '')
export const jiraHeaders = (config: JiraConfig): Record<string, string> => ({
  Authorization: `Basic ${base64(`${config.email.trim()}:${config.token.trim()}`)}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
})

const jqlString = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
/** Story points live in a custom field; this is Jira Cloud's usual one ("Story point estimate"). */
const POINTS_FIELD = 'customfield_10016'

export function jiraJql(filters: IssuePilotFilters, extra: string): string {
  const clauses = [
    'statusCategory != Done',
    ...(filters.isMine ? ['assignee = currentUser()'] : []),
    ...(filters.label.trim() === '' ? [] : [`labels = ${jqlString(filters.label.trim())}`]),
    ...(filters.milestone.trim() === '' ? [] : [`fixVersion = ${jqlString(filters.milestone.trim())}`]),
    ...(extra.trim() === '' ? [] : [`(${extra.trim()})`]),
  ]
  return `${clauses.join(' AND ')} ORDER BY updated DESC`
}

export const jiraSearchUrl = (config: JiraConfig, filters: IssuePilotFilters): string =>
  `${jiraBase(config)}/rest/api/3/search/jql?jql=${encodeURIComponent(jiraJql(filters, config.jql))}&maxResults=${LIST_LIMIT}&fields=${encodeURIComponent(`summary,description,labels,status,fixVersions,${POINTS_FIELD}`)}`
export const jiraIssueUrl = (config: JiraConfig, key: string, tail = ''): string => `${jiraBase(config)}/rest/api/3/issue/${encodeURIComponent(key)}${tail}`

type AdfNode = { type?: unknown; text?: unknown; content?: unknown; attrs?: Record<string, unknown>; marks?: unknown }

/** Atlassian Document Format → Markdown-ish text: paragraphs, headings, lists, task lists, code, links. */
export function adfToText(node: unknown, depth = 0): string {
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object') return ''
  const current = node as AdfNode
  const children = Array.isArray(current.content) ? (current.content as unknown[]) : []
  const inline = () => children.map(child => adfToText(child, depth)).join('')
  const indent = '  '.repeat(depth)
  switch (current.type) {
    case 'text': {
      const link = Array.isArray(current.marks) ? (current.marks as AdfNode[]).find(mark => mark.type === 'link') : undefined
      const href = text(link?.attrs?.href)
      return href !== '' && href !== text(current.text) ? `${text(current.text)} (${href})` : text(current.text)
    }
    case 'hardBreak': return '\n'
    case 'inlineCard': case 'blockCard': return text(current.attrs?.url)
    case 'mention': return text(current.attrs?.text)
    case 'heading': return `${'#'.repeat(Number(current.attrs?.level ?? 2))} ${inline()}\n\n`
    case 'paragraph': return `${inline()}\n\n`
    case 'codeBlock': return `\`\`\`\n${inline()}\n\`\`\`\n\n`
    case 'bulletList': case 'orderedList': case 'taskList':
      return `${children.map((child, at) => {
        const item = child as AdfNode
        const mark = current.type === 'orderedList' ? `${at + 1}.` : current.type === 'taskList' || item.type === 'taskItem' ? `- [${item.attrs?.state === 'DONE' ? 'x' : ' '}]` : '-'
        return `${indent}${mark} ${adfToText(item, depth + 1).trim()}`
      }).join('\n')}\n\n`
    case 'listItem': case 'taskItem': return children.map(child => adfToText(child, depth)).join('').replace(/\n\n/g, '\n')
    default: return inline()
  }
}

/** Plain text → an ADF document (paragraphs; lines kept with hard breaks). */
export function textToAdf(value: string): Record<string, unknown> {
  const paragraphs = value.split(/\n{2,}/).map(block => block.trim()).filter(block => block !== '')
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map(block => ({
      type: 'paragraph',
      content: block.split('\n').flatMap((line, at) => [...(at > 0 ? [{ type: 'hardBreak' }] : []), ...(line === '' ? [] : [{ type: 'text', text: line }])]),
    })),
  }
}

type JiraIssue = { id?: unknown; key?: unknown; fields?: Record<string, unknown> }

function jiraIssue(item: JiraIssue, config: JiraConfig): RawIssue | undefined {
  const key = text(item.key)
  if (key === '') return undefined
  const fields = item.fields ?? {}
  const versions = Array.isArray(fields.fixVersions) ? (fields.fixVersions as { name?: unknown }[]) : []
  const points = fields[POINTS_FIELD]
  return {
    provider: 'jira',
    id: key,
    ref: key,
    number: key.toLowerCase(),
    title: text(fields.summary),
    body: adfToText(fields.description).replace(/\n{3,}/g, '\n\n').trim(),
    url: `${jiraBase(config)}/browse/${key}`,
    labels: Array.isArray(fields.labels) ? fields.labels.map(text).filter(label => label !== '') : [],
    milestone: text(versions[0]?.name) || null,
    state: text((fields.status as { name?: unknown } | undefined)?.name) || 'open',
    points: typeof points === 'number' ? points : null,
  }
}

/** A Jira search (`/search/jql`, or the older `/search`) answer. */
export function parseJiraSearch(body: string, config: JiraConfig): RawIssue[] {
  const parsed = JSON.parse(body) as { issues?: unknown }
  return Array.isArray(parsed.issues) ? parsed.issues.flatMap(item => jiraIssue((item ?? {}) as JiraIssue, config) ?? []) : []
}

export const parseJiraIssue = (body: string, config: JiraConfig): RawIssue | undefined => jiraIssue(JSON.parse(body) as JiraIssue, config)

export type JiraTransition = { id: string; name: string; to: string }

export function parseJiraTransitions(body: string): JiraTransition[] {
  const parsed = JSON.parse(body) as { transitions?: unknown }
  return Array.isArray(parsed.transitions)
    ? parsed.transitions.map(item => {
        const one = (item ?? {}) as { id?: unknown; name?: unknown; to?: { name?: unknown } }
        return { id: text(one.id), name: text(one.name), to: text(one.to?.name) }
      }).filter(one => one.id !== '')
    : []
}

/** The transition named `status` (by its own name or the status it leads to), case-insensitively. */
export const findTransition = (transitions: readonly JiraTransition[], status: string): JiraTransition | undefined => {
  const wanted = status.trim().toLowerCase()
  return wanted === '' ? undefined : transitions.find(one => one.to.toLowerCase() === wanted) ?? transitions.find(one => one.name.toLowerCase() === wanted)
}

/** An HTTP failure from Jira or Linear in words a person can act on. */
export function explainHttp(service: 'Jira' | 'Linear', status: number, body: string): string {
  if (status === 401) return `${service} rejected the credentials: check ${service === 'Jira' ? 'the account email and API token' : 'the API key'} in /config.`
  if (status === 403) return `${service} refused: the account may not see this project.`
  if (status === 404) return `${service} answered 404: check ${service === 'Jira' ? 'the Jira URL and issue key' : 'the issue'}.`
  let detail = ''
  try {
    const parsed = JSON.parse(body) as { errorMessages?: unknown; errors?: unknown }
    detail = Array.isArray(parsed.errorMessages) ? parsed.errorMessages.map(text).join(' ') : ''
  } catch {
    detail = firstLine(body).slice(0, 160)
  }
  return `${service} answered HTTP ${status}${detail === '' ? '' : `: ${detail}`}`
}

// ── Linear (GraphQL, personal API key) ──────────────────────────────────────────────────────────────

export const LINEAR_URL = 'https://api.linear.app/graphql'

const ISSUE_FIELDS = 'id identifier title description url estimate state { name type } labels { nodes { name } } cycle { name number } project { name }'

export const LINEAR_LIST = `query IssuePilotList($filter: IssueFilter) { issues(first: ${LIST_LIMIT}, filter: $filter, orderBy: updatedAt) { nodes { ${ISSUE_FIELDS} } } }`
export const LINEAR_VIEW = `query IssuePilotView($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`
export const LINEAR_STATES = 'query IssuePilotStates($id: String!) { issue(id: $id) { team { states { nodes { id name type position } } } } }'
export const LINEAR_MOVE = 'mutation IssuePilotMove($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }'
export const LINEAR_COMMENT = 'mutation IssuePilotComment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }'
export const LINEAR_LINK = 'mutation IssuePilotLink($issueId: String!, $url: String!, $title: String) { attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success } }'

/** The `IssueFilter` for the list: open, and the filters that are set. */
export function linearFilter(filters: IssuePilotFilters): Record<string, unknown> {
  const milestone = filters.milestone.trim()
  return {
    state: { type: { nin: ['completed', 'canceled'] } },
    ...(filters.isMine ? { assignee: { isMe: { eq: true } } } : {}),
    ...(filters.label.trim() === '' ? {} : { labels: { some: { name: { eqIgnoreCase: filters.label.trim() } } } }),
    ...(milestone === '' ? {} : { or: [{ project: { name: { eqIgnoreCase: milestone } } }, { cycle: { name: { eqIgnoreCase: milestone } } }] }),
  }
}

/** A personal API key goes as is; an OAuth token as a bearer. */
export const linearAuthorization = (key: string): string => (key.startsWith('lin_oauth_') ? `Bearer ${key}` : key)

export const linearRequest = (query: string, variables: Record<string, unknown>): string => JSON.stringify({ query, variables })

/** A GraphQL answer's data, or the reason it has none. */
export function linearData(body: string): { data: Record<string, unknown> } | { error: string } {
  const parsed = JSON.parse(body) as { data?: unknown; errors?: unknown }
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    const message = text((parsed.errors[0] as { message?: unknown } | null)?.message)
    return { error: /authenticat/i.test(message) ? 'Linear rejected the API key: check it in /config.' : `Linear: ${message || 'the query failed'}` }
  }
  return parsed.data !== null && typeof parsed.data === 'object' ? { data: parsed.data as Record<string, unknown> } : { error: 'Linear answered no data.' }
}

type LinearIssue = { id?: unknown; identifier?: unknown; title?: unknown; description?: unknown; url?: unknown; estimate?: unknown; state?: { name?: unknown }; labels?: { nodes?: unknown }; cycle?: { name?: unknown; number?: unknown } | null; project?: { name?: unknown } | null }

export function linearIssue(item: unknown): RawIssue | undefined {
  const one = (item ?? {}) as LinearIssue
  const identifier = text(one.identifier)
  if (identifier === '' || text(one.id) === '') return undefined
  const labels = Array.isArray(one.labels?.nodes) ? (one.labels?.nodes as { name?: unknown }[]).map(label => text(label.name)).filter(name => name !== '') : []
  const cycle = text(one.cycle?.name) || (typeof one.cycle?.number === 'number' ? `Cycle ${one.cycle.number}` : '')
  return {
    provider: 'linear',
    id: text(one.id),
    ref: identifier,
    number: identifier.toLowerCase(),
    title: text(one.title),
    body: text(one.description),
    url: text(one.url),
    labels,
    milestone: text(one.project?.name) || cycle || null,
    state: text(one.state?.name) || 'open',
    points: typeof one.estimate === 'number' ? one.estimate : null,
  }
}

export function linearIssues(data: Record<string, unknown>): RawIssue[] {
  const nodes = (data.issues as { nodes?: unknown } | undefined)?.nodes
  return Array.isArray(nodes) ? nodes.flatMap(node => linearIssue(node) ?? []) : []
}

export type LinearState = { id: string; name: string; type: string; position: number }

export function linearStates(data: Record<string, unknown>): LinearState[] {
  const nodes = ((data.issue as { team?: { states?: { nodes?: unknown } } } | undefined)?.team?.states?.nodes)
  return Array.isArray(nodes)
    ? nodes.map(node => {
        const one = (node ?? {}) as { id?: unknown; name?: unknown; type?: unknown; position?: unknown }
        return { id: text(one.id), name: text(one.name), type: text(one.type), position: typeof one.position === 'number' ? one.position : 0 }
      }).filter(one => one.id !== '')
    : []
}

/** The state to start in (the first "started" one), or the one named for review. */
export function pickLinearState(states: readonly LinearState[], phase: 'start' | 'review', reviewName: string): LinearState | undefined {
  if (phase === 'review') {
    const wanted = reviewName.trim().toLowerCase()
    return wanted === '' ? undefined : states.find(one => one.name.toLowerCase() === wanted)
  }
  return [...states].filter(one => one.type === 'started').sort((a, b) => a.position - b.position)[0]
}
