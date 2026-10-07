/**
 * A small TOML reader, enough for lockfiles (Cargo.lock, poetry.lock,
 * uv.lock): tables, arrays of tables, dotted keys, strings, numbers,
 * booleans, dates (kept as text), arrays over several lines and inline
 * tables. It throws a SyntaxError naming the line on anything else.
 */
export type TomlValue = string | number | boolean | TomlValue[] | TomlTable
export type TomlTable = { [key: string]: TomlValue }

const BARE_KEY = /[A-Za-z0-9_-]/
const ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }

const isTable = (value: TomlValue | undefined): value is TomlTable =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function parseToml(text: string): TomlTable {
  const root: TomlTable = {}
  let current = root
  let at = 0

  const lineNumber = (): number => text.slice(0, at).split('\n').length
  const fail = (what: string): never => {
    throw new SyntaxError(`TOML line ${lineNumber()}: ${what}`)
  }
  const peek = (): string => text[at] ?? ''
  const skipSpaces = (): void => {
    while (peek() === ' ' || peek() === '\t') at += 1
  }
  /** Skips spaces, newlines and comments (inside arrays and between statements). */
  const skipBlank = (): void => {
    for (;;) {
      skipSpaces()
      if (peek() === '#') {
        while (at < text.length && peek() !== '\n') at += 1
      } else if (peek() === '\n' || peek() === '\r') {
        at += 1
      } else return
    }
  }

  const readString = (): string => {
    const quote = peek()
    const isMultiline = text.startsWith(quote.repeat(3), at)
    const fence = isMultiline ? quote.repeat(3) : quote
    at += fence.length
    if (isMultiline && peek() === '\n') at += 1
    let out = ''
    for (;;) {
      if (at >= text.length) fail('unterminated string')
      if (text.startsWith(fence, at)) {
        at += fence.length
        return out
      }
      const char = text[at] as string
      if (!isMultiline && char === '\n') fail('newline in string')
      if (quote === '"' && char === '\\') {
        const next = text[at + 1] ?? ''
        if (next === 'u' || next === 'U') {
          const size = next === 'u' ? 4 : 8
          out += String.fromCodePoint(parseInt(text.slice(at + 2, at + 2 + size), 16))
          at += 2 + size
        } else if (isMultiline && (next === '\n' || next === '\r')) {
          at += 1
          while (/\s/.test(peek())) at += 1
        } else {
          out += ESCAPES[next] ?? fail(`bad escape \\${next}`)
          at += 2
        }
        continue
      }
      out += char
      at += 1
    }
  }

  const readKeyPart = (): string => {
    skipSpaces()
    if (peek() === '"' || peek() === "'") return readString()
    const start = at
    while (BARE_KEY.test(peek())) at += 1
    if (start === at) fail(`expected a key, found "${peek()}"`)
    return text.slice(start, at)
  }

  const readKey = (): string[] => {
    const parts = [readKeyPart()]
    skipSpaces()
    while (peek() === '.') {
      at += 1
      parts.push(readKeyPart())
      skipSpaces()
    }
    return parts
  }

  const readValue = (): TomlValue => {
    skipSpaces()
    const char = peek()
    if (char === '"' || char === "'") return readString()
    if (char === '[') {
      at += 1
      const items: TomlValue[] = []
      for (;;) {
        skipBlank()
        if (peek() === ']') {
          at += 1
          return items
        }
        items.push(readValue())
        skipBlank()
        if (peek() === ',') at += 1
        else if (peek() !== ']') fail('expected , or ] in an array')
      }
    }
    if (char === '{') {
      at += 1
      const table: TomlTable = {}
      skipSpaces()
      if (peek() === '}') {
        at += 1
        return table
      }
      for (;;) {
        const key = readKey()
        skipSpaces()
        if (peek() !== '=') fail('expected = in an inline table')
        at += 1
        assign(table, key, readValue())
        skipSpaces()
        if (peek() === ',') at += 1
        else if (peek() === '}') {
          at += 1
          return table
        } else fail('expected , or } in an inline table')
      }
    }
    const start = at
    while (at < text.length && !/[,\]}\n\r#]/.test(peek())) at += 1
    const raw = text.slice(start, at).trim()
    if (raw === 'true') return true
    if (raw === 'false') return false
    if (/^[+-]?\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(raw)) return Number(raw.replace(/_/g, ''))
    if (/^\d{4}-\d{2}-\d{2}/.test(raw) || /^\d{2}:\d{2}/.test(raw)) return raw
    return fail(`cannot read the value "${raw}"`)
  }

  const descend = (table: TomlTable, keys: readonly string[]): TomlTable => {
    let node = table
    for (const key of keys) {
      const existing = node[key]
      if (Array.isArray(existing)) {
        const last = existing.at(-1)
        if (!isTable(last)) fail(`${key} is not a table`)
        node = last as TomlTable
      } else if (isTable(existing)) {
        node = existing
      } else if (existing === undefined) {
        const created: TomlTable = {}
        node[key] = created
        node = created
      } else {
        fail(`${key} is already a value`)
      }
    }
    return node
  }

  function assign(table: TomlTable, keys: readonly string[], value: TomlValue): void {
    const owner = descend(table, keys.slice(0, -1))
    owner[keys.at(-1) as string] = value
  }

  for (;;) {
    skipBlank()
    if (at >= text.length) return root
    if (peek() === '[') {
      const isArray = text.startsWith('[[', at)
      at += isArray ? 2 : 1
      const keys = readKey()
      if (!text.startsWith(isArray ? ']]' : ']', at)) fail('unclosed table header')
      at += isArray ? 2 : 1
      if (isArray) {
        const owner = descend(root, keys.slice(0, -1))
        const name = keys.at(-1) as string
        const list = owner[name] ?? []
        if (!Array.isArray(list)) fail(`${name} is not an array of tables`)
        const table: TomlTable = {}
        ;(list as TomlValue[]).push(table)
        owner[name] = list
        current = table
      } else {
        current = descend(root, keys)
      }
    } else {
      const key = readKey()
      skipSpaces()
      if (peek() !== '=') fail('expected =')
      at += 1
      assign(current, key, readValue())
    }
    skipSpaces()
    if (peek() === '#') while (at < text.length && peek() !== '\n') at += 1
    if (at < text.length && peek() !== '\n' && peek() !== '\r') fail(`unexpected "${peek()}" after a value`)
  }
}
