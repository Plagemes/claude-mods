export type Service = { id: string; name: string; /** The Statuspage site, no trailing slash. */ url: string }

export type Incident = { name: string; impact: string; link: string }

export type Reading =
  | { kind: 'ok'; indicator: string; description: string; incidents: Incident[] }
  | { kind: 'unreachable'; why: string }

export const BUILT_IN: readonly Service[] = [
  { id: 'github', name: 'GitHub', url: 'https://www.githubstatus.com' },
  { id: 'npm', name: 'npm', url: 'https://status.npmjs.org' },
  { id: 'pypi', name: 'PyPI', url: 'https://status.python.org' },
  { id: 'anthropic', name: 'Anthropic API', url: 'https://status.claude.com' },
]

const MAX_INCIDENTS_SHOWN = 3

export const statusUrl = (service: Service): string => `${service.url}/api/v2/status.json`
export const incidentsUrl = (service: Service): string => `${service.url}/api/v2/incidents/unresolved.json`

/** `Name=https://status.example.com, https://status.other.io` as services; entries that are not http(s) URLs are dropped. */
export const parseExtra = (list: string): Service[] =>
  list.split(',').flatMap(entry => {
    const match = /^\s*(?:([^=]+?)\s*=\s*)?(https?:\/\/[^\s/?#]+)[^\s]*\s*$/i.exec(entry)
    if (match?.[2] === undefined) return []
    const url = match[2].replace(/\/+$/, '')
    const name = match[1] ?? url.replace(/^https?:\/\//i, '').replace(/^(?:www|status)\./i, '')
    return [{ id: name.toLowerCase(), name, url }]
  })

const asRecord = (value: unknown): Record<string, unknown> | undefined => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined)

/** The indicator and description of a Statuspage `status.json`; undefined when it is not one. */
export const readStatus = (text: string): { indicator: string; description: string } | undefined => {
  try {
    const status = asRecord(asRecord(JSON.parse(text))?.status)
    return typeof status?.indicator === 'string' ? { indicator: status.indicator, description: typeof status.description === 'string' ? status.description : '' } : undefined
  } catch {
    return undefined
  }
}

/** The open incidents of a Statuspage `incidents/unresolved.json`. */
export const readIncidents = (text: string): Incident[] => {
  try {
    const incidents = asRecord(JSON.parse(text))?.incidents
    return (Array.isArray(incidents) ? incidents : []).flatMap(item => {
      const incident = asRecord(item)
      return typeof incident?.name === 'string'
        ? [{ name: incident.name, impact: typeof incident.impact === 'string' ? incident.impact : 'unknown', link: typeof incident.shortlink === 'string' ? incident.shortlink : '' }]
        : []
    })
  } catch {
    return []
  }
}

const GLYPHS: Record<string, string> = { none: '✓', minor: '⚠', major: '✖', critical: '✖', maintenance: '◌' }

export const hasIncident = (reading: Reading): boolean => reading.kind === 'ok' && reading.indicator !== 'none'

const line = (service: Service, reading: Reading, width: number): string[] => {
  const label = service.name.padEnd(width)
  if (reading.kind === 'unreachable') return [`? ${label}  could not be checked (${reading.why})`]
  const glyph = GLYPHS[reading.indicator] ?? '?'
  return [
    `${glyph} ${label}  ${reading.description === '' ? reading.indicator : reading.description}`,
    ...reading.incidents.slice(0, MAX_INCIDENTS_SHOWN).map(incident => `    ${incident.name} (${incident.impact})${incident.link === '' ? '' : ` ${incident.link}`}`),
    ...(reading.incidents.length > MAX_INCIDENTS_SHOWN ? [`    and ${reading.incidents.length - MAX_INCIDENTS_SHOWN} more at ${service.url}`] : []),
  ]
}

export const formatReport = (readings: readonly { service: Service; reading: Reading }[], now: number): string => {
  const width = Math.max(...readings.map(item => item.service.name.length))
  const problems = readings.some(item => hasIncident(item.reading))
  const unknown = readings.some(item => item.reading.kind === 'unreachable')
  return [
    `Service status at ${new Date(now).toISOString().slice(11, 19)} UTC`,
    ...readings.flatMap(item => line(item.service, item.reading, width)),
    '',
    problems
      ? 'At least one service reports an incident: a failure involving it is probably not your code.'
      : unknown
        ? 'No incident reported by the services that answered.'
        : 'No incident reported: if something fails, look at your code or your network.',
  ].join('\n')
}

// ── Network-looking failures ────────────────────────────────────────────────

const NETWORK_FAILURE = new RegExp(
  [
    'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ESOCKETTIMEDOUT', 'socket hang up', 'getaddrinfo', 'Could not resolve host', 'Connection timed out', 'Operation timed out',
    'Temporary failure in name resolution', 'network is unreachable', 'fetch failed', 'TLS handshake timeout', 'Read timed out', 'ReadTimeoutError', 'ConnectTimeoutError', 'Max retries exceeded',
    'HTTPSConnectionPool', 'npm ERR! network', 'RPC failed', 'remote end hung up', 'Service Unavailable', 'Bad Gateway', 'Gateway Time-?out', 'returned error: 50[0234]', 'HTTP[/ ]\\S* ?50[0234]\\b',
    '(?:status|code|error)[: =]+E?50[0234]\\b', '\\bE50[0234]\\b', '\\b50[0234] (?:Server Error|Internal)',
  ].join('|'),
  'i',
)

const MENTIONS: Record<string, RegExp> = {
  github: /\bgh\s|github\.com|githubusercontent\.com|ghcr\.io/i,
  npm: /(?:^|[\s;&|(])(?:npm|pnpm|yarn|npx|bun)\s|registry\.npmjs\.org|registry\.yarnpkg\.com|npmjs\.(?:org|com)/i,
  pypi: /(?:^|[\s;&|(])(?:pip3?|uv|poetry|pipenv|twine)\s|pypi\.org|pythonhosted\.org|python3? -m pip/i,
  anthropic: /api\.anthropic\.com|console\.anthropic\.com|claude\.ai|status\.claude\.com/i,
}

/** The built-in services a failed command may have hit, when its output looks like a network failure. */
export const suspectedServices = (command: string, output: string): string[] => {
  if (!NETWORK_FAILURE.test(output)) return []
  return BUILT_IN.map(service => service.id).filter(id => MENTIONS[id]?.test(`${command}\n${output}`) === true)
}
