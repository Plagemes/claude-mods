// Pure logic of session-sync: which repository a session is in, file leases (take, renew, deny, override,
// expire), overlap and same-branch warnings, hand-off notes and the inbox. No `$`, no I/O: unit-tested directly.
import type { SyncLease, SyncLeaseFile, SyncMessage, SyncMessageKind, SyncPeer } from '../types'

/** A session whose file is older than this is gone: its leases count for nothing. */
export const STALE_MS = 30_000
/** Files another session touched this recently count as its current work, for overlap warnings. */
export const OVERLAP_WINDOW_MS = 30 * 60_000
export const TOUCHED_KEEP = 50
export const ACKED_KEEP = 50
export const MESSAGE_TTL_MS = 30 * 60_000
const TEXT_CHARS = 4_000

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback)
const num = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

export const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`
}

export const labelOf = (project: string, id: string): string => `${project || 'session'}#${id.slice(0, 4)}`

// ── The repository ──────────────────────────────────────────────────────────────────────────────────

/** A remote URL in one spelling whatever the protocol: `git@github.com:Org/Repo.git` = `https://u:t@github.com/org/repo`. */
export function normalizeRemote(url: string): string {
  let rest = url.trim().toLowerCase()
  if (rest === '') return ''
  rest = rest.replace(/^[a-z+]+:\/\//, '')
  rest = rest.replace(/^[^@/]*@/, '')
  rest = rest.replace(/^([^/:]+):(?!\d+\/)/, '$1/')
  rest = rest.replace(/^([^/:]+):\d+\//, '$1/')
  return rest.replace(/\/+$/, '').replace(/\.git$/, '')
}

/** FNV-1a, 32 bits, as 8 hex digits: a stable folder name, not a secret. */
export function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** The folder of a repository: its name and a hash of its remote (or of its root when it has none). */
export function repoKey(remote: string | null, root: string): string {
  const normalized = normalizeRemote(remote ?? '')
  const identity = normalized === '' ? `root:${root}` : normalized
  const name = (normalized === '' ? root : normalized).split('/').filter(part => part !== '').pop() ?? 'repo'
  return `${name.replace(/[^a-z0-9._-]/gi, '-').slice(0, 40) || 'repo'}-${hash(identity)}`
}

/** `git status --porcelain --branch`: the branch (`HEAD` when detached) and whether anything is uncommitted. */
export function parseStatus(stdout: string): { branch: string; isDirty: boolean } {
  const lines = stdout.split('\n').filter(line => line.trim() !== '')
  const head = lines[0]?.startsWith('## ') === true ? lines[0].slice(3) : ''
  let branch = head.replace(/^No commits yet on /, '').split('...')[0]?.split(' ')[0] ?? ''
  if (head.startsWith('HEAD (no branch)')) branch = 'HEAD'
  return { branch, isDirty: lines.some(line => !line.startsWith('## ')) }
}

// ── Paths ───────────────────────────────────────────────────────────────────────────────────────────

/** `/a/./b/../c` → `/a/c`, with forward slashes. */
export function normalizePath(path: string): string {
  const isAbsolute = path.startsWith('/')
  const parts: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `${isAbsolute ? '/' : ''}${parts.join('/')}`
}

export const resolvePath = (cwd: string, path: string): string => normalizePath(path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) ? path : `${cwd}/${path}`)

/** The path inside `tree`, or undefined when it lies outside (or inside .git). */
export function relativeTo(tree: string, path: string): string | undefined {
  const root = normalizePath(tree)
  const file = normalizePath(path)
  if (!file.startsWith(`${root}/`)) return undefined
  const rel = file.slice(root.length + 1)
  return rel === '' || rel === '.git' || rel.startsWith('.git/') ? undefined : rel
}

export const dirOf = (rel: string): string => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '.')

// ── Peers ───────────────────────────────────────────────────────────────────────────────────────────

export function parsePeer(value: unknown): SyncPeer | null {
  if (!isRecord(value) || value.v !== 1 || typeof value.id !== 'string' || value.id === '') return null
  const touched = Array.isArray(value.touched)
    ? value.touched.filter((entry): entry is { path: string; at: number } => isRecord(entry) && typeof entry.path === 'string' && typeof entry.at === 'number').slice(-TOUCHED_KEEP)
    : []
  const project = str(value.project)
  return {
    v: 1,
    id: value.id,
    label: str(value.label) || labelOf(project, value.id),
    project,
    tree: str(value.tree),
    branch: str(value.branch),
    isDirty: value.isDirty === true,
    task: str(value.task),
    touched,
    acked: Array.isArray(value.acked) ? value.acked.filter((id): id is string => typeof id === 'string').slice(-ACKED_KEEP) : [],
    startedAt: num(value.startedAt),
    updatedAt: num(value.updatedAt),
    ended: value.ended === true,
  }
}

export const isPeerLive = (peer: SyncPeer | null | undefined, now: number): boolean => peer !== null && peer !== undefined && !peer.ended && now - peer.updatedAt <= STALE_MS

/** A file this session changed, newest last, each path once. */
export const touch = (touched: readonly { path: string; at: number }[], path: string, at: number): { path: string; at: number }[] =>
  [...touched.filter(entry => entry.path !== path), { path, at }].slice(-TOUCHED_KEEP)

// ── Leases ──────────────────────────────────────────────────────────────────────────────────────────

export function parseLeaseFile(value: unknown): SyncLeaseFile {
  const leases: Record<string, SyncLease> = {}
  if (isRecord(value) && isRecord(value.leases)) {
    for (const [key, entry] of Object.entries(value.leases)) {
      if (!isRecord(entry) || typeof entry.session !== 'string' || typeof entry.expiresAt !== 'number') continue
      leases[key] = {
        path: str(entry.path, key),
        rel: str(entry.rel, key),
        session: entry.session,
        label: str(entry.label),
        branch: str(entry.branch),
        task: str(entry.task),
        since: num(entry.since),
        renewedAt: num(entry.renewedAt),
        expiresAt: entry.expiresAt,
      }
    }
  }
  return { v: 1, leases }
}

/** A lease that still binds: not expired, and its session still running. */
export const isLeaseHeld = (lease: SyncLease | undefined, now: number, isLive: (session: string) => boolean): lease is SyncLease =>
  lease !== undefined && lease.expiresAt > now && isLive(lease.session)

export type LeaseDecision =
  | { kind: 'take' }
  | { kind: 'renew'; lease: SyncLease }
  | { kind: 'override'; holder: SyncLease }
  | { kind: 'deny'; holder: SyncLease }

/** What an edit of `key` by `me` does: take a free (or stale, or expired) lease, renew its own, or meet another's. */
export function decideLease(input: { file: SyncLeaseFile; key: string; me: string; now: number; isLive: (session: string) => boolean; isOverride: boolean }): LeaseDecision {
  const current = input.file.leases[input.key]
  if (current !== undefined && current.session === input.me) return { kind: 'renew', lease: current }
  if (!isLeaseHeld(current, input.now, input.isLive)) return { kind: 'take' }
  return input.isOverride ? { kind: 'override', holder: current } : { kind: 'deny', holder: current }
}

/** The file with `lease` in it and every lease that no longer binds dropped. */
export function withLease(file: SyncLeaseFile, lease: SyncLease, now: number, isLive: (session: string) => boolean): SyncLeaseFile {
  const leases: Record<string, SyncLease> = {}
  for (const [key, entry] of Object.entries(file.leases)) if (isLeaseHeld(entry, now, isLive)) leases[key] = entry
  leases[lease.path] = lease
  return { v: 1, leases }
}

/** The file without `me`'s leases (all, or the paths named). */
export function withoutLeasesOf(file: SyncLeaseFile, me: string, paths?: readonly string[]): SyncLeaseFile {
  const leases: Record<string, SyncLease> = {}
  for (const [key, entry] of Object.entries(file.leases)) if (entry.session !== me || (paths !== undefined && !paths.includes(key))) leases[key] = entry
  return { v: 1, leases }
}

/** `me` is active: each of its leases runs `ttl` from now. */
export function renewLeasesOf(file: SyncLeaseFile, me: string, now: number, ttlMs: number): SyncLeaseFile {
  const leases: Record<string, SyncLease> = {}
  for (const [key, entry] of Object.entries(file.leases)) leases[key] = entry.session === me ? { ...entry, renewedAt: now, expiresAt: now + ttlMs } : entry
  return { v: 1, leases }
}

export const leasesOf = (file: SyncLeaseFile, session: string): SyncLease[] => Object.values(file.leases).filter(lease => lease.session === session)

const clockTime = (at: number): string => {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

const ago = (ms: number): string => (ms < 60_000 ? 'just now' : `${Math.floor(ms / 60_000)} min ago`)

/** The refusal the model reads, with who holds the file and what the person can do. */
export function denyMessage(holder: SyncLease, now: number): string {
  return [
    `session-sync: ${holder.rel} is being edited by another Claude session on this repo, ${holder.label}${holder.branch === '' ? '' : ` (branch ${holder.branch})`}${holder.task === '' ? '' : `, working on "${holder.task}"`}: it took the file at ${clockTime(holder.since)} and was last active ${ago(now - holder.renewedAt)}.`,
    `Do not edit ${holder.rel} now. Tell the person, and offer:`,
    `(1) wait: the lease ends at ${clockTime(holder.expiresAt)} unless that session keeps working, or when it ends;`,
    `(2) ask that session: the person types /sync ask ${holder.label} <message> (or uses Note in /mission);`,
    '(3) override: the person replies SYNC-OK in their next message, and you may then edit it in that turn.',
    'Meanwhile carry on with other files.',
  ].join('\n')
}

// ── Overlap and branches ────────────────────────────────────────────────────────────────────────────

export type Overlap = { peer: SyncPeer; dir: string; files: string[] }

/** Live sessions other than `me` that changed files in `dir` within the window. */
export function overlapsAt(dir: string, peers: readonly SyncPeer[], me: string, now: number, windowMs = OVERLAP_WINDOW_MS): Overlap[] {
  const found: Overlap[] = []
  for (const peer of peers) {
    if (peer.id === me || !isPeerLive(peer, now)) continue
    const files = peer.touched.filter(entry => now - entry.at <= windowMs && dirOf(entry.path) === dir).map(entry => entry.path)
    if (files.length > 0) found.push({ peer, dir, files })
  }
  return found
}

/** Folders and files two sessions both changed within the window. Heavy: 3+ folders, or 2+ same files. */
export function overlapWith(mine: readonly { path: string; at: number }[], peer: SyncPeer, now: number, windowMs = OVERLAP_WINDOW_MS): { dirs: string[]; files: string[]; isHeavy: boolean } {
  const recent = (list: readonly { path: string; at: number }[]) => list.filter(entry => now - entry.at <= windowMs).map(entry => entry.path)
  const myFiles = new Set(recent(mine))
  const theirFiles = recent(peer.touched)
  const myDirs = new Set([...myFiles].map(dirOf))
  const dirs = [...new Set(theirFiles.map(dirOf))].filter(dir => myDirs.has(dir))
  const files = theirFiles.filter(path => myFiles.has(path))
  return { dirs, files, isHeavy: dirs.length >= 3 || files.length >= 2 }
}

/** Live sessions on the same branch as `me` where both have uncommitted changes. */
export function sameBranchConflicts(me: { id: string; branch: string; isDirty: boolean }, peers: readonly SyncPeer[], now: number): SyncPeer[] {
  if (!me.isDirty || me.branch === '' || me.branch === 'HEAD') return []
  return peers.filter(peer => peer.id !== me.id && isPeerLive(peer, now) && peer.branch === me.branch && peer.isDirty)
}

export function overlapWarning(overlap: Overlap): string {
  const peer = overlap.peer
  return `${peer.label}${peer.branch === '' ? '' : ` (${peer.branch})`} is also changing ${overlap.dir === '.' ? 'the repository root' : `${overlap.dir}/`} (${overlap.files.slice(0, 4).join(', ')}${overlap.files.length > 4 ? ', …' : ''})${peer.task === '' ? '' : `: "${peer.task}"`}.`
}

export const overlapContext = (overlap: Overlap): string =>
  `session-sync: another Claude session on this repo, ${overlapWarning(overlap)} Keep to your own files there; if you need one of theirs, stop and tell the person rather than editing it.`

export function branchWarning(peer: SyncPeer, myTree: string, branch: string): string {
  return peer.tree === myTree
    ? `${peer.label} works in this same checkout on ${branch}, and there are uncommitted changes: a commit from either session sweeps in the other's edits. Give one of them its own git worktree.`
    : `${peer.label} is also on ${branch} with uncommitted changes (another checkout): your pushes will collide. Use separate branches.`
}

// ── Hand-offs and the inbox ─────────────────────────────────────────────────────────────────────────

export function composeHandoff(input: {
  from: string
  branch: string
  isDirty: boolean
  task: string
  touched: readonly string[]
  released: readonly string[]
  message: string
  overlap?: { dirs: string[]; isHeavy: boolean }
}): string {
  const lines = [
    `Hand-off from ${input.from}, another Claude session on this repo (sent by the person with /handoff-to):`,
    input.message.trim() === '' ? 'Please take over this work.' : input.message.trim(),
    '',
    `Its context: branch ${input.branch || 'unknown'}${input.isDirty ? ' with uncommitted changes' : ''}${input.task === '' ? '' : `; it was working on "${input.task}"`}.`,
  ]
  if (input.touched.length > 0) lines.push(`Files it changed lately: ${input.touched.slice(-12).join(', ')}.`)
  if (input.released.length > 0) lines.push(`It released its leases on: ${input.released.slice(0, 12).join(', ')}.`)
  if (input.overlap?.isHeavy === true) {
    lines.push(
      `Your two sessions overlap heavily (${input.overlap.dirs.slice(0, 6).join(', ')}): run the overlapping part in a subagent with isolation: "worktree", or in a separate git worktree, so the edits cannot clobber each other.`,
    )
  }
  return lines.join('\n')
}

export function parseMessage(value: unknown): SyncMessage | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.at !== 'number' || typeof value.text !== 'string') return null
  const kinds: readonly SyncMessageKind[] = ['handoff', 'ask', 'overridden']
  if (!kinds.includes(value.kind as SyncMessageKind)) return null
  const from = isRecord(value.from) ? { session: str(value.from.session), label: str(value.from.label), branch: str(value.from.branch) } : { session: '', label: '', branch: '' }
  return { id: value.id, at: value.at, kind: value.kind as SyncMessageKind, from, text: value.text.slice(0, TEXT_CHARS) }
}

export function parseMessages(text: string): SyncMessage[] {
  const messages: SyncMessage[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const message = parseMessage(JSON.parse(line))
      if (message !== null) messages.push(message)
    } catch {
      // A line cut by a concurrent write.
    }
  }
  return messages
}

export const pendingMessages = (messages: readonly SyncMessage[], acked: readonly string[], now: number): SyncMessage[] =>
  messages.filter(message => !acked.includes(message.id) && now - message.at <= MESSAGE_TTL_MS).sort((a, b) => a.at - b.at)

export function appendMessage(existing: string, message: SyncMessage, acked: readonly string[], now: number): string {
  const kept = parseMessages(existing).filter(old => !acked.includes(old.id) && now - old.at <= MESSAGE_TTL_MS)
  return [...kept, message].map(entry => JSON.stringify(entry)).join('\n') + '\n'
}

export const remember = (acked: readonly string[], id: string): string[] => [...acked.filter(one => one !== id), id].slice(-ACKED_KEEP)

// ── Words ───────────────────────────────────────────────────────────────────────────────────────────

/** The person's override word, in a prompt they typed. */
export const hasSyncOk = (text: string): boolean => /\bSYNC-OK\b/.test(text)

/** The live session a name points at: its label, the start of its id, or its branch when only one is on it. */
export function resolvePeer(peers: readonly SyncPeer[], who: string): SyncPeer | string {
  const name = who.trim().replace(/^#/, '').toLowerCase()
  if (name === '') return 'Name a session: its label (shop#a1b2), the start of its id, or its branch.'
  const exact = peers.find(peer => peer.label.toLowerCase() === name)
  if (exact !== undefined) return exact
  const byId = peers.filter(peer => peer.id.toLowerCase().startsWith(name) || peer.label.toLowerCase().endsWith(`#${name}`))
  if (byId.length === 1 && byId[0] !== undefined) return byId[0]
  const byBranch = peers.filter(peer => peer.branch.toLowerCase() === name)
  if (byBranch.length === 1 && byBranch[0] !== undefined) return byBranch[0]
  const matches = byId.length > 1 ? byId : byBranch
  if (matches.length > 1) return `"${who}" matches ${matches.map(peer => peer.label).join(', ')}: use the label.`
  return peers.length === 0 ? 'No other live session on this repo.' : `No live session "${who}" on this repo. Sessions: ${peers.map(peer => `${peer.label} (${peer.branch})`).join(', ')}.`
}

export type SyncArgs = { kind: 'status' } | { kind: 'release' } | { kind: 'ask'; who: string; text: string } | { kind: 'error'; message: string }

export const SYNC_USAGE = 'Usage: /sync [status | ask <session> <message> | release]   ·   /handoff-to <session> [message]'

export function parseSyncArgs(args: string): SyncArgs {
  const trimmed = args.trim()
  const [verb = '', who = ''] = trimmed.split(/\s+/)
  switch (verb.toLowerCase()) {
    case '':
    case 'status':
    case 'leases':
      return { kind: 'status' }
    case 'release':
      return { kind: 'release' }
    case 'ask': {
      const text = trimmed.replace(/^ask\s+\S+\s*/i, '')
      return who === '' || text === '' ? { kind: 'error', message: '/sync ask needs a session and a message.' } : { kind: 'ask', who, text }
    }
    default:
      return { kind: 'error', message: `Unknown "${verb}".` }
  }
}

export function parseHandoffArgs(args: string): { who: string; message: string } | string {
  const trimmed = args.trim()
  const [who = ''] = trimmed.split(/\s+/)
  if (who === '') return 'Usage: /handoff-to <session> [message] — the session is a label from /sync (shop#a1b2), the start of its id, or its branch.'
  return { who, message: trimmed.slice(who.length).trim() }
}
