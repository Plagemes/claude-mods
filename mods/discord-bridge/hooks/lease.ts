/** The lease is renewed this often by the leader... */
export const LEASE_RENEW_MS = 10_000
/** ...and taken over by another session once it is this stale. */
export const LEASE_STALE_MS = 30_000
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

/** Remembers `keys` as handled, newest last, keeping the set bounded. */
export const remember = (seen: readonly string[], keys: readonly string[]): string[] => {
  const merged = [...seen.filter(key => !keys.includes(key)), ...keys]
  return merged.length > SEEN_CAP ? merged.slice(-SEEN_CAP) : merged
}

/** The wait after a 429 or a transport error: Retry-After seconds when given, else doubling up to five minutes. */
export const backoff = (previousMs: number, retryAfterSeconds: number | undefined): number => {
  if (retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) return Math.min(MAX_BACKOFF_MS, retryAfterSeconds * 1000)
  return Math.min(MAX_BACKOFF_MS, previousMs <= 0 ? 10_000 : previousMs * 2)
}

/**
 * How long the leader waits between polls: the base while someone is away, a question is open or a message came in
 * lately, three times that otherwise, so an idle channel costs few requests (Slack and Discord rate-limit reads).
 */
export const pollInterval = (input: { baseSeconds: number; isBusy: boolean }): number => input.baseSeconds * 1000 * (input.isBusy ? 1 : 3)
