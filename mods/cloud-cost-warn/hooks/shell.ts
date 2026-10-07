export type ShellCommand = {
  /** Words of the command, quotes removed, redirections left out. */
  words: string[]
  /** Targets of `>`, `>>` and `<` redirections. */
  redirects: string[]
}

const REDIRECT = /^[0-9]*[<>]+&?/

/**
 * A small shell lexer: splits on `;`, `|`, `&`, newlines, subshell parentheses and
 * backticks, honours quotes and backslashes, and sets redirection targets apart.
 * It reads text; it never runs anything.
 */
export function parseShell(input: string): ShellCommand[] {
  const commands: ShellCommand[] = []
  let current: ShellCommand = { words: [], redirects: [] }
  let word = ''
  let hasWord = false
  let quote: '"' | "'" | undefined
  let pendingRedirect = false

  const endWord = () => {
    if (!hasWord) return
    const redirect = REDIRECT.exec(word)
    const text = redirect ? word.slice(redirect[0].length) : word
    if (pendingRedirect && !redirect) {
      current.redirects.push(text)
      pendingRedirect = false
    } else if (redirect) {
      if (text === '') pendingRedirect = true
      else current.redirects.push(text)
    } else {
      current.words.push(text)
    }
    word = ''
    hasWord = false
  }
  const endCommand = () => {
    endWord()
    pendingRedirect = false
    if (current.words.length > 0 || current.redirects.length > 0) commands.push(current)
    current = { words: [], redirects: [] }
  }

  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
      else if (ch === '\\' && quote === '"' && i + 1 < input.length) word += input[++i]
      else word += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      hasWord = true
    } else if (ch === '\\' && i + 1 < input.length) {
      word += input[++i]
      hasWord = true
    } else if (/[\n;|&()`]/.test(ch)) {
      endCommand()
    } else if (/\s/.test(ch)) {
      endWord()
    } else {
      word += ch
      hasWord = true
    }
  }
  endCommand()
  return commands
}

export function baseName(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1)
}
