/** One simple command of a shell line: its words, and how data reaches it. */
export type Simple = {
  words: string[]
  /** It follows a `|`: another command's output is its input. */
  isPiped: boolean
  /** It reads a file or here-document: `< file`, `<<EOF`, `<<<`. */
  hasInput: boolean
}

/** Words that run another command, with the pattern of their options that take a value. */
const WRAPPERS: Readonly<Record<string, RegExp>> = {
  sudo: /^-[ugCpDhRT]$/, doas: /^-[uC]$/, nice: /^-n$/, ionice: /^-[cnp]$/, timeout: /^-[sk]$/, xargs: /^-[IiLnPsdEa]$/, env: /^-[uCS]$/,
  command: /^$/, exec: /^$/, time: /^$/, nohup: /^$/, setsid: /^$/, stdbuf: /^$/, eval: /^$/,
}
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const MAX_DEPTH = 3

/**
 * Splits a shell line into simple commands. Quotes and backslashes are honoured, comments and here-document bodies
 * are skipped, `$(...)` and `( ... )` start commands of their own, and `bash -c '...'` is read as the commands inside it.
 */
export const simpleCommands = (line: string, depth = 0): Simple[] => {
  const commands: Simple[] = []
  let current: Simple = { words: [], isPiped: false, hasInput: false }
  let word = ''
  let isOpen = false
  let pipeNext = false
  const heredocs: string[] = []

  const endWord = (): void => {
    if (!isOpen) return
    if (word.startsWith('<')) current.hasInput = true
    current.words.push(word)
    word = ''
    isOpen = false
  }
  const endCommand = (): void => {
    endWord()
    if (current.words.length > 0) commands.push(current)
    current = { words: [], isPiped: pipeNext, hasInput: false }
    pipeNext = false
  }

  let i = 0
  while (i < line.length) {
    const char = line[i] as string
    if (char === '\\' && i + 1 < line.length) {
      word += line[i + 1] === '\n' ? '' : line[i + 1]
      isOpen = isOpen || line[i + 1] !== '\n'
      i += 2
    } else if (char === "'") {
      const end = line.indexOf("'", i + 1)
      const stop = end === -1 ? line.length : end
      word += line.slice(i + 1, stop)
      isOpen = true
      i = stop + 1
    } else if (char === '"') {
      i += 1
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length) i += 1
        word += line[i]
        i += 1
      }
      isOpen = true
      i += 1
    } else if (char === '#' && !isOpen) {
      while (i < line.length && line[i] !== '\n') i += 1
    } else if (char === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
      endWord()
      current.hasInput = true
      const found = /^<<-?\s*(?:'([^']+)'|"([^"]+)"|([\w.-]+))/.exec(line.slice(i))
      if (found !== null) {
        heredocs.push(found[1] ?? found[2] ?? found[3] ?? '')
        i += found[0].length
      } else {
        i += 2
      }
    } else if (char === '\n') {
      endCommand()
      i += 1
      for (const delimiter of heredocs.splice(0)) {
        while (i < line.length) {
          const end = line.indexOf('\n', i)
          const row = line.slice(i, end === -1 ? line.length : end)
          i = end === -1 ? line.length : end + 1
          if (row.trim() === delimiter) break
        }
      }
    } else if (char === ' ' || char === '\t') {
      endWord()
      i += 1
    } else if (char === '|' && line[i + 1] === '|') {
      endCommand()
      i += 2
    } else if (char === '&' && line[i + 1] === '&') {
      endCommand()
      i += 2
    } else if (char === '|') {
      pipeNext = true
      endCommand()
      i += 1
    } else if (char === '&') {
      // A lone `&` ends a command; the `&` of `2>&1` or `&>file` is part of a redirect.
      if (line[i - 1] === '>' || line[i + 1] === '>') {
        word += char
        isOpen = true
      } else {
        endCommand()
      }
      i += 1
    } else if (char === ';' || char === '(' || char === ')') {
      endCommand()
      i += 1
    } else {
      word += char
      isOpen = true
      i += 1
    }
  }
  endCommand()
  return commands.flatMap(command => expand(command, depth))
}

/** The command itself after `sudo`, `env X=1`, `timeout 5` and the like; `bash -c '...'` becomes the commands in the string. */
const expand = (command: Simple, depth: number): Simple[] => {
  const { words } = command
  let at = 0
  let wrapper = ''
  while (at < words.length && (Object.hasOwn(WRAPPERS, words[at] as string) || ASSIGNMENT.test(words[at] as string))) {
    wrapper = words[at] as string
    const valued = WRAPPERS[wrapper]
    at += 1
    // Options of the wrapper, and the value some of them take (`sudo -u name`, `nice -n 5`); `timeout` also takes a duration.
    while (valued !== undefined && at < words.length && (words[at] as string).startsWith('-')) at += valued.test(words[at] as string) ? 2 : 1
    if (wrapper === 'timeout' && /^\d/.test(words[at] ?? '')) at += 1
  }
  const rest = words.slice(at)
  const name = (rest[0] ?? '').replace(/^.*\//, '')
  if (SHELLS.has(name) && depth < MAX_DEPTH) {
    const flag = rest.findIndex(word => /^-[a-z]*c[a-z]*$/.test(word))
    const script = flag === -1 ? undefined : rest[flag + 1]
    if (script !== undefined) return simpleCommands(script, depth + 1).map(inner => ({ ...inner, isPiped: inner.isPiped || command.isPiped, hasInput: inner.hasInput || command.hasInput }))
  }
  if (wrapper === 'eval' && depth < MAX_DEPTH) return simpleCommands(rest.join(' '), depth + 1)
  return rest.length === 0 ? [] : [{ ...command, words: rest }]
}
