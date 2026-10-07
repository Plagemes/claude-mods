// A small YAML reader and writer for recipes, pure. It covers the block style people write by hand: mappings,
// sequences (also of mappings), plain and quoted scalars, `|`/`>` block scalars, `[a, b]` lists of scalars,
// comments and a leading `---`. Anchors, tags, multi-documents and multi-line plain scalars are refused with
// the line they are on, so a recipe never loads as something its author did not write.

export class YamlError extends Error {
  readonly line: number
  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`)
    this.line = line
  }
}

type Row = { indent: number; text: string; no: number }

const KEY_LINE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#\-?:,[\]{}&*!|>%@`][^:]*?|-[^\s:][^:]*?)\s*:(?:[ \t]+(.*))?$/
const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/

/** The text before a ` #` comment, quotes respected. */
function stripComment(text: string): string {
  let quote: string | undefined
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quote !== undefined) {
      if (char === '\\' && quote === '"') i += 1
      else if (char === quote) quote = undefined
    } else if (char === '"' || char === "'") {
      if (i === 0 || /[\s[{,:]/.test(text[i - 1] ?? '')) quote = char
    } else if (char === '#' && (i === 0 || /\s/.test(text[i - 1] ?? ''))) {
      return text.slice(0, i).trimEnd()
    }
  }
  return text.trimEnd()
}

function unquoteDouble(body: string, no: number): string {
  try {
    return JSON.parse(`"${body.replace(/\t/g, '\\t')}"`) as string
  } catch {
    throw new YamlError('a "double-quoted" string has a bad escape', no)
  }
}

/** One scalar: quoted strings stay strings; plain words may be true/false/null/numbers. */
function scalar(raw: string, no: number): unknown {
  const text = raw.trim()
  if (text.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(text)) throw new YamlError('a "double-quoted" string is not closed', no)
    return unquoteDouble(text.slice(1, -1), no)
  }
  if (text.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(text)) throw new YamlError("a 'single-quoted' string is not closed", no)
    return text.slice(1, -1).replace(/''/g, "'")
  }
  if (text.startsWith('[')) return flowList(text, no)
  if (text === '{}') return {}
  if (text.startsWith('{')) throw new YamlError('{inline: mappings} are not supported; write the keys on their own lines', no)
  if (/^[&*!]/.test(text)) throw new YamlError('anchors, aliases and tags are not supported', no)
  if (text === '' || text === '~' || /^null$/i.test(text)) return null
  if (/^true$/i.test(text)) return true
  if (/^false$/i.test(text)) return false
  if (NUMBER.test(text)) return Number(text)
  return text
}

/** `[a, "b, c", 3]`: a one-line list of scalars. */
function flowList(text: string, no: number): unknown[] {
  if (!text.endsWith(']')) throw new YamlError('a [list] is not closed on its line', no)
  const body = text.slice(1, -1).trim()
  if (body === '') return []
  const items: string[] = []
  let quote: string | undefined
  let start = 0
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]
    if (quote !== undefined) {
      if (char === '\\' && quote === '"') i += 1
      else if (char === quote) quote = undefined
    } else if (char === '"' || char === "'") quote = char
    else if (char === '[' || char === '{') throw new YamlError('nested [lists] are not supported', no)
    else if (char === ',') {
      items.push(body.slice(start, i))
      start = i + 1
    }
  }
  items.push(body.slice(start))
  return items.map(item => scalar(item, no))
}

class Reader {
  private readonly lines: string[]
  private at = 0

  constructor(source: string) {
    this.lines = source.replace(/\r\n?/g, '\n').split('\n')
    if (this.lines.some(line => /^\t/.test(line))) {
      const no = this.lines.findIndex(line => /^\t/.test(line)) + 1
      throw new YamlError('indent with spaces, not tabs', no)
    }
  }

  /** The next line that holds something, comments and blank lines skipped. */
  peek(): Row | undefined {
    while (this.at < this.lines.length) {
      const raw = this.lines[this.at] ?? ''
      const text = stripComment(raw.trimStart())
      if (text === '' || (this.at === 0 && text === '---')) {
        this.at += 1
        continue
      }
      if (text === '---' || text === '...') throw new YamlError('one document per recipe file', this.at + 1)
      return { indent: raw.length - raw.trimStart().length, text, no: this.at + 1 }
    }
    return undefined
  }

  /** Replaces the current line's `- ` with spaces, so a mapping that starts on a list item reads as a block. */
  private unwrapDash(row: Row): void {
    const raw = this.lines[this.at] ?? ''
    this.lines[this.at] = `${raw.slice(0, row.indent)} ${raw.slice(row.indent + 1)}`
  }

  document(): unknown {
    const first = this.peek()
    if (first === undefined) return null
    const value = this.block(first.indent)
    const extra = this.peek()
    if (extra !== undefined) throw new YamlError('this line is indented less than the block it should belong to', extra.no)
    return value
  }

  private block(indent: number): unknown {
    const row = this.peek()
    if (row === undefined || row.indent < indent) return null
    if (row.text === '-' || row.text.startsWith('- ')) return this.sequence(row.indent)
    if (KEY_LINE.test(row.text)) return this.mapping(row.indent)
    this.at += 1
    const next = this.peek()
    if (next !== undefined && next.indent > row.indent) throw new YamlError('a text spanning several lines needs | (or quotes)', next.no)
    return scalar(row.text, row.no)
  }

  private mapping(indent: number): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (let row = this.peek(); row !== undefined && row.indent === indent; row = this.peek()) {
      if (row.text === '-' || row.text.startsWith('- ')) throw new YamlError('a list item where a key was expected', row.no)
      const found = KEY_LINE.exec(row.text)
      if (found === null) throw new YamlError(`expected "key: value", found "${row.text.slice(0, 40)}"`, row.no)
      const rawKey = found[1] ?? ''
      const key = String(rawKey.startsWith('"') || rawKey.startsWith("'") ? scalar(rawKey, row.no) : rawKey.trim())
      if (Object.prototype.hasOwnProperty.call(result, key)) throw new YamlError(`"${key}" appears twice`, row.no)
      const rest = (found[2] ?? '').trim()
      this.at += 1
      result[key] = this.valueAfter(rest, indent, row.no)
    }
    const stray = this.peek()
    if (stray !== undefined && stray.indent > indent) throw new YamlError('this line is indented more than the key above it', stray.no)
    return result
  }

  /** What follows `key:` or `- `: an inline scalar, a block scalar, or a nested block. */
  private valueAfter(rest: string, indent: number, no: number): unknown {
    if (/^[|>][+-]?\d?$/.test(rest)) return this.blockScalar(rest, indent)
    if (rest !== '') return scalar(rest, no)
    const next = this.peek()
    if (next === undefined) return null
    if (next.indent > indent) return this.block(next.indent)
    if (next.indent === indent && (next.text === '-' || next.text.startsWith('- '))) return this.sequence(indent)
    return null
  }

  private sequence(indent: number): unknown[] {
    const result: unknown[] = []
    for (let row = this.peek(); row !== undefined && row.indent === indent && (row.text === '-' || row.text.startsWith('- ')); row = this.peek()) {
      const rest = row.text.slice(1).trim()
      if (rest !== '' && !/^[|>][+-]?\d?$/.test(rest) && KEY_LINE.test(rest) && !rest.startsWith('"') && !rest.startsWith("'")) {
        this.unwrapDash(row)
        result.push(this.mapping(row.indent + 1 + (row.text.length - 1 - row.text.slice(1).trimStart().length)))
        continue
      }
      this.at += 1
      result.push(this.valueAfter(rest, indent, row.no))
    }
    return result
  }

  /** `|` keeps line breaks, `>` folds them; `-` strips the final break, `+` keeps them all. */
  private blockScalar(header: string, indent: number): string {
    const isFolded = header.startsWith('>')
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip'
    const explicit = /\d/.exec(header)?.[0]
    const body: string[] = []
    let blockIndent = explicit === undefined ? undefined : indent + Number(explicit)
    while (this.at < this.lines.length) {
      const raw = this.lines[this.at] ?? ''
      if (raw.trim() === '') {
        body.push('')
        this.at += 1
        continue
      }
      const lineIndent = raw.length - raw.trimStart().length
      if (blockIndent === undefined) {
        if (lineIndent <= indent) break
        blockIndent = lineIndent
      }
      if (lineIndent < blockIndent) break
      body.push(raw.slice(blockIndent))
      this.at += 1
    }
    if (blockIndent === undefined && body.every(line => line === '')) return ''
    let trailing = 0
    while (body.length > 0 && body[body.length - 1] === '') {
      body.pop()
      trailing += 1
    }
    let text = isFolded ? fold(body) : body.join('\n')
    if (chomp === 'clip' && body.length > 0) text += '\n'
    if (chomp === 'keep') text += '\n'.repeat(trailing + 1)
    return text
  }
}

/** Folded block lines: single breaks become spaces, blank lines stay breaks, indented lines keep theirs. */
function fold(lines: readonly string[]): string {
  let text = ''
  lines.forEach((line, index) => {
    if (index === 0) {
      text = line
      return
    }
    const previous = lines[index - 1] ?? ''
    if (line === '') text += '\n'
    else if (previous === '' || /^\s/.test(line) || /^\s/.test(previous)) text += (previous === '' ? '' : '\n') + line
    else text += ` ${line}`
  })
  return text
}

/** Reads one YAML document; throws YamlError (with its line) on what it does not support. */
export function parseYaml(source: string): unknown {
  return new Reader(source).document()
}

// ── Writing ────────────────────────────────────────────────────────────────────────────────────────

const PLAIN_UNSAFE = /^[\s\-?:,[\]{}#&*!|>'"%@`]|:\s|\s#|:$|\s$/

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  const text = String(value)
  const looksTyped = text === '' || /^(?:true|false|null|~|yes|no|on|off)$/i.test(text) || NUMBER.test(text)
  return looksTyped || PLAIN_UNSAFE.test(text) || /[\u0000-\u001f]/.test(text) ? JSON.stringify(text) : text
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** A multi-line string as a `|` block, or undefined when quotes are safer (leading spaces on its first line). */
function blockOf(text: string, pad: string): string | undefined {
  if (!text.includes('\n') || /^[ \t]/.test(text) || /\n[ \t]+(?:\n|$)/.test(text) || /[\u0000-\u0008\u000b-\u001f]/.test(text)) return undefined
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  if (body.endsWith('\n')) return undefined
  const header = text.endsWith('\n') ? '|' : '|-'
  return `${header}\n${body.split('\n').map(line => (line === '' ? '' : `${pad}${line}`)).join('\n')}`
}

function writeValue(value: unknown, indent: number): string[] {
  const pad = ' '.repeat(indent)
  if (Array.isArray(value)) {
    return value.flatMap(item => {
      if (isRecord(item) && Object.keys(item).length > 0) {
        const [first = '', ...rest] = writeValue(item, indent + 2)
        return [`${pad}- ${first.trimStart()}`, ...rest]
      }
      if (Array.isArray(item)) return [`${pad}- ${item.length === 0 ? '[]' : `[${item.map(scalarText).join(', ')}]`}`]
      if (typeof item === 'string') {
        const block = blockOf(item, `${pad}  `)
        if (block !== undefined) return [`${pad}- ${block}`]
      }
      return [`${pad}- ${isRecord(item) ? '{}' : scalarText(item)}`]
    })
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, item]) => {
      if (item === undefined) return []
      const name = scalarText(key)
      if (Array.isArray(item)) return item.length === 0 ? [`${pad}${name}: []`] : [`${pad}${name}:`, ...writeValue(item, indent + 2)]
      if (isRecord(item)) return Object.keys(item).length === 0 ? [`${pad}${name}: {}`] : [`${pad}${name}:`, ...writeValue(item, indent + 2)]
      if (typeof item === 'string') {
        const block = blockOf(item, `${pad}  `)
        if (block !== undefined) return [`${pad}${name}: ${block}`]
      }
      return [`${pad}${name}: ${scalarText(item)}`]
    })
  }
  return [`${pad}${scalarText(value)}`]
}

/** Writes plain data as block-style YAML that parseYaml reads back to the same value. */
export function stringifyYaml(value: unknown): string {
  return `${writeValue(value, 0).join('\n')}\n`
}
