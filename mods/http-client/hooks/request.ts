// Pure parts of /http: reading the command line, URL and header safety, curl, body formatting and
// redaction. No `$` here.

import type { HttpClientHistoryEntry, HttpClientRequest } from '../types'

export type Request = HttpClientRequest

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const
const HEADER_FLAGS = new Set(['-H', '--header'])
const DATA_FLAGS = new Set(['-d', '--data', '--data-raw', '--json'])
const CREDENTIAL_HEADERS = /^(?:authorization|proxy-authorization)$/i
const SECRET_HEADER = /^(?:authorization|proxy-authorization|cookie|set-cookie)$|api[-_]?key|token|secret|password|session/i
const SECRET_PARAM = /token|key|secret|password|passwd|signature|sig$|auth/i
const LOCAL_HOST = /^(?:localhost|[\w.-]+\.localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|::1)$/i
export const MASK = '<redacted>'

type Token = { text: string; raw: string }

/** Splits a command line into words the way a shell would quote them, keeping each word's raw spelling. */
export const tokenize = (line: string): Token[] => {
  const tokens: Token[] = []
  let i = 0
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i] as string)) i += 1
    if (i >= line.length) break
    const start = i
    let text = ''
    while (i < line.length && !/\s/.test(line[i] as string)) {
      const char = line[i] as string
      if (char === "'" || char === '"') {
        const end = line.indexOf(char, i + 1)
        const stop = end === -1 ? line.length : end
        let inner = line.slice(i + 1, stop)
        if (char === '"') inner = inner.replace(/\\(["\\$`])/g, '$1')
        text += inner
        i = stop + 1
      } else if (char === '\\' && i + 1 < line.length) {
        text += line[i + 1]
        i += 2
      } else {
        text += char
        i += 1
      }
    }
    tokens.push({ text, raw: line.slice(start, Math.min(i, line.length)) })
  }
  return tokens
}

export type UrlParts = { scheme: 'http' | 'https'; host: string; hasCredentials: boolean }

/** The scheme and host of an http(s) URL; undefined for anything else. */
export const urlParts = (url: string): UrlParts | undefined => {
  const match = /^(https?):\/\/([^/?#\s]+)/i.exec(url)
  if (match === null) return undefined
  const authority = match[2] as string
  const at = authority.lastIndexOf('@')
  const hostPort = authority.slice(at + 1)
  const host = hostPort.startsWith('[') ? hostPort.slice(0, hostPort.indexOf(']') + 1) : hostPort.replace(/:\d*$/, '')
  if (host === '') return undefined
  return { scheme: (match[1] as string).toLowerCase() as 'http' | 'https', host: host.toLowerCase(), hasCredentials: at !== -1 }
}

export const isLocalHost = (host: string): boolean => LOCAL_HOST.test(host)

/** Adds a scheme where none was typed: http for local hosts and bare ports (`:3000/x`), https otherwise. */
export const normalizeUrl = (input: string): string => {
  if (/^[a-z][\w+.-]*:\/\//i.test(input)) return input
  if (/^:\d+/.test(input)) return `http://localhost${input}`
  const host = /^(\[[^\]]+\]|[^/?#:]+)/.exec(input)?.[1] ?? ''
  return `${isLocalHost(host) ? 'http' : 'https'}://${input}`
}

/** A word as the person meant it: a fully quoted word loses its quotes, anything else (bare JSON) is kept as typed. */
const asTyped = (token: Token): string => (/^'[\s\S]*'$|^"[\s\S]*"$/.test(token.raw) ? token.text : token.raw)

export type Parsed = { request: Request } | { error: string }

/** Reads `[METHOD] <url> [body] [-H 'K: V']… [-d body]` into a request. */
export const parseRequest = (line: string): Parsed => {
  const tokens = tokenize(line)
  const headers: Record<string, string> = {}
  const bodyParts: Token[] = []
  let method: string | undefined
  let url: string | undefined
  let data: string | undefined
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as Token
    if (HEADER_FLAGS.has(token.text)) {
      const value = tokens[(i += 1)]?.text
      const header = value === undefined ? null : /^([^:\s]+)\s*:\s*([\s\S]*)$/.exec(value)
      if (header === null) return { error: `${token.text} needs a "Name: value" header.` }
      headers[(header[1] as string).trim()] = (header[2] as string).trim()
      continue
    }
    if (DATA_FLAGS.has(token.text)) {
      const value = tokens[(i += 1)]
      if (value === undefined) return { error: `${token.text} needs a body.` }
      data = asTyped(value)
      if (token.text === '--json' && !hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json'
      continue
    }
    if (method === undefined && url === undefined && (METHODS as readonly string[]).includes(token.text.toUpperCase())) {
      method = token.text.toUpperCase()
      continue
    }
    if (url === undefined) {
      url = token.text
      continue
    }
    bodyParts.push(token)
  }
  if (url === undefined || url === '') return { error: 'no URL given.' }
  const normalized = normalizeUrl(url)
  if (urlParts(normalized) === undefined) return { error: `"${url}" is not an http(s) URL.` }
  const typed = bodyParts.length === 1 ? asTyped(bodyParts[0] as Token) : bodyParts.map(part => part.raw).join(' ')
  const body = data ?? (typed === '' ? undefined : typed)
  if (body !== undefined && !hasHeader(headers, 'content-type')) headers['Content-Type'] = isJson(body) ? 'application/json' : 'text/plain'
  return { request: { method: method ?? (body === undefined ? 'GET' : 'POST'), url: normalized, headers, ...(body === undefined ? {} : { body }) } }
}

const hasHeader = (headers: Record<string, string>, name: string): boolean => Object.keys(headers).some(key => key.toLowerCase() === name)

const isJson = (text: string): boolean => {
  try {
    JSON.parse(text)
    return /^\s*[[{]/.test(text)
  } catch {
    return false
  }
}

/** Why the request must not go out: credentials in clear text to a host that is not this machine. */
export const credentialProblem = (request: Request): string | undefined => {
  const parts = urlParts(request.url)
  if (parts === undefined || parts.scheme === 'https' || isLocalHost(parts.host)) return undefined
  const header = Object.keys(request.headers).find(name => CREDENTIAL_HEADERS.test(name))
  if (header !== undefined) return `Refused: the ${header} header would travel unencrypted to ${parts.host} over http. Use https (or a localhost URL).`
  if (parts.hasCredentials) return `Refused: the user:password in the URL would travel unencrypted to ${parts.host} over http. Use https (or a localhost URL).`
  return undefined
}

const shellQuote = (text: string): string => (/^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`)

/** The request as a curl command line a shell runs as is. */
export const toCurl = (request: Request): string =>
  [
    'curl',
    ...(request.method === 'GET' ? [] : request.method === 'HEAD' ? ['-I'] : ['-X', request.method]),
    shellQuote(request.url),
    ...Object.entries(request.headers).flatMap(([name, value]) => ['-H', shellQuote(`${name}: ${value}`)]),
    ...(request.body === undefined ? [] : ['--data-raw', shellQuote(request.body)]),
  ].join(' ')

/** The request as a `/http` line, e.g. to put back in the prompt for editing. */
export const toCommandLine = (request: Request): string =>
  [
    '/http',
    request.method,
    shellQuote(request.url),
    ...Object.entries(request.headers)
      .filter(([name, value]) => !(name.toLowerCase() === 'content-type' && request.body !== undefined && value === (isJson(request.body) ? 'application/json' : 'text/plain')))
      .flatMap(([name, value]) => ['-H', shellQuote(`${name}: ${value}`)]),
    ...(request.body === undefined ? [] : ['-d', shellQuote(request.body)]),
  ].join(' ')

export const isSecretHeader = (name: string): boolean => SECRET_HEADER.test(name)

/** Masks secret header values and secret-looking query parameters; says whether anything was masked. */
export const redactRequest = (request: Request): { request: Request; isRedacted: boolean } => {
  let isRedacted = false
  const headers = Object.fromEntries(
    Object.entries(request.headers).map(([name, value]) => {
      if (!isSecretHeader(name)) return [name, value]
      isRedacted = true
      return [name, MASK]
    }),
  )
  const withoutPassword = request.url.replace(/^(https?:\/\/[^/@:?#]+):[^/@?#]+@/i, (whole, user: string) => {
    isRedacted = true
    return `${user}:${MASK}@`
  })
  const url = withoutPassword.replace(/([?&])([^=&#]+)=([^&#]*)/g, (whole, lead: string, name: string, value: string) => {
    if (!SECRET_PARAM.test(name) || value === '') return whole
    isRedacted = true
    return `${lead}${name}=${MASK}`
  })
  return { request: { ...request, url, headers }, isRedacted }
}

export const redactHeaders = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, isSecretHeader(name) ? MASK : value]))

export type Body =
  | { kind: 'empty' }
  | { kind: 'binary' }
  | { kind: 'json' | 'code'; text: string; language?: string }
  | { kind: 'markdown'; text: string }

const LANGUAGES: [RegExp, string][] = [
  [/html/, 'html'],
  [/xml|svg/, 'xml'],
  [/javascript|ecmascript/, 'javascript'],
  [/css/, 'css'],
  [/yaml/, 'yaml'],
  [/graphql/, 'graphql'],
  [/csv/, 'csv'],
]

/** How the pane draws a body: pretty JSON, Markdown, highlighted code, or a note for none/binary. */
export const formatBody = (text: string, contentType = ''): Body => {
  if (text === '') return { kind: 'empty' }
  const controls = (text.slice(0, 2000).match(/[\u0000-\u0008\u000e-\u001f\ufffd]/g) ?? []).length
  if (controls > 10) return { kind: 'binary' }
  const type = contentType.toLowerCase()
  if (/json/.test(type) || /^\s*[[{]/.test(text)) {
    try {
      return { kind: 'json', text: JSON.stringify(JSON.parse(text), null, 2), language: 'json' }
    } catch {
      // Not JSON after all: drawn as text below.
    }
  }
  if (/markdown/.test(type)) return { kind: 'markdown', text }
  const language = LANGUAGES.find(([pattern]) => pattern.test(type))?.[1]
  return { kind: 'code', text, ...(language === undefined ? {} : { language }) }
}

/** UTF-8 length of a text, without TextEncoder. */
export const utf8Bytes = (text: string): number => {
  let bytes = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4
      i += 1
    } else bytes += 3
  }
  return bytes
}

export const formatBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} kB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

const REASONS: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
  307: 'Temporary Redirect', 308: 'Permanent Redirect', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 409: 'Conflict', 410: 'Gone', 413: 'Payload Too Large', 415: 'Unsupported Media Type',
  422: 'Unprocessable Entity', 429: 'Too Many Requests', 500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway',
  503: 'Service Unavailable', 504: 'Gateway Timeout',
}

export const statusLine = (status: number): string => `${status}${REASONS[status] === undefined ? '' : ` ${REASONS[status]}`}`

/** Keeps the newest `max` entries, newest first; anything that is not an entry is dropped. */
export const asHistory = (value: unknown, max: number): HttpClientHistoryEntry[] =>
  (Array.isArray(value) ? value : [])
    .filter((entry): entry is HttpClientHistoryEntry => {
      const request = (entry as HttpClientHistoryEntry | null)?.request
      return typeof request?.url === 'string' && typeof request.method === 'string' && typeof (entry as HttpClientHistoryEntry).at === 'number'
    })
    .slice(0, max)
