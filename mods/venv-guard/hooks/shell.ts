export type ShellCommand = {
  /** Words of the command, quotes removed, redirections left out. */
  words: string[]
  /** Targets of `>`, `>>` and `<` redirections. */
  redirects: string[]
}

const REDIRECT = /^[0-9]*[<>]+&?/

type Heredoc = { delimiter: string; isIndented: boolean }

/** The delimiter of a here-document whose `<<` ends just before `start`, quotes removed; `<<-` strips leading tabs. */
function heredocAt(input: string, start: number): Heredoc {
  let i = start
  const isIndented = input[i] === '-'
  if (isIndented) i += 1
  while (input[i] === ' ' || input[i] === '\t') i += 1
  let delimiter = ''
  let quote: string | undefined
  for (; i < input.length; i += 1) {
    const ch = input[i] as string
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
      else delimiter += ch
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '\\') continue
    else if (/[\s;&|<>()]/.test(ch)) break
    else delimiter += ch
  }
  return { delimiter, isIndented }
}

/** Where the bodies of `heredocs`, starting at `start`, end: just after the line that closes the last one. */
function afterHeredocs(input: string, start: number, heredocs: readonly Heredoc[]): number {
  let position = start
  for (const { delimiter, isIndented } of heredocs) {
    while (position < input.length) {
      const end = input.indexOf('\n', position)
      const line = input.slice(position, end === -1 ? input.length : end)
      position = end === -1 ? input.length : end + 1
      if ((isIndented ? line.replace(/^\t+/, '') : line) === delimiter) break
    }
  }
  return position
}

/**
 * A small shell lexer: splits on `;`, `|`, `&`, newlines, subshell parentheses and
 * backticks, honours quotes and backslashes, and sets redirection targets apart.
 * Here-document bodies (`cat > notes.md <<'EOF' ... EOF`) are text, not commands, and are skipped.
 * It reads text; it never runs anything.
 */
export function parseShell(input: string): ShellCommand[] {
  const commands: ShellCommand[] = []
  let current: ShellCommand = { words: [], redirects: [] }
  let word = ''
  let hasWord = false
  let quote: '"' | "'" | undefined
  let pendingRedirect = false
  let heredocs: Heredoc[] = []

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
    } else if (input.startsWith('<<<', i)) {
      word += '<<<'
      hasWord = true
      i += 2
    } else if (input.startsWith('<<', i)) {
      heredocs.push(heredocAt(input, i + 2))
      word += '<<'
      hasWord = true
      i += 1
    } else if (ch === '\n' && heredocs.length > 0) {
      endCommand()
      i = afterHeredocs(input, i + 1, heredocs) - 1
      heredocs = []
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
