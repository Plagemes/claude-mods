// session-sync's shared formats, under ~/.claude/claude-mods/sync/<repo-key>/ (one folder per repository,
// keyed by its origin remote, or its root when it has none): who is here, who holds which file, and hand-offs.

/** sessions/<id>.json: one session working in this repository, written by that session alone. */
export type SyncPeer = {
  v: 1
  id: string
  /** `<branch>#<first 4 of the id>`: how messages and /handoff-to name the session. */
  label: string
  project: string
  /** The working tree the session edits (a worktree has its own). */
  tree: string
  branch: string
  /** Uncommitted changes in that working tree. */
  isDirty: boolean
  /** The last prompt, one line. */
  task: string
  /** Files it changed lately (relative to its tree), newest last. */
  touched: { path: string; at: number }[]
  /** Inbox entries handled. */
  acked: string[]
  startedAt: number
  updatedAt: number
  ended: boolean
}

/** A file lease: the session `session` is editing `path` (absolute) until `expiresAt`, renewed while it is active. */
export type SyncLease = {
  path: string
  /** The path relative to its tree, for messages. */
  rel: string
  session: string
  label: string
  branch: string
  task: string
  since: number
  renewedAt: number
  expiresAt: number
}

/** leases.json: every lease in the repository, read and written by every session in it. */
export type SyncLeaseFile = { v: 1; leases: Record<string, SyncLease> }

export type SyncMessageKind = 'handoff' | 'ask' | 'overridden'

/** One line of inbox/<id>.jsonl: a hand-off, a question, or a lease taken over. */
export type SyncMessage = {
  id: string
  at: number
  kind: SyncMessageKind
  from: { session: string; label: string; branch: string }
  text: string
}

/** What the Mission Control section and /sync show: this session and the others in the repository. */
export type SyncView = {
  repo: string
  me: string
  branch: string
  isDirty: boolean
  peers: { id: string; label: string; branch: string; isDirty: boolean; task: string; files: number; sameTree: boolean; leases: string[] }[]
  myLeases: string[]
  warnings: string[]
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-sync': {
      view: SyncView
    }
  }
}
