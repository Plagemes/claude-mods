/** One quoted or unquoted stretch of a word, by its position in the command (the quotes included). */
export type Segment = { start: number; end: number; quote: 'none' | 'single' | 'double' }

export type Word = {
  /** What the shell would pass on: quotes removed, escapes resolved. */
  value: string
  segments: Segment[]
  /** The word holds an expansion ($(...), backticks, $'...') whose result cannot be known here. */
  isUnsafe: boolean
}

const OPERATOR_CHARS = new Set(['|', '&', ';', '(', ')', '\n'])
const SPACE = /[ \t\r]/
const DOUBLE_QUOTE_ESCAPES = new Set(['"', '\\', '$', '`'])

/** Index after the `)` that closes the `$(` at `start`, or -1. */
const endOfSubstitution = (text: string, start: number): number => {
  let depth = 0
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1
    if (text[index] === ')') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return -1
}

type Reader = { text: string; index: number }

/** Reads one word starting at `reader.index`; undefined when a quote or substitution never closes. */
const readWord = (reader: Reader): Word | undefined => {
  const { text } = reader
  const word: Word = { value: '', segments: [], isUnsafe: false }
  let plain: Segment | undefined

  const closePlain = (): void => {
    if (plain !== undefined) word.segments.push({ ...plain, end: reader.index })
    plain = undefined
  }

  while (reader.index < text.length) {
    const char = text[reader.index] ?? ''
    if (SPACE.test(char) || OPERATOR_CHARS.has(char) || char === '<' || char === '>') break

    if (char === "'" || char === '"') {
      closePlain()
      const quote = char
      const start = reader.index
      reader.index += 1
      let isClosed = false
      while (reader.index < text.length && !isClosed) {
        const inner = text[reader.index] ?? ''
        if (inner === quote) {
          isClosed = true
        } else if (quote === '"' && inner === '\\' && DOUBLE_QUOTE_ESCAPES.has(text[reader.index + 1] ?? '')) {
          word.value += text[reader.index + 1] ?? ''
          reader.index += 2
        } else {
          if (quote === '"' && (inner === '`' || (inner === '$' && text[reader.index + 1] === '('))) word.isUnsafe = true
          word.value += inner
          reader.index += 1
        }
      }
      if (!isClosed) return undefined
      reader.index += 1
      word.segments.push({ start, end: reader.index, quote: quote === "'" ? 'single' : 'double' })
      continue
    }

    plain ??= { start: reader.index, end: reader.index, quote: 'none' }
    if (char === '\\') {
      if (text[reader.index + 1] !== '\n') word.value += text[reader.index + 1] ?? ''
      reader.index += 2
    } else if (char === '$' && (text[reader.index + 1] === '(' || text[reader.index + 1] === "'")) {
      word.isUnsafe = true
      const end = text[reader.index + 1] === '(' ? endOfSubstitution(text, reader.index + 1) : text.indexOf("'", reader.index + 2) + 1
      if (end <= 0) return undefined
      word.value += text.slice(reader.index, end)
      reader.index = end
    } else if (char === '`') {
      word.isUnsafe = true
      const end = text.indexOf('`', reader.index + 1) + 1
      if (end <= 0) return undefined
      word.value += text.slice(reader.index, end)
      reader.index = end
    } else {
      word.value += char
      reader.index += 1
    }
  }
  closePlain()
  return word
}

export type Parsed = {
  commands: Word[][]
  /** Per command: its standard output goes to a file or into a pipe instead of back to Claude. */
  isOutputElsewhere: boolean[]
  hasHeredoc: boolean
}

/**
 * Splits a shell command line into simple commands made of words, remembering where each
 * word (and each quoted part of it) sits. Redirections and their targets are dropped.
 * Returns undefined for anything it cannot read with certainty.
 */
export const parseCommand = (text: string): Parsed | undefined => {
  const reader: Reader = { text, index: 0 }
  const commands: Word[][] = [[]]
  const isOutputElsewhere: boolean[] = [false]
  let hasHeredoc = false
  let skipTarget = false
  let isStdoutTarget = false

  while (reader.index < text.length) {
    const char = text[reader.index] ?? ''
    if (SPACE.test(char)) {
      reader.index += 1
    } else if (char === '#' && (reader.index === 0 || SPACE.test(text[reader.index - 1] ?? '') || OPERATOR_CHARS.has(text[reader.index - 1] ?? ''))) {
      const newline = text.indexOf('\n', reader.index)
      reader.index = newline < 0 ? text.length : newline
    } else if (char === '&' && text[reader.index + 1] === '>') {
      // `&>file`: both streams go to the file; the `>` is read next.
      reader.index += 1
    } else if (OPERATOR_CHARS.has(char)) {
      // `a | b` (not `||`): a's output feeds b.
      if (char === '|' && text[reader.index + 1] !== '|' && text[reader.index - 1] !== '|') isOutputElsewhere[commands.length - 1] = true
      // `&` after a `>` is a file descriptor (2>&1), not a separator.
      if (!(char === '&' && /[<>]/.test(text[reader.index - 1] ?? '')) && commands.at(-1)?.length !== 0) {
        commands.push([])
        isOutputElsewhere.push(false)
      }
      reader.index += 1
    } else if (char === '<' || char === '>') {
      if (text.startsWith('<<', reader.index)) hasHeredoc = true
      // "2>file": the digit belongs to the redirection.
      const previous = commands.at(-1)?.at(-1)
      const isNumbered = previous !== undefined && /^\d+$/.test(previous.value) && previous.segments.at(-1)?.end === reader.index
      if (isNumbered) commands.at(-1)?.pop()
      const start = reader.index
      while (/[<>&|]/.test(text[reader.index] ?? '')) reader.index += 1
      // `>file`, `1>>file`, `&>file` move standard output; `2>file` and `>&2` do not.
      const operator = text.slice(start, reader.index)
      isStdoutTarget = operator.startsWith('>') && !operator.includes('&') && (!isNumbered || previous?.value === '1')
      skipTarget = true
    } else {
      const word = readWord(reader)
      if (word === undefined) return undefined
      if (skipTarget) {
        if (isStdoutTarget) isOutputElsewhere[commands.length - 1] = true
        skipTarget = false
      } else commands.at(-1)?.push(word)
    }
  }
  const kept = commands.map((command, index) => ({ command, isElsewhere: isOutputElsewhere[index] === true })).filter(({ command }) => command.length > 0)
  return { commands: kept.map(({ command }) => command), isOutputElsewhere: kept.map(({ isElsewhere }) => isElsewhere), hasHeredoc }
}
