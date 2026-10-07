/** The built-in "own machine" hosts; `allowHosts` adds docker-compose service names and the like. */
const LOCAL_HOST = /^(?:localhost|.+\.localhost|127(?:\.\d{1,3}){3}|::1|0\.0\.0\.0|host\.docker\.internal|host\.containers\.internal)$/i
const FILE_SCHEME = /^(?:sqlite3?|file):/i
/** A bare path to a database file: `./dev.db`, `/data/app.sqlite`, `~/app.sqlite3`. */
const FILE_PATH = /^(?:[./~]|.*\.(?:db|sqlite3?)$)/i
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
/** A value that is not final: `${DB_HOST}`, `$DB_HOST`, `{{ host }}`, `env("X")`, `<host>`. */
const PLACEHOLDER = /\$\{|\$[A-Za-z_(]|\{\{|^env\(|<[A-Za-z_-]+>/

export type Target = { kind: 'local' } | { kind: 'remote'; host: string } | { kind: 'unknown' }

/** `db`, `*.internal` -> patterns; matched against the whole host, case-insensitively. */
export function hostPatterns(list: string): RegExp[] {
  return list
    .split(',')
    .map(item => item.trim())
    .filter(item => item !== '')
    .map(item => new RegExp(`^${item.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`, 'i'))
}

/** Hosts a database URL names: `user:pw@a:5432,b:5432/db?host=c` gives a, b and c. Empty list = a socket or a file. */
function hostsOf(url: string): string[] | undefined {
  const withoutJdbc = url.replace(/^jdbc:/i, '')
  const scheme = SCHEME.exec(withoutJdbc)
  if (scheme === null) return undefined
  const rest = withoutJdbc.slice(scheme[0].length)
  const authority = rest.split(/[/?#]/, 1)[0] ?? ''
  const hostList = authority.slice(authority.lastIndexOf('@') + 1)
  const hosts = hostList
    .split(',')
    .map(entry => {
      const bracketed = /^\[([^\]]*)\]/.exec(entry)
      return bracketed === null ? entry.replace(/:\d*$/, '') : (bracketed[1] as string)
    })
    .filter(host => host !== '')
  const query = /[?&]host=([^&#]+)/i.exec(rest)?.[1]
  if (query !== undefined) hosts.push(...decodeURIComponent(query).split(','))
  return hosts
}

/** Whether a database URL points at the own machine: a file, a socket, localhost, or an allowed host. */
export function targetOf(url: string, allowed: readonly RegExp[]): Target {
  const value = url.trim()
  if (value === '' || PLACEHOLDER.test(value)) return { kind: 'unknown' }
  if (FILE_SCHEME.test(value)) return { kind: 'local' }
  const hosts = hostsOf(value)
  if (hosts === undefined) return FILE_PATH.test(value) ? { kind: 'local' } : { kind: 'unknown' }
  const stranger = hosts
    .map(host => host.replace(/\.$/, ''))
    .find(host => !host.startsWith('/') && !LOCAL_HOST.test(host) && !allowed.some(pattern => pattern.test(host)))
  return stranger === undefined ? { kind: 'local' } : { kind: 'remote', host: stranger }
}

/** The `NAME=value` pairs of a dotenv file (later lines win), comments and `export` removed. */
export function parseDotenv(text: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (match === null) continue
    let value = match[2] as string
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) value = value.slice(1, value.lastIndexOf(quote))
    else value = value.replace(/\s+#.*$/, '')
    values.set(match[1] as string, value)
  }
  return values
}
