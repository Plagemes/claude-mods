import type { EngineInterface, Register } from 'claude-code'

/** Prompts that carry the person's own words. */
const PERSON_ORIGINS: readonly string[] = ['composer', 'bridge', 'sdk']
const MAX_TICKETS = 8
const MARKER = 'Referenced tickets:'

const JIRA_KEY = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g
const ISSUE_NUMBER = /(^|[\s(\[,;:])#(\d{1,6})\b/g
const URL_PATTERN = /https?:\/\/\S+/g
const CODE_FENCE = /```[\s\S]*?```/g
const COLOR_WORDS = /\b(colou?r|background|border|fill|stroke|hex|css|rgba?|hsla?|shadow)\b/i
const HEX_LENGTH_NUMBER = /^(\d{3}|\d{6})$/
const GITHUB_REMOTE = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i

/** Letters-and-digits acronyms that look like Jira keys (UTF-8, SHA-256) and are not. */
const ACRONYMS = new Set([
  'UTF', 'ISO', 'SHA', 'RFC', 'HTTP', 'HTTPS', 'TLS', 'SSL', 'TCP', 'UDP', 'AES', 'RSA', 'MD', 'CRC',
  'PEP', 'CVE', 'CWE', 'GPT', 'UTC', 'GMT', 'WCAG', 'ARIA', 'IEEE', 'ES', 'IPV', 'ANSI', 'ASCII', 'COVID', 'LTS',
])

type Ticket = { label: string; url: string }

/** The `#123` numbers in `prose`, skipping three- and six-digit ones on a line that talks about colours. */
const issueNumbers = (prose: string): string[] =>
  prose.split('\n').flatMap(line => {
    const isAboutColors = COLOR_WORDS.test(line)
    return [...line.matchAll(ISSUE_NUMBER)]
      .map(match => match[2] ?? '')
      .filter(number => !(isAboutColors && HEX_LENGTH_NUMBER.test(number)))
  })

const listOf = (value: unknown): string[] =>
  typeof value === 'string' ? value.split(',').map(item => item.trim().toUpperCase()).filter(Boolean) : []

const jiraBase = (value: unknown): string | undefined => {
  const base = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : ''
  return /^https?:\/\//i.test(base) ? base : undefined
}

/** `owner/name` that `#123` refers to: the configured one, else the git remote's when it is on GitHub. */
const githubRepo = async ($: EngineInterface, configured: unknown): Promise<string | undefined> => {
  if (typeof configured === 'string' && /^[^/\s]+\/[^/\s]+$/.test(configured.trim())) return configured.trim()
  try {
    const match = GITHUB_REMOTE.exec((await $.session.repo())?.remote ?? '')
    return match === null ? undefined : `${match[1]}/${match[2]}`
  } catch {
    return undefined
  }
}

export const register: Register = (on, options) => {
  const base = jiraBase(options.jiraBaseUrl)
  const projects = listOf(options.jiraProjects)

  const isTicketKey = (project: string): boolean =>
    projects.length > 0 ? projects.includes(project) : !ACRONYMS.has(project)

  on('prompt.submit', async ($, e, next) => {
    if (!PERSON_ORIGINS.includes(e.origin.kind) || e.text.startsWith('/') || e.text.includes(MARKER)) return next(e)

    const prose = e.text.replace(CODE_FENCE, ' ').replace(URL_PATTERN, ' ')
    const tickets = new Map<string, Ticket>()

    if (base !== undefined) {
      for (const [key, project] of prose.matchAll(JIRA_KEY)) {
        if (project !== undefined && isTicketKey(project)) {
          tickets.set(key, { label: key, url: `${base}/browse/${key}` })
        }
      }
    }

    const numbers = issueNumbers(prose)
    if (numbers.length > 0) {
      const repo = await githubRepo($, options.githubRepo)
      if (repo !== undefined) {
        for (const number of numbers) {
          tickets.set(`#${number}`, { label: `#${number}`, url: `https://github.com/${repo}/issues/${number}` })
        }
      }
    }

    if (tickets.size === 0) return next(e)

    const links = [...tickets.values()].slice(0, MAX_TICKETS).map(ticket => `${ticket.label} (${ticket.url})`)
    return next({ ...e, text: `${e.text}\n\n${MARKER} ${links.join(', ')}` })
  })
}
