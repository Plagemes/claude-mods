/**
 * The lease: of the sessions running at once, one (the leader) refreshes the calendar and tells the hub; the others
 * follow. Copied from whatsapp-bridge's poller (same files, same rules): the leader renews its lease every beat,
 * and a session takes a missing or stale lease.
 */

/** The leader renews its lease this often... */
export const LEASE_RENEW_MS = 10_000
/** ...and another session takes it over once it is this stale. */
export const LEASE_STALE_MS = 30_000

export type Lease = { sessionId: string; heartbeatAt: number; since: number }

/** What a session does with the lease on a beat: renew its own, take a missing or stale one, or follow. */
export const leaseAction = (lease: Lease | null, me: string, now: number): 'renew' | 'take' | 'follow' => {
  if (lease === null || now - lease.heartbeatAt > LEASE_STALE_MS) return 'take'
  return lease.sessionId === me ? 'renew' : 'follow'
}

export const parseLease = (value: unknown): Lease | null => {
  if (typeof value !== 'object' || value === null) return null
  const lease = value as Partial<Lease>
  return typeof lease.sessionId === 'string' && typeof lease.heartbeatAt === 'number'
    ? { sessionId: lease.sessionId, heartbeatAt: lease.heartbeatAt, since: typeof lease.since === 'number' ? lease.since : lease.heartbeatAt }
    : null
}
