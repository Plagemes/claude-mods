/** The lease is renewed this often by the leader... */
export const LEASE_RENEW_MS = 10_000
/** ...and taken over by another session once it is this stale. */
export const LEASE_STALE_MS = 30_000
export const PAGE_LIMIT = 50
export const MAX_PAGES = 5
const SEEN_CAP = 2_000
const MAX_BACKOFF_MS = 5 * 60_000

export type Lease = { sessionId: string; heartbeatAt: number; since: number }

/** What a session does with the lease on a tick: renew its own, take a missing or stale one, or follow. */
export const leaseAction = (lease: Lease | null, me: string, now: number): 'renew' | 'take' | 'follow' => {
  if (lease === null || now - lease.heartbeatAt > LEASE_STALE_MS) return 'take'
  return lease.sessionId === me ? 'renew' : 'follow'
}

/** Whether another session holds the lease now: a leader whose beat was late (a suspended process) must not poll on. */
export const isLeaseTaken = (lease: Lease | null, me: string, now: number): boolean =>
  lease !== null && lease.sessionId !== me && now - lease.heartbeatAt <= LEASE_STALE_MS

export const parseLease = (value: unknown): Lease | null => {
  if (typeof value !== 'object' || value === null) return null
  const lease = value as Partial<Lease>
  return typeof lease.sessionId === 'string' && typeof lease.heartbeatAt === 'number'
    ? { sessionId: lease.sessionId, heartbeatAt: lease.heartbeatAt, since: typeof lease.since === 'number' ? lease.since : lease.heartbeatAt }
    : null
}

/** Where the leader stopped reading, per poll target: the newest row it processed. */
export type Cursor = { id: string; createdAt: string }

export type RowLike = { id: string; createdAt: string }

export type WalkStep<R extends RowLike> = {
  /** Rows newer than the cursor on this page, newest first. */
  fresh: R[]
  /** The cursor was found (or the history ended): stop paging. */
  isDone: boolean
  /** The row id to page from (`after=`) when not done. */
  after?: string
}

/**
 * One page of `GET /messages` (newest first) against the stored cursor: keeps the rows above the cursor and
 * says whether to fetch the next, older page. A cursor whose row is gone is passed by time instead.
 */
export const walkPage = <R extends RowLike>(page: readonly R[], cursor: Cursor, limit: number): WalkStep<R> => {
  const fresh: R[] = []
  for (const row of page) {
    if (row.id === cursor.id) return { fresh, isDone: true }
    if (row.createdAt < cursor.createdAt) return { fresh, isDone: true }
    fresh.push(row)
  }
  const last = page.at(-1)
  if (page.length < limit || last === undefined) return { fresh, isDone: true }
  return { fresh, isDone: false, after: last.id }
}

/** Remembers `keys` as handled, newest last, keeping the set bounded. */
export const remember = (seen: readonly string[], keys: readonly string[]): string[] => {
  const merged = [...seen.filter(key => !keys.includes(key)), ...keys]
  return merged.length > SEEN_CAP ? merged.slice(-SEEN_CAP) : merged
}

/**
 * How long the leader waits between polls: fast while someone is away, a question is open or a message
 * came in lately, slow otherwise, and slower again with more chats to poll one by one (a chat-scoped key),
 * so every local client stays under OpenWA's per-IP limit of 1000 requests an hour.
 */
export const pollInterval = (input: { baseSeconds: number; targets: number; isBusy: boolean }): number => {
  const base = input.baseSeconds * 1000 * (input.isBusy ? 1 : 3)
  return Math.max(base, input.targets * 4_000)
}

/** The wait after a 429 or a transport error: Retry-After when given, else doubling up to five minutes. */
export const backoff = (previousMs: number, retryAfter: string | undefined): number => {
  const seconds = Number(retryAfter)
  if (retryAfter !== undefined && Number.isFinite(seconds) && seconds > 0) return Math.min(MAX_BACKOFF_MS, seconds * 1000)
  return Math.min(MAX_BACKOFF_MS, previousMs <= 0 ? 10_000 : previousMs * 2)
}
