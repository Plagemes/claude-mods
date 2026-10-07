const BLANK = ' '

const blank = (char: string): string => (char === '\n' ? '\n' : BLANK)

/** Index just past a template literal that starts at `start` (a backtick), `${ }` expressions and nested templates included. */
const endOfTemplate = (source: string, start: number): number => {
  let i = start + 1
  while (i < source.length) {
    const char = source[i]
    if (char === '\\') i += 2
    else if (char === '`') return i + 1
    else if (char === '$' && source[i + 1] === '{') i = endOfExpression(source, i + 2)
    else i += 1
  }
  return source.length
}

/** Index just past the `}` that closes a template's `${`, whose body starts at `start`. */
const endOfExpression = (source: string, start: number): number => {
  let depth = 1
  let i = start
  while (i < source.length && depth > 0) {
    const char = source[i]
    if (char === '`') i = endOfTemplate(source, i)
    else if (char === '{') {
      depth += 1
      i += 1
    } else if (char === '}') {
      depth -= 1
      i += 1
    } else i += 1
  }
  return i
}

/**
 * `source` with comments and the insides of strings and templates blanked: the same length and the same line
 * breaks, so an offset in one is the same place in the other, but a brace or a call in a string is not code.
 */
export const mask = (source: string): string => {
  const out: string[] = []
  let i = 0
  const blankTo = (end: number) => {
    for (; i < end && i < source.length; i++) out.push(blank(source[i] ?? ''))
  }

  while (i < source.length) {
    const char = source[i] ?? ''
    const next = source[i + 1]
    if (char === '/' && next === '/') {
      const lineEnd = source.indexOf('\n', i)
      blankTo(lineEnd === -1 ? source.length : lineEnd)
    } else if (char === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2)
      blankTo(close === -1 ? source.length : close + 2)
    } else if (char === '`') {
      const end = endOfTemplate(source, i)
      const isClosed = end - 1 > i && source[end - 1] === '`'
      out.push(char)
      i += 1
      blankTo(isClosed ? end - 1 : end)
      if (isClosed) {
        out.push('`')
        i += 1
      }
    } else if (char === '"' || char === "'") {
      out.push(char)
      i += 1
      while (i < source.length && source[i] !== char && source[i] !== '\n') {
        const step = source[i] === '\\' ? 2 : 1
        blankTo(i + step)
      }
      if (source[i] === char) {
        out.push(char)
        i += 1
      }
    } else {
      out.push(char)
      i += 1
    }
  }
  return out.join('')
}

/** Index of the `}` that closes the `{` at `open` in masked text, or -1 when it never closes. */
export const closingBrace = (masked: string, open: number): number => {
  let depth = 0
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '{') depth += 1
    else if (masked[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}
