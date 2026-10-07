import { embeddedShellScripts, simpleCommands } from './shared/shell'

/** A word of a shell command line with its place in the original text, so it can be rewritten. */
export type Word = { text: string; start: number; end: number }

export type Edit = { start: number; end: number; text: string }

export type Push = {
  /** `git -C <dir>`: where the push runs. */
  directory?: string
  /** The remote named (`git push origin …`), or undefined for the default one. */
  remote?: string
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
/** How deep scripts handed to a shell further along (`docker exec ci sh -c "…"`) are opened up. */
const MAX_NESTING = 3

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
  if (positionals[0] !== undefined) push.remote = positionals[0].text
  if (hasLease) push.leaseEdits = []
  return push
}

/**
 * Every `git push` on the command line, wherever it hides: behind `&&`, `;`, pipes and wrappers, in `bash -c '…'`,
 * `eval`, `$(…)` or a heredoc fed to a shell (the shared shell reader), or in a shell further along
 * (`docker exec ci sh -c '…'`). Only a push on the line itself can be rewritten: a nested script's offsets are not
 * the line's, so a push in one is checked but never rewritten.
 */
export function findPushes(command: string, depth = 0): Push[] {
  const pushes: Push[] = []
  for (const { argv, spans, depth: nesting } of simpleCommands(command)) {
    if (depth < MAX_NESTING) {
      for (const script of embeddedShellScripts(argv)) pushes.push(...findPushes(script, depth + 1).map(push => ({ ...push, leaseEdits: [] })))
    }
    const words: Word[] = argv.map((text, at) => ({ text, start: spans[at]?.start ?? 0, end: spans[at]?.end ?? 0 }))
    const gitIndex = words.findIndex(word => word.text === 'git' || word.text.endsWith('/git'))
    if (gitIndex === -1) continue
    let directory: string | undefined
    for (let i = gitIndex + 1; i < words.length; i++) {
      const text = (words[i] as Word).text
      if (GIT_OPTIONS_WITH_VALUE.has(text)) {
        if (text === '-C') directory = words[i + 1]?.text
        i += 1
      } else if (!text.startsWith('-')) {
        if (text === 'push') {
          const push = parsePush(words, i, directory)
          pushes.push(depth === 0 && nesting === 0 ? push : { ...push, leaseEdits: [] })
        }
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
