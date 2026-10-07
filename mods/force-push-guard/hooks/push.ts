/** A word of a shell command line with its place in the original text, so it can be rewritten. */
export type Word = { text: string; start: number; end: number }

export type Edit = { start: number; end: number; text: string }

export type Push = {
  /** `git -C <dir>`: where the push runs. */
  directory?: string
  isForced: boolean
  /** --all or --mirror: every branch goes, protected or not. */
  isBroad: boolean
  /** Branch names the push updates; `HEAD` stands for the current branch. */
  refs: string[]
  /** True when the push names no branch, so it updates the current one. */
  usesCurrentBranch: boolean
  /** The edits that turn a bare force into --force-with-lease; empty when nothing needs it. */
  leaseEdits: Edit[]
}

const LEASE = '--force-with-lease'
const OPTIONS_WITH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])

/** Splits a command line into simple commands of words; quotes are honoured, redirections dropped. */
export function lexCommands(input: string): Word[][] {
  const commands: Word[][] = []
  let words: Word[] = []
  let text = ''
  let start = -1
  let quote: '"' | "'" | undefined

  const endWord = (end: number) => {
    if (start !== -1 && !/^[0-9]*[<>]/.test(text)) words.push({ text, start, end })
    text = ''
    start = -1
  }
  const endCommand = (end: number) => {
    endWord(end)
    if (words.length > 0) commands.push(words)
    words = []
  }

  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
      else if (ch === '\\' && quote === '"' && i + 1 < input.length) text += input[++i]
      else text += ch
    } else if (ch === '"' || ch === "'") {
      if (start === -1) start = i
      quote = ch
    } else if (/[\n;|&()`]/.test(ch)) {
      endCommand(i)
    } else if (/\s/.test(ch)) {
      endWord(i)
    } else {
      if (start === -1) start = i
      text += ch === '\\' && i + 1 < input.length ? input[++i] : ch
    }
  }
  endCommand(input.length)
  return commands
}

function parsePush(words: readonly Word[], pushIndex: number, directory: string | undefined): Push {
  const push: Push = { directory, isForced: false, isBroad: false, refs: [], usesCurrentBranch: false, leaseEdits: [] }
  let hasLease = false
  const positionals: Word[] = []

  for (let i = pushIndex + 1; i < words.length; i++) {
    const word = words[i] as Word
    const flag = word.text
    if (OPTIONS_WITH_VALUE.has(flag)) i += 1
    else if (flag === '--force') {
      push.isForced = true
      push.leaseEdits.push({ start: word.start, end: word.end, text: LEASE })
    } else if (flag.startsWith(LEASE) || flag === '--force-if-includes') {
      push.isForced = true
      hasLease = true
    } else if (flag === '--all' || flag === '--mirror') push.isBroad = true
    else if (/^-[a-zA-Z]+$/.test(flag) && flag.includes('f')) {
      push.isForced = true
      const rest = flag.replace('f', '')
      push.leaseEdits.push({ start: word.start, end: word.end, text: rest === '-' ? LEASE : `${rest} ${LEASE}` })
    } else if (!flag.startsWith('-')) positionals.push(word)
  }

  for (const word of positionals.slice(1)) {
    const isPlus = word.text.startsWith('+')
    const refspec = isPlus ? word.text.slice(1) : word.text
    if (isPlus) {
      push.isForced = true
      push.leaseEdits.push({ start: word.start, end: word.end, text: `${LEASE} ${refspec}` })
    }
    const colon = refspec.lastIndexOf(':')
    const isDeletion = colon === 0
    const destination = (colon === -1 ? refspec : refspec.slice(colon + 1)).replace(/^refs\/heads\//, '')
    if (!isDeletion && !destination.startsWith('refs/')) push.refs.push(destination)
  }
  push.usesCurrentBranch = positionals.length < 2
  if (hasLease) push.leaseEdits = []
  return push
}

/** Every `git push` on the command line, wherever it hides behind `&&`, `;` or a pipe. */
export function findPushes(command: string): Push[] {
  const pushes: Push[] = []
  for (const words of lexCommands(command)) {
    const gitIndex = words.findIndex(word => word.text === 'git' || word.text.endsWith('/git'))
    if (gitIndex === -1) continue
    let directory: string | undefined
    for (let i = gitIndex + 1; i < words.length; i++) {
      const text = (words[i] as Word).text
      if (GIT_OPTIONS_WITH_VALUE.has(text)) {
        if (text === '-C') directory = words[i + 1]?.text
        i += 1
      } else if (!text.startsWith('-')) {
        if (text === 'push') pushes.push(parsePush(words, i, directory))
        break
      }
    }
  }
  return pushes
}

export function applyEdits(command: string, edits: readonly Edit[]): string {
  return [...edits]
    .sort((a, b) => b.start - a.start)
    .reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), command)
}

export type BranchRule = { label: string; matches: RegExp }

/** Branch names or `*`/`?` globs, comma separated. */
export function parseBranchList(list: string): BranchRule[] {
  return list
    .split(',')
    .map(item => item.trim())
    .filter(item => item !== '')
    .map(label => ({
      label,
      matches: new RegExp(`^${label.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`),
    }))
}
