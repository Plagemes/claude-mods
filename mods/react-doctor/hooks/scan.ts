/** A JSX opening tag found in the source: where it starts, its name and its attribute text. */
export type JsxTag = { start: number; name: string; attrs: string; isFragment: boolean }

/** The source with comments, string and template text, and JSX text blanked to spaces (newlines kept), plus its JSX tags. */
export type Scanned = { code: string; tags: JsxTag[] }

const IDENT = /[\w$]/
const STRING_AFTER_WORD = new Set(['return', 'case', 'typeof', 'in', 'of', 'yield', 'await', 'else', 'do', 'export', 'import', 'from', 'throw', 'new', 'void', 'delete'])
const JSX_AFTER_WORD = new Set(['return', 'case', 'yield', 'await', 'else', 'do', 'default'])
const JSX_AFTER_CHAR = new Set(['(', ',', '=', '?', ':', '&', '|', '{', '[', '>', '}', ';', '!'])
const STRING_AFTER_CHAR = new Set(['=', '(', ',', ':', '[', '!', '&', '|', '?', '{', '}', '<', '>', '+', '-', '*', '/', '%', ';', '~', '^'])

/** The last non-space character before `index`, and the word it ends, if any. */
const previous = (text: string, index: number): { char: string | undefined; word: string } => {
  let i = index - 1
  while (i >= 0 && /\s/.test(text[i] ?? '')) i -= 1
  const char = text[i]
  let start = i
  while (start >= 0 && IDENT.test(text[start] ?? '')) start -= 1
  return { char, word: text.slice(start + 1, i + 1) }
}

/**
 * Blanks what is not code so brackets can be matched and identifiers read:
 * comments, the text of strings and templates (a template's `${…}` stays
 * code) and the text between JSX tags (a child `{…}` stays code). Every
 * offset and line of the source holds in the result.
 */
export const scan = (source: string): Scanned => {
  const out = source.split('')
  const tags: JsxTag[] = []
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i += 1) if (out[i] !== '\n') out[i] = ' '
  }

  /** Reads code from `i` until an unmatched `}` (when `stopAtBrace`) or the end; returns where it stopped. */
  const readCode = (start: number, stopAtBrace: boolean): number => {
    let depth = 0
    let i = start
    while (i < source.length) {
      const char = source[i] ?? ''
      const next = source[i + 1] ?? ''
      if (char === '/' && next === '/') {
        const end = source.indexOf('\n', i)
        const stop = end < 0 ? source.length : end
        blank(i, stop)
        i = stop
      } else if (char === '/' && next === '*') {
        const end = source.indexOf('*/', i + 2)
        const stop = end < 0 ? source.length : end + 2
        blank(i, stop)
        i = stop
      } else if (char === '`') {
        i = readTemplate(i + 1)
      } else if (char === '"' || char === "'") {
        const before = previous(source, i)
        const isString =
          before.char === undefined || STRING_AFTER_CHAR.has(before.char) || STRING_AFTER_WORD.has(before.word) || /\n\s*$/.test(source.slice(Math.max(0, i - 80), i))
        i = isString ? readString(i, char) : i + 1
      } else if (char === '<' && isJsxStart(i)) {
        i = readJsx(i)
      } else if (char === '{') {
        depth += 1
        i += 1
      } else if (char === '}') {
        if (depth === 0 && stopAtBrace) return i
        depth -= 1
        i += 1
      } else {
        i += 1
      }
    }
    return i
  }

  /** A quoted string ends at its quote or at the line's end. */
  const readString = (open: number, quote: string): number => {
    let i = open + 1
    while (i < source.length && source[i] !== quote && source[i] !== '\n') i += source[i] === '\\' ? 2 : 1
    blank(open + 1, Math.min(i, source.length))
    return i + 1
  }

  const readTemplate = (start: number): number => {
    let i = start
    let from = start
    while (i < source.length && source[i] !== '`') {
      if (source[i] === '\\') {
        i += 2
      } else if (source[i] === '$' && source[i + 1] === '{') {
        blank(from, i)
        i = readCode(i + 2, true) + 1
        from = i
      } else {
        i += 1
      }
    }
    blank(from, Math.min(i, source.length))
    return i + 1
  }

  const isJsxStart = (i: number): boolean => {
    const next = source[i + 1] ?? ''
    if (!/[A-Za-z>]/.test(next)) return false
    const before = previous(source, i)
    if (before.char === undefined) return true
    if (JSX_AFTER_WORD.has(before.word)) return true
    if (IDENT.test(before.char) || before.char === ')' || before.char === ']') return false
    // A generic arrow in a .tsx file: `<T,>(…) =>` or `<T extends X>(…) =>`.
    if (/^<[A-Za-z]\w*\s*(?:,|extends\b)/.test(source.slice(i, i + 40))) return false
    return JSX_AFTER_CHAR.has(before.char)
  }

  /** Reads one JSX element (its tag, attributes, children and closing tag) from `<`; returns the offset after it. */
  const readJsx = (open: number): number => {
    let i = open + 1
    const isFragment = source[i] === '>'
    const nameMatch = /^[A-Za-z][\w.:-]*/.exec(source.slice(i, i + 200))
    const name = isFragment ? '' : (nameMatch?.[0] ?? '')
    i += name.length
    const attrsFrom = i
    // Attributes: strings are blanked, `{…}` is code.
    while (i < source.length && source[i] !== '>' && !(source[i] === '/' && source[i + 1] === '>')) {
      const char = source[i]
      if (char === '"' || char === "'") {
        const end = source.indexOf(char, i + 1)
        const stop = end < 0 ? source.length : end
        blank(i + 1, stop)
        i = stop + 1
      } else if (char === '{') {
        i = readCode(i + 1, true) + 1
      } else {
        i += 1
      }
    }
    tags.push({ start: open, name, attrs: source.slice(attrsFrom, i), isFragment })
    if (source[i] === '/') return i + 2
    i += 1
    // Children: text is blanked, `{…}` is code, `<…>` is a child element, `</…>` closes this one.
    let from = i
    while (i < source.length) {
      const char = source[i]
      if (char === '{') {
        blank(from, i)
        i = readCode(i + 1, true) + 1
        from = i
      } else if (char === '<' && source[i + 1] === '/') {
        blank(from, i)
        const end = source.indexOf('>', i)
        return end < 0 ? source.length : end + 1
      } else if (char === '<' && /[A-Za-z>]/.test(source[i + 1] ?? '')) {
        blank(from, i)
        i = readJsx(i)
        from = i
      } else {
        i += 1
      }
    }
    blank(from, i)
    return i
  }

  readCode(0, false)
  return { code: out.join(''), tags }
}

/** The offset of the bracket that closes the one at `open` (`{`, `(` or `[`), or -1. */
export const matchBracket = (code: string, open: number): number => {
  const pairs: Record<string, string> = { '{': '}', '(': ')', '[': ']' }
  const stack: string[] = []
  for (let i = open; i < code.length; i += 1) {
    const char = code[i] ?? ''
    if (char in pairs) stack.push(pairs[char] ?? '')
    else if (char === '}' || char === ')' || char === ']') {
      if (stack.pop() !== char) return -1
      if (stack.length === 0) return i
    }
  }
  return -1
}

/** The offset of the bracket that opens the one at `close`, or -1. */
export const matchBackward = (code: string, close: number): number => {
  const pairs: Record<string, string> = { '}': '{', ')': '(', ']': '[' }
  const stack: string[] = []
  for (let i = close; i >= 0; i -= 1) {
    const char = code[i] ?? ''
    if (char in pairs) stack.push(pairs[char] ?? '')
    else if (char === '{' || char === '(' || char === '[') {
      if (stack.pop() !== char) return -1
      if (stack.length === 0) return i
    }
  }
  return -1
}

/** Where the newlines of the last source asked about are: every finding in one file reuses them instead of recounting. */
let indexed: { source: string; newlines: number[] } = { source: '', newlines: [] }

/** The 1-based line of an offset (a binary search over the file's newline offsets, found once per file). */
export const lineAt = (source: string, index: number): number => {
  if (indexed.source !== source) {
    const newlines: number[] = []
    for (let at = source.indexOf('\n'); at >= 0; at = source.indexOf('\n', at + 1)) newlines.push(at)
    indexed = { source, newlines }
  }
  const { newlines } = indexed
  let low = 0
  let high = newlines.length
  while (low < high) {
    const middle = (low + high) >> 1
    if ((newlines[middle] ?? Infinity) < index) low = middle + 1
    else high = middle
  }
  return low + 1
}
