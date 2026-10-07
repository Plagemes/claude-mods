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

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
/** `-c`, or `-c` grouped with other short options: `bash -lc`, `sh -ec`. */
const SHELL_COMMAND_FLAG = /^-[a-zA-Z]*c[a-zA-Z]*$/
const MAX_NESTING = 3

/** The script a command hands to a shell (`bash -lc "…"`, `sudo sh -c '…'`, `eval '…'`), if it does. */
function nestedScript(words: readonly string[]): string | undefined {
  const at = words.findIndex(word => SHELLS.has(baseName(word)) || word === 'eval')
  if (at === -1) return undefined
  if (words[at] === 'eval') return words.slice(at + 1).join(' ')
  const flag = words.findIndex((word, index) => index > at && SHELL_COMMAND_FLAG.test(word))
  return flag === -1 ? undefined : words[flag + 1]
}

/** The commands with, after each one that runs a shell script, the commands of that script. */
export function withNestedScripts(commands: readonly ShellCommand[], depth = 0): ShellCommand[] {
  return commands.flatMap(command => {
    const script = depth < MAX_NESTING ? nestedScript(command.words) : undefined
    return script === undefined ? [command] : [command, ...withNestedScripts(parseShell(script), depth + 1)]
  })
}
