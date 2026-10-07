import type { CurlRequest, FormPart, Header } from './curl'

export type Language = 'fetch' | 'axios' | 'python' | 'go'

export const LANGUAGES: readonly Language[] = ['fetch', 'axios', 'python', 'go']

/** Words people type for each language. */
export const ALIASES: Readonly<Record<string, Language>> = {
  fetch: 'fetch', js: 'fetch', javascript: 'fetch', node: 'fetch', nodejs: 'fetch', ts: 'fetch', typescript: 'fetch',
  axios: 'axios',
  python: 'python', py: 'python', requests: 'python', python3: 'python',
  go: 'go', golang: 'go',
}

/** The Markdown fence tag of each language. */
export const FENCE: Readonly<Record<Language, string>> = { fetch: 'js', axios: 'js', python: 'python', go: 'go' }

export type Emitted = { code: string; notes: string[] }

const ESCAPES: Readonly<Record<string, string>> = { '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' }

/** A string literal valid in both JavaScript and Python: single quotes unless the text has a `'` and no `"`. */
export const quote = (text: string): string => {
  const mark = text.includes("'") && !text.includes('"') ? '"' : "'"
  const body = text.replace(/[\\\u0000-\u001f\u007f'"]/g, char => {
    if (char === mark) return `\\${char}`
    if (char === "'" || char === '"') return char
    return ESCAPES[char] ?? `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`
  })
  return `${mark}${body}${mark}`
}

/** A Go string literal: raw (backticks) for text with quotes in it, an escaped one otherwise. */
const goQuote = (text: string): string =>
  text.includes('"') && !/[`\r\u0000]/.test(text) ? `\`${text}\`` : JSON.stringify(text)

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

type Dialect = { key: (name: string) => string; literals: Readonly<{ true: string; false: string; null: string }> }

const JS: Dialect = { key: name => (IDENTIFIER.test(name) ? name : quote(name)), literals: { true: 'true', false: 'false', null: 'null' } }
const PYTHON: Dialect = { key: quote, literals: { true: 'True', false: 'False', null: 'None' } }

const isScalar = (value: unknown): boolean => typeof value !== 'object' || value === null

/** Prints parsed JSON as a literal of the dialect; `indent` is the indentation of the line the literal starts on. */
const literal = (value: unknown, dialect: Dialect, indent: string, step: string): string => {
  if (value === null) return dialect.literals.null
  if (typeof value === 'boolean') return value ? dialect.literals.true : dialect.literals.false
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return quote(value)
  const inner = indent + step
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const flat = value.every(isScalar) ? `[${value.map(item => literal(item, dialect, '', step)).join(', ')}]` : ''
    if (flat !== '' && flat.length <= 60) return flat
    return `[\n${value.map(item => `${inner}${literal(item, dialect, inner, step)},`).join('\n')}\n${indent}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return '{}'
  const rows = entries.map(([key, item]) => `${inner}${dialect.key(key)}: ${literal(item, dialect, inner, step)},`)
  return `{\n${rows.join('\n')}\n${indent}}`
}

const withoutSpace = (json: string): string => json.replace(/"(?:[^"\\]|\\.)*"|\s+/g, found => (found.startsWith('"') ? found : ''))

/** The object or array a JSON text holds, only when printing it as a literal loses nothing (numbers, escapes, duplicate keys). */
export const plainJson = (text: string): object | undefined => {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && withoutSpace(text) === JSON.stringify(value) ? value : undefined
  } catch {
    return undefined
  }
}

const headerValue = (request: CurlRequest, name: string): string | undefined =>
  request.headers.find(header => header.name.toLowerCase() === name)?.value

const jsonBody = (request: CurlRequest): object | undefined => {
  const type = (headerValue(request, 'content-type') ?? '').split(';')[0]?.trim().toLowerCase()
  return request.body?.kind === 'text' && type === 'application/json' ? plainJson(request.body.text) : undefined
}

const baseName = (path: string): string => path.split(/[\\/]/).pop() || path

const hasFile = (request: CurlRequest): boolean =>
  request.body?.kind === 'file' || (request.body?.kind === 'form' && request.body.parts.some(part => part.isFile))

const millis = (seconds: number): number => Math.round(seconds * 1000)

const indented = (lines: readonly string[], by: string): string[] => lines.flatMap(line => line.split('\n')).map(line => (line === '' ? line : by + line))

const header = ({ name, value }: Header): string => `${quote(name)}: ${quote(value)}`

const formAppends = (parts: readonly FormPart[], blobOf: (part: FormPart) => string): string[] =>
  parts.map(part => {
    if (part.isFile) return `form.append(${quote(part.name)}, ${blobOf(part)}, ${quote(part.filename ?? baseName(part.value))});`
    return `form.append(${quote(part.name)}, ${quote(part.value)});`
  })

/** The `new Blob(...)` a file part is sent as, in Node. */
const blobOf = (part: FormPart): string =>
  `new Blob([await readFile(${quote(part.value)})]${part.type === undefined ? '' : `, { type: ${quote(part.type)} }`})`

/** Methods fetch refuses to send a body with: `new Request()` throws a TypeError. */
const BODILESS_IN_FETCH = new Set(['GET', 'HEAD'])

const emitFetch = (request: CurlRequest): Emitted => {
  const notes: string[] = []
  // curl -X GET -d '...' (Elasticsearch style) sends a body; fetch would throw, so the body is left out and said so.
  const body = request.body !== undefined && BODILESS_IN_FETCH.has(request.method) ? undefined : request.body
  if (body !== request.body) notes.push(`fetch cannot send a body with ${request.method}, so it was left out: use POST if the server accepts it, or axios`)
  const json = body === undefined ? undefined : jsonBody(request)
  const lines: string[] = []
  if (body !== undefined && hasFile(request)) lines.push("import { readFile } from 'node:fs/promises';", '')
  if (request.isInsecure) {
    lines.push('// curl -k: fetch cannot skip TLS verification per request; for local testing run Node with NODE_TLS_REJECT_UNAUTHORIZED=0.', '')
  }
  if (body?.kind === 'form') lines.push('const form = new FormData();', ...formAppends(body.parts, blobOf), '')

  const headers = request.headers.map(header)
  if (request.auth !== undefined) headers.push(`'Authorization': 'Basic ' + btoa(${quote(`${request.auth.user}:${request.auth.password}`)})`)
  const options: string[] = []
  if (request.method !== 'GET') options.push(`method: ${quote(request.method)},`)
  if (headers.length > 0) options.push('headers: {', ...indented(headers.map(row => `${row},`), '  '), '},')
  if (body?.kind === 'text') {
    options.push(json === undefined ? `body: ${quote(body.text)},` : `body: JSON.stringify(${literal(json, JS, '', '  ')}),`)
  } else if (body?.kind === 'file') {
    options.push(`body: await readFile(${quote(body.path)}),`)
  } else if (body?.kind === 'form') {
    options.push('body: form,')
  }
  if (request.timeoutSeconds !== undefined) options.push(`signal: AbortSignal.timeout(${millis(request.timeoutSeconds)}),`)

  if (options.length === 0) lines.push(`const response = await fetch(${quote(request.url)});`)
  else lines.push(`const response = await fetch(${quote(request.url)}, {`, ...indented(options, '  '), '});')
  lines.push('', 'console.log(response.status, await response.text());')
  return { code: lines.join('\n'), notes }
}

const emitAxios = (request: CurlRequest): Emitted => {
  const { body } = request
  const json = jsonBody(request)
  const lines = ["import axios from 'axios';"]
  if (request.isInsecure) lines.push("import https from 'node:https';")
  if (hasFile(request)) lines.push("import { readFile } from 'node:fs/promises';")
  lines.push('')
  if (body?.kind === 'form') lines.push('const form = new FormData();', ...formAppends(body.parts, blobOf), '')

  const options: string[] = []
  const headers = request.headers.map(header)
  if (headers.length > 0) options.push('headers: {', ...indented(headers.map(row => `${row},`), '  '), '},')
  if (body?.kind === 'text') options.push(`data: ${json === undefined ? quote(body.text) : literal(json, JS, '', '  ')},`)
  else if (body?.kind === 'file') options.push(`data: await readFile(${quote(body.path)}),`)
  else if (body?.kind === 'form') options.push('data: form,')
  if (request.auth !== undefined) {
    options.push(`auth: { username: ${quote(request.auth.user)}, password: ${quote(request.auth.password)} },`)
  }
  if (request.timeoutSeconds !== undefined) options.push(`timeout: ${millis(request.timeoutSeconds)},`)
  if (request.isInsecure) options.push('httpsAgent: new https.Agent({ rejectUnauthorized: false }),')

  if (request.method === 'GET' && options.length === 0) {
    lines.push(`const response = await axios.get(${quote(request.url)});`)
  } else {
    lines.push('const response = await axios({', ...indented([`method: ${quote(request.method.toLowerCase())},`, `url: ${quote(request.url)},`, ...options], '  '), '});')
  }
  lines.push('', 'console.log(response.status, response.data);')
  return { code: lines.join('\n'), notes: [] }
}

const REQUESTS_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

const pythonFileTuple = (part: FormPart): string =>
  `(${quote(part.filename ?? baseName(part.value))}, open(${quote(part.value)}, 'rb')${part.type === undefined ? '' : `, ${quote(part.type)}`})`

const pythonField = (part: FormPart): string =>
  part.isFile ? pythonFileTuple(part) : `(None, ${quote(part.value)}${part.type === undefined ? '' : `, ${quote(part.type)}`})`

const emitPython = (request: CurlRequest): Emitted => {
  const { body } = request
  const json = jsonBody(request)
  const isPlainJson = json !== undefined && headerValue(request, 'content-type')?.trim().toLowerCase() === 'application/json'
  const headers = request.headers.filter(row => !(isPlainJson && row.name.toLowerCase() === 'content-type'))

  const args: string[] = []
  if (headers.length > 0) args.push('headers={', ...indented(headers.map(row => `${header(row)},`), '    '), '},')
  if (body?.kind === 'text') args.push(isPlainJson ? `json=${literal(json, PYTHON, '', '    ')},` : `data=${quote(body.text)},`)
  else if (body?.kind === 'file') args.push(`data=open(${quote(body.path)}, 'rb'),`)
  else if (body?.kind === 'form') {
    args.push('files={', ...indented(body.parts.map(part => `${quote(part.name)}: ${pythonField(part)},`), '    '), '},')
  }
  if (request.auth !== undefined) args.push(`auth=(${quote(request.auth.user)}, ${quote(request.auth.password)}),`)
  if (request.timeoutSeconds !== undefined) args.push(`timeout=${request.timeoutSeconds},`)
  if (request.isInsecure) args.push('verify=False,')

  const isKnown = REQUESTS_METHODS.has(request.method)
  const call = isKnown ? `requests.${request.method.toLowerCase()}` : 'requests.request'
  const first = isKnown ? [quote(request.url)] : [quote(request.method), quote(request.url)]
  const lines = ['import requests', '']
  if (args.length === 0) lines.push(`response = ${call}(${first.join(', ')})`)
  else lines.push(`response = ${call}(`, ...indented([...first.map(item => `${item},`), ...args], '    '), ')')
  lines.push('', 'print(response.status_code)', 'print(response.text)')
  return { code: lines.join('\n'), notes: [] }
}

const GO_CHECK = ['if err != nil {', '\tpanic(err)', '}']

const goFormLines = (parts: readonly FormPart[]): string[] => {
  const lines = ['var payload bytes.Buffer', 'writer := multipart.NewWriter(&payload)']
  for (const part of parts) {
    if (part.isFile) {
      lines.push(
        '{',
        ...indented([`file, err := os.Open(${goQuote(part.value)})`, ...GO_CHECK, 'defer file.Close()'], '\t'),
        ...indented([`part, err := writer.CreateFormFile(${goQuote(part.name)}, ${goQuote(part.filename ?? baseName(part.value))})`, ...GO_CHECK], '\t'),
        ...indented(['if _, err := io.Copy(part, file); err != nil {', '\tpanic(err)', '}'], '\t'),
        '}',
      )
    } else {
      lines.push(`if err := writer.WriteField(${goQuote(part.name)}, ${goQuote(part.value)}); err != nil {`, '\tpanic(err)', '}')
    }
  }
  lines.push('if err := writer.Close(); err != nil {', '\tpanic(err)', '}')
  return lines
}

const goDuration = (seconds: number): string =>
  Number.isInteger(seconds) ? `${seconds} * time.Second` : `${millis(seconds)} * time.Millisecond`

const emitGo = (request: CurlRequest): Emitted => {
  const { body } = request
  const imports = new Set(['fmt', 'io', 'net/http'])
  const notes: string[] = []
  const prepare: string[] = []
  let bodyArgument = 'nil'

  if (body?.kind === 'text') {
    imports.add('strings')
    prepare.push(`payload := strings.NewReader(${goQuote(body.text)})`)
    bodyArgument = 'payload'
  } else if (body?.kind === 'file') {
    imports.add('os')
    prepare.push(`file, err := os.Open(${goQuote(body.path)})`, ...GO_CHECK, 'defer file.Close()')
    bodyArgument = 'file'
  } else if (body?.kind === 'form') {
    for (const name of ['bytes', 'mime/multipart']) imports.add(name)
    if (body.parts.some(part => part.isFile)) imports.add('os')
    if (body.parts.some(part => part.type !== undefined)) notes.push('Go: CreateFormFile sends files as application/octet-stream; ;type= was dropped')
    prepare.push(...goFormLines(body.parts))
    bodyArgument = '&payload'
  }

  const setup = [`req, err := http.NewRequest(${goQuote(request.method)}, ${goQuote(request.url)}, ${bodyArgument})`, ...GO_CHECK]
  for (const row of request.headers) {
    setup.push(row.name.toLowerCase() === 'host' ? `req.Host = ${goQuote(row.value)}` : `req.Header.Set(${goQuote(row.name)}, ${goQuote(row.value)})`)
  }
  if (body?.kind === 'form') setup.push('req.Header.Set("Content-Type", writer.FormDataContentType())')
  if (request.auth !== undefined) setup.push(`req.SetBasicAuth(${goQuote(request.auth.user)}, ${goQuote(request.auth.password)})`)

  const clientFields: string[] = []
  if (request.timeoutSeconds !== undefined) {
    imports.add('time')
    clientFields.push(`Timeout: ${goDuration(request.timeoutSeconds)},`)
  }
  if (request.isInsecure) {
    imports.add('crypto/tls')
    clientFields.push('Transport: &http.Transport{', '\tTLSClientConfig: &tls.Config{InsecureSkipVerify: true},', '},')
  }
  const client = clientFields.length === 0 ? ['client := http.DefaultClient'] : ['client := &http.Client{', ...indented(clientFields, '\t'), '}']

  const main = [
    ...prepare,
    ...setup,
    '',
    ...client,
    'resp, err := client.Do(req)',
    ...GO_CHECK,
    'defer resp.Body.Close()',
    '',
    'out, err := io.ReadAll(resp.Body)',
    ...GO_CHECK,
    'fmt.Println(resp.StatusCode, string(out))',
  ]
  const importLines = [...imports].sort().map(name => `\t"${name}"`)
  const code = ['package main', '', 'import (', ...importLines, ')', '', 'func main() {', ...indented(main, '\t'), '}']
  return { code: code.join('\n'), notes }
}

/** Code for `request` in `language`, and what it could not carry over. */
export const emit = (request: CurlRequest, language: Language): Emitted => {
  const emitted = { fetch: emitFetch, axios: emitAxios, python: emitPython, go: emitGo }[language](request)
  return { code: emitted.code, notes: [...request.notes, ...emitted.notes] }
}
