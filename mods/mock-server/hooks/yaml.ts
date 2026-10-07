// A small YAML reader for API specs: block mappings and sequences, flow `[...]`/`{...}`, quoted and
// plain scalars (also across lines), block scalars (`|`, `>`, chomping), comments and documents
// markers. Anchors and tags are skipped (an alias reads as its text). No `$` here.

type Line = { indent: number; text: string }
type Cursor = { lines: (Line | null)[]; raw: string[]; index: number }

const stripComment = (text: string): string => {
  let quote: string | undefined
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quote !== undefined) {
      if (char === '\\' && quote === '"') i += 1
      else if (char === quote) quote = undefined
    } else if (char === '"' || char === "'") {
      if (i === 0 || /[\s:[{,-]/.test(text[i - 1] as string)) quote = char
    } else if (char === '#' && (i === 0 || /\s/.test(text[i - 1] as string))) {
      return text.slice(0, i).trimEnd()
    }
  }
  return text.trimEnd()
}

const toCursor = (source: string): Cursor => {
  const raw = source.replace(/\r\n?/g, '\n').split('\n')
  const lines = raw.map(line => {
    if (/^\s*(?:#.*)?$/.test(line) || /^(?:---|\.\.\.)\s*(?:#.*)?$/.test(line) || line.startsWith('%')) return null
    const text = stripComment(line)
    const indent = text.length - text.trimStart().length
    return { indent, text: text.trimStart() }
  })
  return { lines, raw, index: 0 }
}

const peek = (cursor: Cursor): Line | undefined => {
  while (cursor.index < cursor.lines.length && cursor.lines[cursor.index] === null) cursor.index += 1
  return cursor.lines[cursor.index] ?? undefined
}

const isSequenceItem = (text: string): boolean => text === '-' || text.startsWith('- ')

/** `key: rest` of a mapping line (the key may be quoted), or undefined when the line is no key. */
const splitKey = (text: string): { key: string; rest: string } | undefined => {
  if (/^[[{]/.test(text)) return undefined
  if (text.startsWith('"') || text.startsWith("'")) {
    const quoted = readQuoted(text)
    if (quoted === undefined) return undefined
    const after = text.slice(quoted.length).match(/^\s*:(?:\s+(.*)|$)/)
    return after === null ? undefined : { key: String(quoted.value), rest: (after[1] ?? '').trim() }
  }
  const match = /^([^#]*?)\s*:(?:\s+(.*)|$)/.exec(text)
  if (match === null || (match[1] as string) === '' || (match[1] as string).startsWith('? ')) return undefined
  return { key: match[1] as string, rest: (match[2] ?? '').trim() }
}

const readQuoted = (text: string): { value: string; length: number } | undefined => {
  const quote = text[0]
  let value = ''
  for (let i = 1; i < text.length; i += 1) {
    const char = text[i] as string
    if (quote === "'") {
      if (char === "'" && text[i + 1] === "'") {
        value += "'"
        i += 1
      } else if (char === "'") return { value, length: i + 1 }
      else value += char
      continue
    }
    if (char === '\\') {
      const next = text[i + 1] ?? ''
      const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0', b: '\b', f: '\f' }
      if (next === 'u' || next === 'x') {
        const size = next === 'u' ? 4 : 2
        value += String.fromCharCode(parseInt(text.slice(i + 2, i + 2 + size), 16))
        i += 1 + size
      } else {
        value += escapes[next] ?? next
        i += 1
      }
      continue
    }
    if (char === '"') return { value, length: i + 1 }
    value += char
  }
  return undefined
}

/** A plain scalar's value: null, booleans and numbers as YAML 1.2 core reads them, else the text. */
const plain = (text: string): unknown => {
  const value = text.trim().replace(/^&\S+\s*/, '').replace(/^!\S+\s*/, '')
  if (value === '' || value === '~' || /^null$/i.test(value)) return null
  if (/^(?:true|false)$/i.test(value)) return value.toLowerCase() === 'true'
  if (/^[-+]?\d+$/.test(value)) return Number(value)
  if (/^0x[0-9a-f]+$/i.test(value)) return parseInt(value, 16)
  if (/^[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:e[-+]?\d+)?$/i.test(value)) return Number(value)
  return value
}

/** A flow collection or scalar (`[a, {b: 1}]`), read from `text` at `at`. */
const readFlow = (text: string, at: { i: number }): unknown => {
  const skip = () => {
    while (at.i < text.length && /\s/.test(text[at.i] as string)) at.i += 1
  }
  skip()
  const char = text[at.i]
  if (char === '[') {
    at.i += 1
    const items: unknown[] = []
    for (skip(); at.i < text.length && text[at.i] !== ']'; skip()) {
      items.push(readFlow(text, at))
      skip()
      if (text[at.i] === ',') at.i += 1
    }
    at.i += 1
    return items
  }
  if (char === '{') {
    at.i += 1
    const map: Record<string, unknown> = {}
    for (skip(); at.i < text.length && text[at.i] !== '}'; skip()) {
      const key = readFlow(text, at)
      skip()
      let value: unknown = null
      if (text[at.i] === ':') {
        at.i += 1
        value = readFlow(text, at)
        skip()
      }
      map[String(key)] = value
      if (text[at.i] === ',') at.i += 1
    }
    at.i += 1
    return map
  }
  if (char === '"' || char === "'") {
    const quoted = readQuoted(text.slice(at.i))
    if (quoted !== undefined) {
      at.i += quoted.length
      return quoted.value
    }
  }
  const start = at.i
  while (at.i < text.length && !/[,\]}]/.test(text[at.i] as string) && !(text[at.i] === ':' && /\s/.test(text[at.i + 1] ?? ' '))) at.i += 1
  return plain(text.slice(start, at.i))
}

const bracketDepth = (text: string): number => {
  let depth = 0
  let quote: string | undefined
  for (const char of text) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined
    } else if (char === '"' || char === "'") quote = char
    else if (char === '[' || char === '{') depth += 1
    else if (char === ']' || char === '}') depth -= 1
  }
  return depth
}

/** Folds `>` lines: a single break is a space, an empty line a break, more-indented lines keep theirs. */
const fold = (lines: readonly string[]): string => {
  let out = ''
  for (const [i, line] of lines.entries()) {
    const previous = lines[i - 1]
    if (i === 0) out = line
    else if (line === '') out += '\n'
    else if (previous === '') out += line
    else if (/^\s/.test(line) || /^\s/.test(previous ?? '')) out += `\n${line}`
    else out += ` ${line}`
  }
  return out
}

/** A `|` or `>` block scalar whose header is `header`, its lines more indented than `parent`. */
const readBlockScalar = (cursor: Cursor, header: string, parent: number): string => {
  const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip'
  const explicit = /\d/.exec(header)?.[0]
  const collected: string[] = []
  let indent = explicit === undefined ? -1 : parent + Number(explicit)
  while (cursor.index < cursor.raw.length) {
    const line = (cursor.raw[cursor.index] as string).replace(/\r$/, '')
    if (line.trim() === '') {
      collected.push('')
      cursor.index += 1
      continue
    }
    const own = line.length - line.trimStart().length
    if (own <= parent) break
    if (indent === -1) indent = own
    if (own < indent) break
    collected.push(line.slice(indent))
    cursor.index += 1
  }
  while (collected.length > 0 && collected[collected.length - 1] === '' && chomp !== 'keep') collected.pop()
  const text = header.startsWith('>') ? fold(collected) : collected.join('\n')
  return chomp === 'strip' ? text : `${text}\n`
}

/** The value written after `key:` or `- ` on a line whose block indent is `parent`. */
const readInline = (cursor: Cursor, rest: string, parent: number): unknown => {
  const value = rest.replace(/^&\S+\s*/, '').replace(/^!\S+\s*/, '')
  if (/^[|>][-+\d]*$/.test(value)) return readBlockScalar(cursor, value, parent)
  if (value.startsWith('[') || value.startsWith('{')) {
    let text = value
    while (bracketDepth(text) > 0) {
      const next = peek(cursor)
      if (next === undefined) break
      text += ` ${next.text}`
      cursor.index += 1
    }
    return readFlow(text, { i: 0 })
  }
  if (value.startsWith('"') || value.startsWith("'")) {
    let text = value
    while (readQuoted(text) === undefined) {
      const next = peek(cursor)
      if (next === undefined) break
      text += ` ${next.text}`
      cursor.index += 1
    }
    return readQuoted(text)?.value ?? text
  }
  // A plain scalar continues on more indented lines that are not keys of their own.
  let text = value
  for (let next = peek(cursor); next !== undefined && next.indent > parent && splitKey(next.text) === undefined && !isSequenceItem(next.text); next = peek(cursor)) {
    text += ` ${next.text}`
    cursor.index += 1
  }
  return plain(text)
}

const readSequence = (cursor: Cursor, indent: number): unknown[] => {
  const items: unknown[] = []
  for (let line = peek(cursor); line !== undefined && line.indent === indent && isSequenceItem(line.text); line = peek(cursor)) {
    const rest = line.text === '-' ? '' : line.text.slice(1).trimStart()
    const offset = line.text.length - rest.length
    if (rest === '') {
      cursor.index += 1
      const next = peek(cursor)
      items.push(next !== undefined && next.indent > indent ? readNode(cursor, next.indent) : null)
    } else if (isSequenceItem(rest) || (splitKey(rest) !== undefined && !/^[|>]/.test(rest))) {
      // `- key: value` opens a mapping (or `- - x` a sequence) whose indent is where its text starts.
      cursor.lines[cursor.index] = { indent: indent + offset, text: rest }
      items.push(readNode(cursor, indent + offset))
    } else {
      cursor.index += 1
      items.push(readInline(cursor, rest, indent))
    }
  }
  return items
}

const readMapping = (cursor: Cursor, indent: number): Record<string, unknown> => {
  const map: Record<string, unknown> = {}
  for (let line = peek(cursor); line !== undefined && line.indent === indent && !isSequenceItem(line.text); line = peek(cursor)) {
    const pair = splitKey(line.text)
    if (pair === undefined) break
    cursor.index += 1
    if (pair.rest !== '') {
      map[pair.key] = readInline(cursor, pair.rest, indent)
      continue
    }
    const next = peek(cursor)
    if (next !== undefined && next.indent > indent) map[pair.key] = readNode(cursor, next.indent)
    else if (next !== undefined && next.indent === indent && isSequenceItem(next.text)) map[pair.key] = readSequence(cursor, indent)
    else map[pair.key] = null
  }
  return map
}

const readNode = (cursor: Cursor, indent: number): unknown => {
  const line = peek(cursor)
  if (line === undefined) return null
  if (isSequenceItem(line.text)) return readSequence(cursor, indent)
  if (splitKey(line.text) !== undefined) return readMapping(cursor, indent)
  cursor.index += 1
  return readInline(cursor, line.text, indent - 1)
}

/** Reads the first document of a YAML text; JSON, a subset of YAML, reads too. */
export const parseYaml = (source: string): unknown => {
  const cursor = toCursor(source)
  const first = peek(cursor)
  return first === undefined ? null : readNode(cursor, first.indent)
}
