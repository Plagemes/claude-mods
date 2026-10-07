const MAX_BRANCH = 40
const OID_SHORT = 7

/** Where the repository stands, as `git status --porcelain=v2 --branch` tells it. */
export type GitState = { branch: string; hasUpstream: boolean; ahead: number; behind: number; dirty: number; isDetached: boolean }

/** The state in a `git status --porcelain=v2 --branch` report; undefined when it names no branch (not a repository). */
export function parseStatus(porcelain: string): GitState | undefined {
  let head: string | undefined
  let oid = ''
  let hasUpstream = false
  let ahead = 0
  let behind = 0
  let dirty = 0

  for (const line of porcelain.split('\n')) {
    if (line.startsWith('# branch.head ')) head = line.slice('# branch.head '.length)
    else if (line.startsWith('# branch.oid ')) oid = line.slice('# branch.oid '.length)
    else if (line.startsWith('# branch.upstream ')) hasUpstream = true
    else if (line.startsWith('# branch.ab ')) {
      const [plus, minus] = line.slice('# branch.ab '.length).split(' ')
      ahead = Math.abs(Number(plus))
      behind = Math.abs(Number(minus))
    } else if (/^(?:[12u?]) /.test(line)) dirty += 1
  }
  if (head === undefined) return undefined

  const isDetached = head === '(detached)'
  const name = isDetached ? `(${oid.slice(0, OID_SHORT)})` : head
  const branch = name.length > MAX_BRANCH ? `${name.slice(0, MAX_BRANCH - 1)}…` : name
  return { branch, hasUpstream, ahead, behind, dirty, isDetached }
}

/** `⎇ feat/x ↑2 ↓0 ●3` from a parsed status. */
export function describeState({ branch, hasUpstream, ahead, behind, dirty }: GitState): string {
  const sync = hasUpstream ? ` ↑${ahead} ↓${behind}` : ''
  return `⎇ ${branch}${sync} ${dirty > 0 ? `●${dirty}` : '✓'}`
}

/** `⎇ feat/x ↑2 ↓0 ●3` from `git status --porcelain=v2 --branch`; undefined when there is nothing to show. */
export function formatStatus(porcelain: string): string | undefined {
  const state = parseStatus(porcelain)
  return state === undefined ? undefined : describeState(state)
}
