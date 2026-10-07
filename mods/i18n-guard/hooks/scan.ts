// Finds user-facing string literals in JSX, Vue templates and Svelte markup: text nodes and
// string-valued attributes. Anything that is an expression (t('key'), {label}) is not a literal.

export type FileKind = 'jsx' | 'vue' | 'svelte'
export type Finding = { kind: 'text' | 'attribute'; name: string; value: string }

type Scan = { source: string; attributes: ReadonlySet<string>; findings: Finding[] }
type Tag = { end: number; name: string; kind: 'open' | 'close' | 'selfClosing'; isPlain: boolean }
type Value = { end: number; text?: string }

const FILE_KINDS: Record<string, FileKind> = { jsx: 'jsx', tsx: 'jsx', vue: 'vue', svelte: 'svelte' }
// Test, story and fixture files hold literal strings on purpose.
const NOT_UI_CODE = /\.(?:test|spec|stories|story)\.[a-z]+$|(?:^|[\\/])__(?:tests|mocks|fixtures)__[\\/]/i
const LETTER = /\p{L}/u
const ENTITY = /&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/gi
// Their content is code, not copy.
const RAW_TEXT_ELEMENTS = new Set(['script', 'style'])
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
const TAG_NAME = /[A-Za-z][\w.:-]*/y
const ATTRIBUTE_NAME = /[^\s=/>{]+/y
const BARE_VALUE = /[^\s>]+/y
const BOUND_PREFIX = /^(?::|v-bind:)/
const KEYWORD_BEFORE_JSX = /(?:^|[^\w$])(?:return|default|else|case|yield|await)$/
// The longest keyword above, so the character before it is in view too.
const KEYWORD_LOOKBACK = 'default'.length

export const fileKindOf = (path: string): FileKind | undefined => {
  const extension = path.split('.').at(-1)?.toLowerCase() ?? ''
  return NOT_UI_CODE.test(path) ? undefined : FILE_KINDS[extension]
}

const hasLetters = (text: string): boolean => LETTER.test(text.replace(ENTITY, ''))

const skipString = (source: string, start: number): number => {
  const quote = source.charAt(start)
  let i = start + 1
  while (i < source.length) {
    const ch = source.charAt(i)
    if (ch === '\\') i += 2
    else if (ch === quote) return i + 1
    else i += 1
  }
  return source.length
}

const skipComment = (source: string, start: number): number | undefined => {
  if (source.startsWith('/*', start)) {
    const end = source.indexOf('*/', start + 2)
    return end < 0 ? source.length : end + 2
  }
  if (source.startsWith('//', start)) {
    const end = source.indexOf('\n', start)
    return end < 0 ? source.length : end
  }
  return undefined
}

// Index just past the ">" of the first `closing` tag at or after `from`.
const skipPast = (source: string, closing: string, from: number): number => {
  const found = source.indexOf(closing, from)
  const end = found < 0 ? -1 : source.indexOf('>', found)
  return end < 0 ? source.length : end + 1
}

// A quote opens a string unless it follows a letter (the apostrophe in "Don't").
const isStringStart = (source: string, i: number): boolean => {
  const ch = source.charAt(i)
  return ch === '`' || ((ch === '"' || ch === "'") && !/[\w$]/.test(source.charAt(i - 1)))
}

// Index just past the "}" that closes the "{" at `start`.
const skipBraces = (source: string, start: number): number => {
  let depth = 0
  let i = start
  while (i < source.length) {
    const afterComment = skipComment(source, i)
    if (afterComment !== undefined) {
      i = afterComment
    } else if (isStringStart(source, i)) {
      i = skipString(source, i)
    } else {
      depth += source.charAt(i) === '{' ? 1 : source.charAt(i) === '}' ? -1 : 0
      i += 1
      if (depth === 0) return i
    }
  }
  return source.length
}

// The text of `"..."`, `'...'` or `` `...` `` when that is all `expression` holds (no interpolation, no concatenation).
const plainLiteral = (expression: string): string | undefined => {
  const match = /^(["'`])([\s\S]*)\1$/.exec(expression.trim())
  const quote = match?.[1]
  const body = match?.[2]
  if (quote === undefined || body === undefined) return undefined
  const isPlain = !body.replace(/\\./g, '').includes(quote) && !(quote === '`' && body.includes('${'))
  return isPlain ? body : undefined
}

// Text nodes lose the punctuation that joins them to an expression (`{n}, welcome back` -> `welcome back`).
const SEPARATORS = /^[\s,.;:!?·•|/\\()[\]–—-]+|[\s,.;:!?·•|/\\()[\]–—-]+$/g

const add = (scan: Scan, finding: Finding): void => {
  const squeezed = finding.value.replace(/\s+/g, ' ').trim()
  const value = finding.kind === 'text' ? squeezed.replace(ENTITY, ' ').replace(/\s+/g, ' ').replace(SEPARATORS, '') : squeezed
  if (hasLetters(value)) scan.findings.push({ ...finding, value })
}

const scanInner = (scan: Scan, inner: string, isMarkup: boolean): void =>
  scanBlock({ ...scan, source: inner }, isMarkup)

const readValue = (scan: Scan, i: number): Value => {
  const { source } = scan
  const ch = source.charAt(i)
  if (ch === '"' || ch === "'") {
    const close = source.indexOf(ch, i + 1)
    const end = close < 0 ? source.length : close
    return { end: end + 1, text: source.slice(i + 1, end) }
  }
  if (ch === '{') {
    const end = skipBraces(source, i)
    const inner = source.slice(i + 1, end - 1)
    scanInner(scan, inner, false)
    return { end, text: plainLiteral(inner) }
  }
  BARE_VALUE.lastIndex = i
  return { end: i + (BARE_VALUE.exec(source)?.[0].length ?? 0) }
}

// Reads one tag from its "<", recording the string-valued attributes it carries.
const readTag = (scan: Scan, start: number): Tag => {
  const { source } = scan
  if (source.charAt(start + 1) === '/') {
    const close = source.indexOf('>', start)
    return { end: close < 0 ? source.length : close + 1, name: '', kind: 'close', isPlain: true }
  }
  TAG_NAME.lastIndex = start + 1
  const name = TAG_NAME.exec(source)?.[0] ?? ''
  let i = start + 1 + name.length
  let isPlain = true
  while (i < source.length) {
    const ch = source.charAt(i)
    if (ch === '>') return { end: i + 1, name, kind: 'open', isPlain }
    if (ch === '/' && source.charAt(i + 1) === '>') return { end: i + 2, name, kind: 'selfClosing', isPlain }
    if (ch === '{') {
      const end = skipBraces(source, i)
      scanInner(scan, source.slice(i + 1, end - 1), false)
      i = end
      continue
    }
    ATTRIBUTE_NAME.lastIndex = i
    const attribute = ATTRIBUTE_NAME.exec(source)?.[0]
    if (attribute === undefined) {
      i += 1
      continue
    }
    i += attribute.length
    while (/\s/.test(source.charAt(i))) i += 1
    if (source.charAt(i) !== '=') continue

    isPlain = false
    i += 1
    while (/\s/.test(source.charAt(i))) i += 1
    const value = readValue(scan, i)
    i = value.end
    const isBound = BOUND_PREFIX.test(attribute)
    const attributeName = attribute.replace(BOUND_PREFIX, '').toLowerCase()
    const isQuoted = source.charAt(i - 1) === '"' || source.charAt(i - 1) === "'"
    const literal = isBound && isQuoted && value.text !== undefined ? plainLiteral(value.text) : value.text
    if (scan.attributes.has(attributeName) && literal !== undefined) {
      add(scan, { kind: 'attribute', name: attributeName, value: literal })
    }
  }
  return { end: source.length, name, kind: 'open', isPlain }
}

const isTagStart = (source: string, i: number, isChildren: boolean): boolean => {
  const next = source.charAt(i + 1)
  if (isChildren) return /[A-Za-z>/]/.test(next)
  if (!/[A-Za-z>]/.test(next)) return false
  // In plain code "a < b" and "Array<T>" are not tags; "return <div>" and "(<div>" are.
  // Only the last non-blank character (and a keyword ending there) matters: looking back, not slicing, keeps big files linear.
  let last = i - 1
  while (last >= 0 && /\s/.test(source.charAt(last))) last -= 1
  return last < 0 || !/[\w$)\]]/.test(source.charAt(last)) || KEYWORD_BEFORE_JSX.test(source.slice(Math.max(0, last - KEYWORD_LOOKBACK), last + 1))
}

// Walks `scan.source`. In code, JSX elements are looked for; inside an element (or anywhere in markup) text is read.
const scanBlock = (scan: Scan, isMarkup: boolean): void => {
  const { source } = scan
  let depth = 0
  let i = 0
  while (i < source.length) {
    const ch = source.charAt(i)
    const isChildren = isMarkup || depth > 0

    if (ch === '<' && isTagStart(source, i, isChildren)) {
      const tag = readTag(scan, i)
      i = tag.end
      // `<T,>(x: T) => x` is a generic arrow function, not an element.
      const isGeneric = !isChildren && tag.kind === 'open' && tag.isPlain && /^\s*\(/.test(source.slice(i))
      if (isGeneric) continue
      if (tag.kind === 'close') depth = Math.max(0, depth - 1)
      else if (tag.kind === 'open' && RAW_TEXT_ELEMENTS.has(tag.name)) i = skipPast(source, `</${tag.name}`, i)
      else if (tag.kind === 'open' && !(isMarkup && VOID_ELEMENTS.has(tag.name.toLowerCase()))) depth += 1
    } else if (isChildren && ch === '{') {
      const end = skipBraces(source, i)
      const inner = source.slice(i + 1, end - 1)
      const literal = plainLiteral(inner)
      if (literal === undefined) scanInner(scan, inner, false)
      else add(scan, { kind: 'text', name: '', value: literal })
      i = end
    } else if (isChildren) {
      let end = i + 1
      while (end < source.length && source.charAt(end) !== '<' && source.charAt(end) !== '{') end += 1
      add(scan, { kind: 'text', name: '', value: source.slice(i, end) })
      i = end
    } else {
      const afterComment = skipComment(source, i)
      i = afterComment ?? (isStringStart(source, i) ? skipString(source, i) : i + 1)
    }
  }
}

export const findHardCoded = (source: string, kind: FileKind, attributes: ReadonlySet<string>, isWholeFile: boolean): Finding[] => {
  const scan: Scan = { source, attributes, findings: [] }
  if (kind === 'jsx') {
    scanBlock(scan, false)
    return scan.findings
  }
  // Vue and Svelte: leave out <script>, <style> and comments; the rest is markup.
  const markup = source.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '')
  const template = kind === 'vue' ? /<template\b[^>]*>([\s\S]*)<\/template>/i.exec(markup)?.[1] : undefined
  // A pasted fragment may be script or markup; only a whole file (or a Vue <template>) is known to be markup.
  const isMarkup = template !== undefined || (kind === 'svelte' && isWholeFile)
  scanBlock({ ...scan, source: template ?? markup }, isMarkup)
  return scan.findings
}

const keyOf = ({ kind, name, value }: Finding): string => `${kind}\u0000${name}\u0000${value}`

// What `after` holds that `before` did not: the strings an edit adds, not the ones that were already there.
export const addedFindings = (before: readonly Finding[], after: readonly Finding[]): Finding[] => {
  const remaining = new Map<string, number>()
  for (const finding of before) remaining.set(keyOf(finding), (remaining.get(keyOf(finding)) ?? 0) + 1)
  return after.filter(finding => {
    const count = remaining.get(keyOf(finding)) ?? 0
    remaining.set(keyOf(finding), count - 1)
    return count <= 0
  })
}

export const describeFinding = ({ kind, name, value }: Finding): string => (kind === 'text' ? `"${value}"` : `${name}="${value}"`)
