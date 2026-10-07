/** One shell word: its text with quotes resolved, and whether it held an unexpanded `$VAR` or `$(...)`. */
export type Word = { text: string; isExpanded: boolean }

export type Header = { name: string; value: string }

export type FormPart = { name: string; value: string; isFile: boolean; filename?: string; type?: string }

export type Body =
  | { kind: 'text'; text: string }
  | { kind: 'file'; path: string }
  | { kind: 'form'; parts: FormPart[] }

/** What a curl command line asks for, in a shape every code generator can read. */
export type CurlRequest = {
  method: string
  url: string
  headers: Header[]
  body?: Body
  auth?: { user: string; password: string }
  isInsecure: boolean
  timeoutSeconds?: number
  /** Things in the command that the generated code does not carry over. */
  notes: string[]
}

export type ParseResult = { ok: true; request: CurlRequest } | { ok: false; error: string }

const EXPANSION = /\$[A-Za-z_{(]/
const ANSI_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n', t: '\t', r: '\r', a: '\u0007', b: '\b', e: '\u001b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"',
}

/** Reads one `\x..`, `\u....` or single-letter escape of a `$'...'` string; returns the text and how many characters it used. */
const ansiEscape = (input: string, at: number): { text: string; length: number } => {
  const letter = input[at + 1] ?? ''
  const hex = /^(?:x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4}))/.exec(input.slice(at + 1))
  if (hex !== null) {
    return { text: String.fromCharCode(Number.parseInt(hex[1] ?? hex[2] ?? '0', 16)), length: 1 + hex[0].length }
  }
  const known = ANSI_ESCAPES[letter]
  return known === undefined ? { text: `\\${letter}`, length: 2 } : { text: known, length: 2 }
}

/**
 * Splits a command line into words the way a POSIX shell would: single, double and `$'...'` quotes,
 * backslashes and line continuations. Stops at the first unquoted `|`, `;`, `&&`, `<` or `>`.
 */
export const tokenize = (input: string): { words: Word[]; error?: string } => {
  const words: Word[] = []
  let text = ''
  let isOpen = false
  let isExpanded = false
  const flush = (): void => {
    if (isOpen) words.push({ text, isExpanded })
    text = ''
    isOpen = false
    isExpanded = false
  }

  let i = 0
  while (i < input.length) {
    const char = input[i] as string
    const next = input[i + 1]

    if (char === '\\') {
      if (next === '\n' || (next === '\r' && input[i + 2] === '\n')) {
        i += next === '\n' ? 2 : 3
      } else {
        text += next ?? ''
        isOpen = isOpen || next !== undefined
        i += 2
      }
    } else if (char === "'") {
      const end = input.indexOf("'", i + 1)
      if (end === -1) return { words, error: "a ' quote is never closed" }
      text += input.slice(i + 1, end)
      isOpen = true
      i = end + 1
    } else if (char === '$' && next === "'") {
      i += 2
      while (i < input.length && input[i] !== "'") {
        if (input[i] === '\\') {
          const escape = ansiEscape(input, i)
          text += escape.text
          i += escape.length
        } else {
          text += input[i]
          i += 1
        }
      }
      if (i >= input.length) return { words, error: "a $' quote is never closed" }
      isOpen = true
      i += 1
    } else if (char === '"') {
      i += 1
      while (i < input.length && input[i] !== '"') {
        const inner = input[i] as string
        const after = input[i + 1]
        if (inner === '\\' && after !== undefined && '"\\$`'.includes(after)) {
          text += after
          i += 2
        } else if (inner === '\\' && after === '\n') {
          i += 2
        } else {
          isExpanded = isExpanded || EXPANSION.test(input.slice(i, i + 2))
          text += inner
          i += 1
        }
      }
      if (i >= input.length) return { words, error: 'a " quote is never closed' }
      isOpen = true
      i += 1
    } else if (/\s/.test(char)) {
      flush()
      i += 1
    } else if (char === '|' || char === ';' || char === '<' || char === '>' || (char === '&' && next === '&')) {
      // `2>&1` leaves a lone file descriptor behind: it is not an argument.
      if (/^\d$/.test(text)) {
        text = ''
        isOpen = false
      }
      break
    } else {
      isExpanded = isExpanded || EXPANSION.test(input.slice(i, i + 2))
      text += char
      isOpen = true
      i += 1
    }
  }
  flush()
  return { words }
}

/** Short option letter -> long name, for the options this parser knows about. */
const SHORT: Readonly<Record<string, string>> = {
  X: 'request', H: 'header', d: 'data', u: 'user', F: 'form', A: 'user-agent', e: 'referer', b: 'cookie',
  m: 'max-time', T: 'upload-file', I: 'head', G: 'get', k: 'insecure', L: 'location', s: 'silent', S: 'show-error',
  v: 'verbose', i: 'include', f: 'fail', N: 'no-buffer', g: 'globoff', o: 'output', O: 'remote-name', x: 'proxy',
  U: 'proxy-user', w: 'write-out', c: 'cookie-jar', D: 'dump-header', E: 'cert', r: 'range', K: 'config',
  z: 'time-cond', Y: 'speed-limit', y: 'speed-time', C: 'continue-at', Q: 'quote', '4': 'ipv4', '6': 'ipv6',
}

/** Options that take a value: the ones that shape the request come first, the rest are skipped with a note. */
const VALUED = new Set([
  'request', 'header', 'data', 'data-ascii', 'data-raw', 'data-binary', 'data-urlencode', 'json', 'user', 'form',
  'form-string', 'url', 'user-agent', 'referer', 'cookie', 'max-time', 'upload-file', 'oauth2-bearer',
  'output', 'proxy', 'proxy-user', 'connect-timeout', 'retry', 'retry-delay', 'retry-max-time', 'write-out', 'cacert',
  'capath', 'cert', 'key', 'cert-type', 'key-type', 'pass', 'cookie-jar', 'dump-header', 'resolve', 'connect-to',
  'interface', 'limit-rate', 'range', 'speed-limit', 'speed-time', 'max-redirs', 'proto', 'proto-redir', 'noproxy',
  'config', 'time-cond', 'trace', 'trace-ascii', 'expect100-timeout', 'keepalive-time', 'dns-servers', 'local-port',
  'max-filesize', 'request-target', 'unix-socket', 'aws-sigv4', 'ciphers', 'tls-max', 'tls13-ciphers', 'etag-save',
  'etag-compare', 'continue-at', 'quote', 'url-query', 'proxy-header', 'proxy-cacert', 'parallel-max',
])

/** Options that change nothing in the generated code, so they are dropped without a word. */
const QUIET = new Set([
  'silent', 'show-error', 'verbose', 'include', 'fail', 'fail-with-body', 'location', 'location-trusted', 'compressed',
  'progress-bar', 'no-buffer', 'globoff', 'http1.0', 'http1.1', 'http2', 'http2-prior-knowledge', 'http3', 'ipv4', 'ipv6',
  'no-keepalive', 'no-progress-meter', 'fail-early', 'disable', 'tcp-nodelay',
])

/** curl's `--data-urlencode` escaping: everything but the unreserved characters `A-Za-z0-9-._~` becomes %XX. */
export const urlEncode = (text: string): string =>
  encodeURIComponent(text).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)

const parseHeader = (raw: string): Header | 'remove' | undefined => {
  const colon = raw.indexOf(':')
  if (colon > 0) {
    const value = raw.slice(colon + 1).trim()
    return value === '' ? 'remove' : { name: raw.slice(0, colon).trim(), value }
  }
  const semicolon = raw.endsWith(';') ? raw.slice(0, -1).trim() : ''
  return semicolon === '' ? undefined : { name: semicolon, value: '' }
}

/** `name=value;type=text/plain` or `name=@file;filename=x;type=y` (a -F argument). */
export const parseFormPart = (raw: string): FormPart | undefined => {
  const equals = raw.indexOf('=')
  if (equals <= 0) return undefined
  let value = raw.slice(equals + 1)
  let filename: string | undefined
  let type: string | undefined
  for (;;) {
    const param = /;(type|filename)=("[^"]*"|[^;]*)$/.exec(value)
    if (param === null) break
    const found = (param[2] ?? '').replace(/^"|"$/g, '')
    if (param[1] === 'type') type ??= found
    else filename ??= found
    value = value.slice(0, param.index)
  }
  const isFile = value.startsWith('@')
  return { name: raw.slice(0, equals), value: isFile ? value.slice(1) : value, isFile, filename, type }
}

const joinHeaders = (headers: readonly Header[]): Header[] => {
  const merged: Header[] = []
  for (const header of headers) {
    const same = merged.find(known => known.name.toLowerCase() === header.name.toLowerCase())
    if (same === undefined) merged.push({ ...header })
    else same.value += `${header.name.toLowerCase() === 'cookie' ? '; ' : ', '}${header.value}`
  }
  return merged
}

const hasHeader = (headers: readonly Header[], name: string): boolean =>
  headers.some(header => header.name.toLowerCase() === name)

type Draft = {
  method?: string
  url?: string
  extraUrls: number
  headers: Header[]
  dataPieces: { text: string; isFile: boolean }[]
  isJson: boolean
  formParts: FormPart[]
  uploadFile?: string
  /** Header names (lower case) the command removed with `-H 'Name:'`. */
  removed: Set<string>
  auth?: { user: string; password: string }
  isHead: boolean
  isGet: boolean
  isInsecure: boolean
  timeoutSeconds?: number
  notes: string[]
}

/** Applies one option (by its long name) to the draft. */
const apply = (draft: Draft, option: string, value: string): void => {
  switch (option) {
    case 'request':
      draft.method = value.toUpperCase()
      break
    case 'header': {
      const header = parseHeader(value)
      if (header === 'remove') {
        const name = (value.split(':')[0] ?? '').trim().toLowerCase()
        draft.removed.add(name)
        draft.headers = draft.headers.filter(known => known.name.toLowerCase() !== name)
      } else if (header !== undefined) {
        draft.headers.push(header)
      }
      break
    }
    case 'data':
    case 'data-ascii':
    case 'data-binary':
    case 'json':
      draft.isJson = draft.isJson || option === 'json'
      draft.dataPieces.push(value.startsWith('@') ? { text: value.slice(1), isFile: true } : { text: value, isFile: false })
      break
    case 'data-raw':
      draft.dataPieces.push({ text: value, isFile: false })
      break
    case 'data-urlencode': {
      const equals = value.indexOf('=')
      if (value.startsWith('@') || (equals === -1 && value.includes('@'))) {
        draft.notes.push(`--data-urlencode ${value}: the file's content is not URL-encoded for you`)
        draft.dataPieces.push({ text: value.slice(value.indexOf('@') + 1), isFile: true })
      } else if (equals === -1) {
        draft.dataPieces.push({ text: urlEncode(value), isFile: false })
      } else {
        const name = value.slice(0, equals)
        draft.dataPieces.push({ text: `${name === '' ? '' : `${name}=`}${urlEncode(value.slice(equals + 1))}`, isFile: false })
      }
      break
    }
    case 'user': {
      const colon = value.indexOf(':')
      draft.auth = colon === -1 ? { user: value, password: '' } : { user: value.slice(0, colon), password: value.slice(colon + 1) }
      if (colon === -1) draft.notes.push('-u without a password: curl would ask for it, the code uses an empty one')
      break
    }
    case 'form':
    case 'form-string': {
      const part = parseFormPart(value)
      if (part === undefined) draft.notes.push(`${option === 'form' ? '-F' : '--form-string'} ${value}: expected name=value`)
      else draft.formParts.push(option === 'form-string' ? { ...part, isFile: false, value: value.slice(value.indexOf('=') + 1) } : part)
      break
    }
    case 'url':
      if (draft.url === undefined) draft.url = value
      else draft.extraUrls += 1
      break
    case 'user-agent':
      draft.headers.push({ name: 'User-Agent', value })
      break
    case 'referer':
      draft.headers.push({ name: 'Referer', value })
      break
    case 'cookie':
      if (value.includes('=')) draft.headers.push({ name: 'Cookie', value })
      else draft.notes.push(`-b ${value}: cookie files are not read`)
      break
    case 'oauth2-bearer':
      draft.headers.push({ name: 'Authorization', value: `Bearer ${value}` })
      break
    case 'max-time': {
      const seconds = Number(value)
      if (Number.isFinite(seconds) && seconds > 0) draft.timeoutSeconds = seconds
      break
    }
    case 'upload-file':
      draft.uploadFile = value
      break
    case 'head':
      draft.isHead = true
      break
    case 'get':
      draft.isGet = true
      break
    case 'insecure':
      draft.isInsecure = true
      break
    default:
      if (!QUIET.has(option)) draft.notes.push(`ignored: --${option}${value === '' ? '' : ` ${value}`}`)
  }
}

const bodyOf = (draft: Draft): Body | undefined => {
  if (draft.formParts.length > 0) return { kind: 'form', parts: draft.formParts }
  if (draft.uploadFile !== undefined) return { kind: 'file', path: draft.uploadFile }
  const pieces = draft.dataPieces
  const [first] = pieces
  if (first === undefined) return undefined
  if (pieces.length === 1 && first.isFile) return { kind: 'file', path: first.text }
  if (pieces.some(piece => piece.isFile)) {
    draft.notes.push('a @file mixed with other data pieces: only the literal pieces are kept')
  }
  const texts = pieces.filter(piece => !piece.isFile).map(piece => piece.text)
  return { kind: 'text', text: texts.join(draft.isJson ? '' : '&') }
}

const normalizeUrl = (url: string): string => (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url) ? url : `http://${url}`)

/** `$NAME`, `${NAME}` and `$(...)` the shell would have expanded, each once. */
const variablesIn = (words: readonly Word[]): string[] => {
  const found = words
    .filter(word => word.isExpanded)
    .flatMap(word => [...word.text.matchAll(/\$\{?([A-Za-z_]\w*)|\$\(/g)].map(hit => (hit[1] === undefined ? '$(...)' : `$${hit[1]}`)))
  return [...new Set(found)]
}

/** Parses the words of a curl command (with or without the leading `curl`) into a request. */
export const parseWords = (allWords: readonly Word[]): ParseResult => {
  const words = [...allWords]
  while (words[0]?.text === '$') words.shift()
  if (/(?:^|\/)curl(?:\.exe)?$/i.test(words[0]?.text ?? '')) words.shift()

  const draft: Draft = {
    extraUrls: 0, headers: [], dataPieces: [], isJson: false, formParts: [], removed: new Set(), isHead: false, isGet: false,
    isInsecure: false, notes: [],
  }
  const operands: string[] = []

  for (let i = 0; i < words.length; i += 1) {
    const arg = (words[i] as Word).text
    const take = (): string => (words[++i] as Word | undefined)?.text ?? ''
    if (arg === '--') {
      operands.push(...words.slice(i + 1).map(word => word.text))
      break
    }
    if (arg.startsWith('--') && arg.length > 2) {
      const option = arg.slice(2)
      apply(draft, option, VALUED.has(option) ? take() : '')
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (let at = 1; at < arg.length; at += 1) {
        const letter = arg[at] as string
        const option = SHORT[letter]
        if (option === undefined) {
          draft.notes.push(`ignored: -${letter}`)
        } else if (VALUED.has(option)) {
          const rest = arg.slice(at + 1)
          apply(draft, option, rest === '' ? take() : rest)
          break
        } else {
          apply(draft, option, '')
        }
      }
    } else {
      operands.push(arg)
    }
  }

  const [firstOperand, ...otherOperands] = operands
  const url = draft.url ?? firstOperand
  if (url === undefined || url === '') return { ok: false, error: 'no URL found in the curl command' }
  draft.extraUrls += draft.url === undefined ? otherOperands.length : operands.length
  if (draft.extraUrls > 0) draft.notes.push(`${draft.extraUrls} more URL${draft.extraUrls === 1 ? '' : 's'} ignored: one request is generated`)

  let body = bodyOf(draft)
  let finalUrl = normalizeUrl(url)
  if (draft.isGet && body?.kind === 'text') {
    finalUrl += `${finalUrl.includes('?') ? '&' : '?'}${body.text}`
    body = undefined
  }

  const headers = joinHeaders(draft.headers)
  const addDefault = (name: string, value: string): void => {
    if (!hasHeader(headers, name.toLowerCase()) && !draft.removed.has(name.toLowerCase())) headers.push({ name, value })
  }
  if (draft.isJson) {
    addDefault('Content-Type', 'application/json')
    addDefault('Accept', 'application/json')
  } else if (body?.kind === 'text' || (body?.kind === 'file' && draft.uploadFile === undefined)) {
    addDefault('Content-Type', 'application/x-www-form-urlencoded')
  }

  const method = draft.method ?? (draft.isHead ? 'HEAD' : draft.uploadFile !== undefined ? 'PUT' : body !== undefined ? 'POST' : 'GET')
  const variables = variablesIn(words)
  if (variables.length > 0) {
    draft.notes.push(`shell variables stay literal text (${variables.join(', ')}): read them from your environment`)
  }

  return {
    ok: true,
    request: {
      method,
      url: finalUrl,
      headers: body?.kind === 'form' ? headers.filter(header => header.name.toLowerCase() !== 'content-type') : headers,
      body,
      auth: draft.auth,
      isInsecure: draft.isInsecure,
      timeoutSeconds: draft.timeoutSeconds,
      notes: draft.notes,
    },
  }
}

/** Parses a curl command line, as typed or pasted, into a request. */
export const parseCurl = (input: string): ParseResult => {
  const { words, error } = tokenize(input)
  return error === undefined ? parseWords(words) : { ok: false, error }
}
