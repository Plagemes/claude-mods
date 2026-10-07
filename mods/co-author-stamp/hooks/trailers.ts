export type CoAuthor = { name: string; email: string }

const ENTRY = /([^<>,;\n]+?)\s*<([^<>\s]+@[^<>\s]+)>/g
// `git commit` at the start of a command (after ; && || | ( or a newline), with sudo/env/-C/-c in front.
const GIT_COMMIT = /(^|[;&|(\n]\s*)((?:sudo\s+)?(?:\w+=\S*\s+)*git(?:\s+(?:-C\s+\S+|-c\s+\S+|--[\w-]+(?:=\S+)?|-p))*\s+commit)(?=\s|$)/g
// -m, -am, --message, -F, --file: the commit carries a message we can add a trailer to.
const HAS_MESSAGE = /(?:^|\s)(?:-[a-zA-Z]*m|--message|-F|--file)/

export function parseCoAuthors(list: string): CoAuthor[] {
  return [...list.matchAll(ENTRY)].map(([, name, email]) => ({ name: (name as string).trim(), email: email as string }))
}

export function trailerOf({ name, email }: CoAuthor): string {
  return `Co-authored-by: ${name} <${email}>`
}

export function missingFrom(text: string, coAuthors: readonly CoAuthor[]): CoAuthor[] {
  const haystack = text.toLowerCase()
  return coAuthors.filter(({ email }) => !haystack.includes(email.toLowerCase()))
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

export function mentionsCommit(command: string): boolean {
  return /\bgit\b[\s\S]*\bcommit\b/.test(command)
}

/** The rest of this commit's own command: up to the next `&&`, `||`, `;`, `|` or line (a `\` line continuation kept). */
const ownArguments = (rest: string): string => rest.replace(/\\\n/g, ' ').split(/&&|\|\||[;|\n]/)[0] ?? ''

/** Adds `--trailer '...'` right after each `git commit <message flags>`, which git appends after any -m text. */
export function addTrailers(command: string, coAuthors: readonly CoAuthor[]): string {
  const flags = coAuthors.map(author => `--trailer ${shellQuote(trailerOf(author))}`).join(' ')
  return command.replace(GIT_COMMIT, (match: string, lead: string, head: string, offset: number, whole: string) =>
    HAS_MESSAGE.test(ownArguments(whole.slice(offset + match.length))) ? `${lead}${head} ${flags}` : match,
  )
}

/** Does `git --version` print 2.32 or newer, the release that added `git commit --trailer`? */
export function supportsCommitTrailer(versionOutput: string): boolean {
  const found = /(\d+)\.(\d+)/.exec(versionOutput)
  if (!found) return false
  const [major, minor] = [Number(found[1]), Number(found[2])]
  return major > 2 || (major === 2 && minor >= 32)
}
