/**
 * Finding the project's database and proving it is local. Pure: the hooks module
 * reads the files and the environment and hands their text here.
 */

export type ServerKind = 'postgres' | 'mysql'

/** A database server reached over TCP on this machine, or over a Unix socket. */
export type ServerTarget = {
  kind: ServerKind
  /** `localhost`, `127.0.0.1` or `::1`; empty for the default Unix socket. */
  host: string
  port: number | null
  /** A Unix socket: a directory (postgres) or the socket file (mysql). */
  socket: string | null
  database: string
  user: string | null
  password: string | null
}

export type SqliteTarget = { kind: 'sqlite'; path: string }

export type DbTarget = ServerTarget | SqliteTarget

/** What the hooks module should do with a URL: a server to use, sqlite files to try in order, or why not. */
export type Resolved =
  | { ok: true; target: ServerTarget }
  | { ok: true; sqlitePaths: string[] }
  | { ok: false; reason: string }

export const ENV_VAR = 'DATABASE_URL'

/** The env files read, in order, relative to the project root; the first that defines the variable wins. */
export const ENV_FILES = ['.env.local', '.env.development.local', '.env.development', '.env', 'prisma/.env']

/** SQLite files frameworks create by default, tried when no URL is set. */
export const SQLITE_FALLBACKS = ['prisma/dev.db', 'db/development.sqlite3', 'db.sqlite3', 'database/database.sqlite', 'storage/database.sqlite']

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
const SCHEMES: Record<string, ServerKind | 'sqlite'> = {
  postgres: 'postgres',
  postgresql: 'postgres',
  mysql: 'mysql',
  mariadb: 'mysql',
  sqlite: 'sqlite',
  sqlite3: 'sqlite',
  file: 'sqlite',
}

export const isLocalHost = (host: string): boolean => LOCAL_HOSTS.has(host.toLowerCase())

/** Parses dotenv text: `KEY=value`, `export KEY=value`, quotes, `#` comments, and `${KEY}` from the same file. */
export const parseEnv = (text: string): Map<string, string> => {
  const values = new Map<string, string>()
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(raw)
    if (match === null) continue
    const [, key = '', rest = ''] = match
    let value = rest.trim()
    const quote = value[0]
    if ((quote === '"' || quote === "'" || quote === '`') && value.indexOf(quote, 1) > 0) {
      value = value.slice(1, value.indexOf(quote, 1))
      if (quote === '"') value = value.replace(/\\n/g, '\n')
    } else {
      value = value.replace(/\s+#.*$/, '')
    }
    if (quote !== "'") value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => values.get(name) ?? whole)
    values.set(key, value)
  }
  return values
}

const decode = (text: string): string => {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

const parsePort = (text: string): number | null | undefined => {
  if (text === '') return null
  const port = Number(text)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined
}

/** Where a SQLite URL may point, most likely first; relative paths are joined to `base`. */
const sqliteCandidates = (rest: string, base: string): string[] => {
  const path = decode(rest.replace(/[?#].*$/, ''))
  if (path === '' || path === ':memory:') return []
  const join = (relative: string) => `${base.replace(/[\\/]+$/, '')}/${relative.replace(/^\.\//, '')}`
  if (path.startsWith('////')) return [path.slice(3)]
  // `sqlite:///x` is relative for SQLAlchemy and absolute for others: try both.
  if (path.startsWith('///')) return [join(path.slice(3)), path.slice(2)]
  if (path.startsWith('//')) return [join(path.slice(2))]
  if (path.startsWith('/')) return [path]
  return [join(path)]
}

/**
 * Reads a connection URL and keeps it only when it names this machine: a
 * loopback host, a Unix socket or a SQLite file. Anything else is refused.
 * `base` is the folder a relative SQLite path is relative to.
 */
export const resolveUrl = (url: string, base: string): Resolved => {
  const trimmed = url.trim()
  const scheme = /^([a-z][a-z0-9]*)(?:\+[a-z0-9]+)?:/i.exec(trimmed)
  const kind = scheme === null ? undefined : SCHEMES[(scheme[1] ?? '').toLowerCase()]
  if (scheme === null || kind === undefined) return { ok: false, reason: 'it is not a postgres, mysql or sqlite URL' }
  const rest = trimmed.slice(scheme[0].length)
  if (kind === 'sqlite') {
    const sqlitePaths = sqliteCandidates(rest, base)
    return sqlitePaths.length === 0 ? { ok: false, reason: 'it names no SQLite file' } : { ok: true, sqlitePaths }
  }
  if (!rest.startsWith('//')) return { ok: false, reason: 'the URL has no //host part' }
  if (/\$\{/.test(trimmed)) return { ok: false, reason: 'it uses a ${VARIABLE} that could not be expanded' }

  const authorityEnd = rest.slice(2).search(/[/?#]/)
  const authority = authorityEnd === -1 ? rest.slice(2) : rest.slice(2, authorityEnd + 2)
  const tail = authorityEnd === -1 ? '' : rest.slice(authorityEnd + 2)
  const at = authority.lastIndexOf('@')
  const credentials = at === -1 ? '' : authority.slice(0, at)
  const hostPort = at === -1 ? authority : authority.slice(at + 1)
  if (hostPort.includes(',')) return { ok: false, reason: 'it lists several hosts' }

  const hostMatch = /^(\[[^\]]*\]|[^:]*)(?::(.*))?$/.exec(hostPort)
  let host = decode(hostMatch?.[1] ?? '').toLowerCase()
  let port = parsePort(hostMatch?.[2] ?? '')
  if (port === undefined) return { ok: false, reason: 'its port is not a number' }

  const query = new URLSearchParams(tail.includes('?') ? tail.slice(tail.indexOf('?') + 1).replace(/#.*$/, '') : '')
  const path = decode(tail.replace(/[?#].*$/, '').replace(/^\//, ''))
  let socket: string | null = null
  if (host.startsWith('/')) {
    socket = host
    host = ''
  }
  for (const key of ['service', 'hostaddr']) {
    const value = query.get(key)
    if (value !== null && value !== '' && !(key === 'hostaddr' && isLocalHost(value))) return { ok: false, reason: `it sets ${key}=${value}` }
  }
  const hostParam = query.get('host')
  if (hostParam !== null && hostParam !== '') {
    if (hostParam.startsWith('/')) socket = hostParam
    else if (isLocalHost(hostParam)) host = hostParam
    else return { ok: false, reason: `its host is ${hostParam}` }
  }
  const socketParam = query.get('socket') ?? query.get('unix_socket')
  if (socketParam !== null && socketParam !== '') socket = socketParam
  const portParam = query.get('port')
  if (portParam !== null && portParam !== '') {
    port = parsePort(portParam)
    if (port === undefined) return { ok: false, reason: 'its port is not a number' }
  }
  if (socket !== null && !socket.startsWith('/')) return { ok: false, reason: `its socket ${socket} is not an absolute path` }
  if (socket === null && host !== '' && !isLocalHost(host)) return { ok: false, reason: `its host is ${host}, not this machine` }
  if (path === '' || path.includes('/')) return { ok: false, reason: 'it names no database' }

  const colon = credentials.indexOf(':')
  const user = credentials === '' ? null : decode(colon === -1 ? credentials : credentials.slice(0, colon))
  const password = colon === -1 ? null : decode(credentials.slice(colon + 1))
  return { ok: true, target: { kind, host, port, socket, database: path, user: user === '' ? null : user, password } }
}

/**
 * Why the client's environment could send a postgres connection elsewhere
 * (libpq reads PGHOSTADDR, PGSERVICE and, with no host given, PGHOST), or undefined.
 */
export const environmentRisk = (target: ServerTarget, env: Readonly<Record<string, string | undefined>>): string | undefined => {
  if (target.kind !== 'postgres') return undefined
  const hostaddr = env.PGHOSTADDR ?? ''
  if (hostaddr !== '' && !isLocalHost(hostaddr)) return `PGHOSTADDR=${hostaddr} is set in the environment`
  if ((env.PGSERVICE ?? '') !== '') return `PGSERVICE=${env.PGSERVICE} is set in the environment`
  const pgHost = env.PGHOST ?? ''
  if (target.host === '' && target.socket === null && pgHost !== '' && !pgHost.startsWith('/') && !isLocalHost(pgHost)) {
    return `PGHOST=${pgHost} is set in the environment`
  }
  return undefined
}

/** One line naming the database for people, never its password. */
export const describeTarget = (target: DbTarget): string => {
  if (target.kind === 'sqlite') return `sqlite · ${target.path}`
  const where = target.socket ?? (target.host === '' ? 'local socket' : `${target.host}${target.port === null ? '' : `:${target.port}`}`)
  return `${target.kind} · ${target.database} @ ${where}`
}

/** Single-quotes a libpq keyword value. */
const conninfoValue = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

/** The libpq connection string for a target, its password left to PGPASSWORD. */
export const conninfo = (target: ServerTarget): string => {
  const parts: [string, string | null][] = [
    ['host', target.socket ?? (target.host === '' ? null : target.host.replace(/^\[|\]$/g, ''))],
    ['port', target.port === null ? null : String(target.port)],
    ['dbname', target.database],
    ['user', target.user],
    ['application_name', 'claude-mods'],
    ['connect_timeout', '5'],
  ]
  return parts
    .filter((part): part is [string, string] => part[1] !== null)
    .map(([key, value]) => `${key}=${conninfoValue(value)}`)
    .join(' ')
}

/** The variables a client needs beside its argv: the password, never on the command line. */
export const passwordEnv = (target: ServerTarget): Record<string, string> =>
  target.password === null ? {} : target.kind === 'postgres' ? { PGPASSWORD: target.password } : { MYSQL_PWD: target.password }

/** Connection options for mysql and mysqldump: option files ignored, so nothing can point them elsewhere. */
export const mysqlConnection = (target: ServerTarget): string[] => [
  '--no-defaults',
  ...(target.socket !== null
    ? [`--socket=${target.socket}`]
    : [`--host=${target.host === '' ? 'localhost' : target.host.replace(/^\[|\]$/g, '')}`]),
  ...(target.port === null ? [] : [`--port=${target.port}`]),
  ...(target.user === null ? [] : [`--user=${target.user}`]),
]
