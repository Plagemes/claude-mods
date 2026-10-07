import { simpleCommands } from './shared/shell'

const URL_START = /^([a-z][a-z0-9+.-]*):\/\/([^/?#\\]*)/i
const HOSTNAME = /^[a-z0-9._-]+$/
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/
const FETCH_PROGRAMS = new Set(['curl', 'wget', 'http', 'https', 'httpie'])
/**
 * The host a URL points at, lower-cased: undefined when it cannot be told with certainty (userinfo tricks are
 * seen through, but escapes, backslashes, odd characters and expansions give no host). A URL with no scheme
 * is read as https, as WebFetch would.
 */
export const hostOf = (url: string): string | undefined => {
  const text = url.trim().replace(/[\t\n\r]/g, '')
  const authority = (URL_START.exec(text) ?? URL_START.exec(`https://${text}`))?.[2]
  if (authority === undefined || /[\s%\\]/.test(authority)) return undefined
  const afterUser = authority.slice(authority.lastIndexOf('@') + 1)
  const host = (/^\[([0-9a-f:.]+)\](?::\d*)?$/i.exec(afterUser)?.[1] ?? /^([^:]+)(?::\d*)?$/.exec(afterUser)?.[1] ?? '').toLowerCase().replace(/\.$/, '')
  return host !== '' && (HOSTNAME.test(host) || host.includes(':')) ? host : undefined
}

export const isLoopback = (host: string): boolean => host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127\.\d+\.\d+\.\d+$/.test(host)

/** What a person may type for a host (a bare name, a URL, a wildcard), reduced to `example.com` or `*.example.com`; undefined when it is not one. */
export const parseEntry = (entry: string): string | undefined => {
  const text = entry.trim().toLowerCase()
  const isSubdomainsOnly = text.startsWith('*.')
  const host = hostOf(isSubdomainsOnly ? text.slice(2) : text)
  // A name with no dot would cover a whole top-level domain ("com"): only localhost is allowed that short.
  if (host === undefined || (!host.includes('.') && !host.includes(':') && host !== 'localhost')) return undefined
  return isSubdomainsOnly ? `*.${host}` : host
}

export const parseList = (list: string): string[] =>
  list.split(',').flatMap(entry => {
    const parsed = parseEntry(entry)
    return parsed === undefined ? [] : [parsed]
  })

/** `github.com` matches github.com and api.github.com, never evilgithub.com or github.com.evil.com; `*.example.com` only the subdomains. */
export const matchesAny = (host: string, entries: readonly string[]): boolean =>
  entries.some(entry => {
    if (entry.startsWith('*.')) return host.endsWith(entry.slice(1))
    return host === entry || (!IPV4.test(entry) && host.endsWith(`.${entry}`))
  })

// ── URLs in shell commands ──────────────────────────────────────────────────

/**
 * Every `scheme://` URL passed to curl, wget or httpie in a command. The shared shell reader splits the line,
 * peels wrappers (`sudo`, `env`, `time`, `timeout`, `xargs`) and reads `bash -c "..."`, `su -c`, `eval`, `$(...)`,
 * backticks and heredocs fed to a shell.
 */
export const urlsInCommand = (command: string): string[] =>
  simpleCommands(command).flatMap(({ name, argv }) => {
    if (!FETCH_PROGRAMS.has(name)) return []
    const args = argv.slice(1)
    return args.flatMap((word, index) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(word) ? [word] : word === '--url' && args[index + 1] !== undefined ? [args[index + 1] ?? ''] : []))
  })
