import { expect, test } from 'claude-code/testing'

import {
  OVERLAP_WINDOW_MS,
  appendMessage,
  composeHandoff,
  decideLease,
  denyMessage,
  dirOf,
  hasSyncOk,
  normalizeRemote,
  overlapWith,
  overlapsAt,
  parseHandoffArgs,
  parseLeaseFile,
  parseMessages,
  parseStatus,
  parseSyncArgs,
  pendingMessages,
  relativeTo,
  renewLeasesOf,
  repoKey,
  resolvePath,
  resolvePeer,
  sameBranchConflicts,
  withLease,
  withoutLeasesOf,
} from '../hooks/sync'
import type { SyncLease, SyncLeaseFile, SyncMessage, SyncPeer } from '../types'

const NOW = new Date(2026, 9, 7, 12, 0, 0).getTime()
const MINUTE = 60_000

const peer = (id: string, patch: Partial<SyncPeer> = {}): SyncPeer => ({
  v: 1,
  id,
  label: `shop#${id.slice(0, 4)}`,
  project: 'shop',
  tree: '/work/shop',
  branch: 'main',
  isDirty: false,
  task: '',
  touched: [],
  acked: [],
  startedAt: NOW - 60 * MINUTE,
  updatedAt: NOW - 5_000,
  ended: false,
  ...patch,
})

const lease = (path: string, session: string, patch: Partial<SyncLease> = {}): SyncLease => ({
  path,
  rel: path.replace('/work/shop/', ''),
  session,
  label: `shop#${session.slice(0, 4)}`,
  branch: 'main',
  task: 'Add login',
  since: NOW - 4 * MINUTE,
  renewedAt: NOW - MINUTE,
  expiresAt: NOW + 9 * MINUTE,
  ...patch,
})

test('a repository is one folder whatever the remote spelling; git status gives the branch and dirtiness', () => {
  expect(normalizeRemote('git@github.com:Acme/Shop.git')).toBe('github.com/acme/shop')
  expect(normalizeRemote('https://user:token@github.com/acme/shop')).toBe('github.com/acme/shop')
  expect(normalizeRemote('ssh://git@git.acme.io:2222/acme/shop.git/')).toBe('git.acme.io/acme/shop')
  expect(repoKey('git@github.com:acme/shop.git', '/a')).toBe(repoKey('https://github.com/acme/shop', '/b'))
  expect(repoKey('git@github.com:acme/shop.git', '/a')).toMatch(/^shop-[0-9a-f]{8}$/)
  expect(repoKey(null, '/work/shop')).not.toBe(repoKey(null, '/work/shop-copy'))

  expect(parseStatus('## main...origin/main [ahead 1]\n M src/a.ts\n?? notes.md\n')).toEqual({ branch: 'main', isDirty: true })
  expect(parseStatus('## feature/login\n')).toEqual({ branch: 'feature/login', isDirty: false })
  expect(parseStatus('## HEAD (no branch)\n')).toEqual({ branch: 'HEAD', isDirty: false })
  expect(parseStatus('## No commits yet on main\n')).toEqual({ branch: 'main', isDirty: false })

  expect(resolvePath('/work/shop/src', '../lib/./a.ts')).toBe('/work/shop/lib/a.ts')
  expect(relativeTo('/work/shop', '/work/shop/src/a.ts')).toBe('src/a.ts')
  expect(relativeTo('/work/shop', '/work/shop-other/a.ts')).toBeUndefined()
  expect(relativeTo('/work/shop', '/work/shop/.git/config')).toBeUndefined()
  expect(dirOf('src/api/user.ts')).toBe('src/api')
  expect(dirOf('README.md')).toBe('.')
})

test('leases: take a free one, renew your own, meet a live one, override it, take an expired or orphaned one', () => {
  const live = new Set(['me', 'peer'])
  const isLive = (session: string) => live.has(session)
  const path = '/work/shop/src/api/user.ts'
  const held: SyncLeaseFile = { v: 1, leases: { [path]: lease(path, 'peer') } }
  const decide = (file: SyncLeaseFile, isOverride = false, liveness = isLive, now = NOW) => decideLease({ file, key: path, me: 'me', now, isLive: liveness, isOverride })

  expect(decide({ v: 1, leases: {} }).kind).toBe('take')
  expect(decide({ v: 1, leases: { [path]: lease(path, 'me') } }).kind).toBe('renew')
  expect(decide(held)).toMatchObject({ kind: 'deny', holder: { session: 'peer' } })
  expect(decide(held, true)).toMatchObject({ kind: 'override', holder: { session: 'peer' } })
  expect(decide(held, false, isLive, NOW + 10 * MINUTE).kind).toBe('take')
  expect(decide(held, false, session => session === 'me').kind).toBe('take')

  const mine = lease('/work/shop/src/a.ts', 'me')
  const crowded: SyncLeaseFile = {
    v: 1,
    leases: { [path]: lease(path, 'peer'), old: lease('old', 'peer', { expiresAt: NOW - 1 }), ghost: lease('ghost', 'gone') },
  }
  const after = withLease(crowded, mine, NOW, isLive)
  expect(Object.keys(after.leases).sort()).toEqual(['/work/shop/src/a.ts', path])
  expect(renewLeasesOf(after, 'me', NOW + MINUTE, 10 * MINUTE).leases[mine.path]?.expiresAt).toBe(NOW + 11 * MINUTE)
  expect(renewLeasesOf(after, 'me', NOW + MINUTE, 10 * MINUTE).leases[path]?.expiresAt).toBe(NOW + 9 * MINUTE)
  expect(Object.keys(withoutLeasesOf(after, 'me').leases)).toEqual([path])
  expect(parseLeaseFile(JSON.parse(JSON.stringify(after)))).toEqual(after)

  const message = denyMessage(lease(path, 'peer'), NOW)
  expect(message).toContain('src/api/user.ts is being edited by another Claude session on this repo, shop#peer (branch main), working on "Add login"')
  expect(message).toContain('/sync ask shop#peer')
  expect(message).toContain('SYNC-OK')
  expect(hasSyncOk('ok SYNC-OK go')).toBe(true)
  expect(hasSyncOk('sync-ok')).toBe(false)
})

test('overlap: another live session in the same folder lately; heavy at three folders or two shared files; same dirty branch', () => {
  const busy = peer('peer0001', { touched: [{ path: 'src/api/auth.ts', at: NOW - 5 * MINUTE }, { path: 'src/api/user.ts', at: NOW - 6 * MINUTE }, { path: 'docs/old.md', at: NOW - OVERLAP_WINDOW_MS - 1 }] })
  const gone = peer('gone0001', { ended: true, touched: [{ path: 'src/api/x.ts', at: NOW }] })
  expect(overlapsAt('src/api', [busy, gone], 'me', NOW)).toEqual([{ peer: busy, dir: 'src/api', files: ['src/api/auth.ts', 'src/api/user.ts'] }])
  expect(overlapsAt('docs', [busy], 'me', NOW)).toEqual([])

  const light = overlapWith([{ path: 'src/api/auth.ts', at: NOW }], busy, NOW)
  expect(light).toEqual({ dirs: ['src/api'], files: ['src/api/auth.ts'], isHeavy: false })
  expect(overlapWith([{ path: 'src/api/auth.ts', at: NOW }, { path: 'src/api/user.ts', at: NOW }], busy, NOW).isHeavy).toBe(true)

  const dirty = peer('peer0002', { isDirty: true })
  expect(sameBranchConflicts({ id: 'me', branch: 'main', isDirty: true }, [dirty, busy], NOW)).toEqual([dirty])
  expect(sameBranchConflicts({ id: 'me', branch: 'main', isDirty: false }, [dirty], NOW)).toEqual([])
  expect(sameBranchConflicts({ id: 'me', branch: 'feature', isDirty: true }, [dirty], NOW)).toEqual([])
  expect(sameBranchConflicts({ id: 'me', branch: 'main', isDirty: true }, [{ ...dirty, updatedAt: NOW - MINUTE }], NOW)).toEqual([])
})

test('hand-offs and the inbox: the note carries the context and suggests a worktree when overlap is heavy; each message once', () => {
  const note = composeHandoff({
    from: 'shop#a1b2',
    branch: 'main',
    isDirty: true,
    task: 'Add login',
    touched: ['src/api/auth.ts', 'src/api/user.ts'],
    released: ['src/api/user.ts'],
    message: 'finish the API tests',
    overlap: { dirs: ['src/api', 'src/ui', 'tests'], isHeavy: true },
  })
  expect(note).toContain('Hand-off from shop#a1b2')
  expect(note).toContain('finish the API tests')
  expect(note).toContain('branch main with uncommitted changes; it was working on "Add login"')
  expect(note).toContain('It released its leases on: src/api/user.ts.')
  expect(note).toContain('isolation: "worktree"')
  expect(composeHandoff({ from: 'x', branch: 'main', isDirty: false, task: '', touched: [], released: [], message: '' })).not.toContain('worktree')

  const message = (id: string, at: number): SyncMessage => ({ id, at, kind: 'ask', from: { session: 'peer', label: 'shop#peer', branch: 'main' }, text: 'release user.ts?' })
  const file = [message('a', NOW - 40 * MINUTE), message('b', NOW - MINUTE), message('c', NOW - 2 * MINUTE)].map(entry => JSON.stringify(entry)).join('\n') + '\n{"broken'
  expect(pendingMessages(parseMessages(file), ['b'], NOW).map(entry => entry.id)).toEqual(['c'])
  expect(parseMessages(appendMessage(file, message('d', NOW), ['b'], NOW)).map(entry => entry.id)).toEqual(['c', 'd'])

  const peers = [peer('b2c3d4e5', { branch: 'feature/api' }), peer('c3d4e5f6')]
  expect(resolvePeer(peers, 'shop#b2c3')).toMatchObject({ id: 'b2c3d4e5' })
  expect(resolvePeer(peers, 'feature/api')).toMatchObject({ id: 'b2c3d4e5' })
  expect(resolvePeer(peers, 'c3d4')).toMatchObject({ id: 'c3d4e5f6' })
  expect(resolvePeer([], 'x')).toBe('No other live session on this repo.')
  expect(parseSyncArgs('ask shop#b2c3  can I take user.ts?')).toEqual({ kind: 'ask', who: 'shop#b2c3', text: 'can I take user.ts?' })
  expect(parseSyncArgs('').kind).toBe('status')
  expect(parseHandoffArgs('b2c3 finish the API tests')).toEqual({ who: 'b2c3', message: 'finish the API tests' })
  expect(typeof parseHandoffArgs('  ')).toBe('string')
})
