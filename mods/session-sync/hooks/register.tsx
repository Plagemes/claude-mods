import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput, Timer } from 'claude-code'

import type { SyncLease, SyncLeaseFile, SyncMessage, SyncMessageKind, SyncPeer, SyncView } from '../types'
import {
  SYNC_USAGE,
  appendMessage,
  branchWarning,
  composeHandoff,
  decideLease,
  denyMessage,
  dirOf,
  hasSyncOk,
  isPeerLive,
  labelOf,
  leasesOf,
  oneLine,
  overlapContext,
  overlapWarning,
  overlapWith,
  overlapsAt,
  parseHandoffArgs,
  parseLeaseFile,
  parseMessages,
  parsePeer,
  parseStatus,
  parseSyncArgs,
  pendingMessages,
  relativeTo,
  remember,
  renewLeasesOf,
  repoKey,
  resolvePath,
  resolvePeer,
  sameBranchConflicts,
  touch,
  withLease,
  withoutLeasesOf,
} from './sync'

// ── Constants ───────────────────────────────────────────────────────────────────────────────────────

const NAME = 'session-sync'
const DIR = '.claude/claude-mods/sync'
const TICK_MS = 10_000
const INBOX_MS = 3_000
const GIT_MS = 30_000
const GIT_TIMEOUT_MS = 3_000
/** A lease of this session's own is rewritten at most this often by its edits (the tick renews it anyway). */
const RENEW_WRITE_MS = 60_000
const MINUTE_MS = 60_000
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])
const EDIT_TOOLS = /^(?:Edit|MultiEdit|Write|NotebookEdit)$/
const MISSION_PANE = 'mission-control'
const HUB_PANE = 'claude-mods'
const MISSION_TAB = 'mission'
const OVERRIDE_CONTEXT = 'session-sync: the person said SYNC-OK: this turn you may edit files another session on this repo holds a lease on; that session is told.'

const EMPTY_VIEW: SyncView = { repo: '', me: '', branch: '', isDirty: false, peers: [], myLeases: [], warnings: [], at: 0 }
const viewAtom = atom({ plugin: 'session-sync', key: 'view' } as const, EMPTY_VIEW)

// ── The per-load runtime ────────────────────────────────────────────────────────────────────────────

type Runtime = {
  ttlMs: number
  isGuarding: boolean
  isWarning: boolean
  showStatus: boolean
  /** sync/<repo key>; '' outside a git repository (the mod then does nothing). */
  dir: string
  repo: string
  me: string
  cwd: string
  tree: string
  self: SyncPeer
  /** The person typed SYNC-OK for the turn about to start; `isOverride` while that turn runs. */
  isArmed: boolean
  isOverride: boolean
  turnId: string | undefined
  isSubmitting: boolean
  queue: SyncMessage[]
  lastActivityAt: number
  lastRenewAt: number
  lastGitAt: number
  warned: Set<string>
  pendingContext: string[]
  warnings: string[]
  shownStatus: string | undefined | null
  seq: number
  isPolling: boolean
  timers: Timer[]
}

const blankPeer = (): SyncPeer => ({ v: 1, id: '', label: '', project: '', tree: '', branch: '', isDirty: false, task: '', touched: [], acked: [], startedAt: 0, updatedAt: 0, ended: false })

const newRuntime = (options: Record<string, unknown>): Runtime => ({
  ttlMs: Math.max(1, Number(options.leaseMinutes ?? 10)) * MINUTE_MS,
  isGuarding: options.leases !== false,
  isWarning: options.warnings !== false,
  showStatus: options.statusLine !== false,
  dir: '',
  repo: '',
  me: '',
  cwd: '',
  tree: '',
  self: blankPeer(),
  isArmed: false,
  isOverride: false,
  turnId: undefined,
  isSubmitting: false,
  queue: [],
  lastActivityAt: 0,
  lastRenewAt: 0,
  lastGitAt: 0,
  warned: new Set(),
  pendingContext: [],
  warnings: [],
  shownStatus: null,
  seq: 0,
  isPolling: false,
  timers: [],
})

const paths = {
  leases: (rt: Runtime): string => `${rt.dir}/leases.json`,
  sessions: (rt: Runtime): string => `${rt.dir}/sessions`,
  session: (rt: Runtime, id: string): string => `${rt.dir}/sessions/${id}.json`,
  inbox: (rt: Runtime, id: string): string => `${rt.dir}/inbox/${id}.jsonl`,
}

const ONLY_PERSON = 'session-sync sends to other sessions only when you type the command yourself.'
/** Typed by the person: at the keyboard, from the phone bridge, or a plugin relaying their own words. */
const isPersonOrigin = (origin: { kind: string; asUser?: boolean }): boolean => PERSON_ORIGINS.has(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// ── Files ───────────────────────────────────────────────────────────────────────────────────────────

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

async function readJson($: EngineInterface, path: string): Promise<unknown> {
  const text = await readText($, path)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

async function writeText($: EngineInterface, path: string, text: string): Promise<boolean> {
  try {
    await $.fs.write(path, text)
    return true
  } catch (error) {
    $.ui.log(`${NAME}: could not write ${path}: ${messageOf(error)}`, { to: 'debug' })
    return false
  }
}

async function readLeases($: EngineInterface, rt: Runtime): Promise<SyncLeaseFile> {
  return parseLeaseFile(await readJson($, paths.leases(rt)))
}

async function writeLeases($: EngineInterface, rt: Runtime, file: SyncLeaseFile): Promise<boolean> {
  return writeText($, paths.leases(rt), `${JSON.stringify(file, null, 1)}\n`)
}

/** Every other session's file written in the last day, parsed (live or not: the caller decides). */
async function readPeers($: EngineInterface, rt: Runtime): Promise<SyncPeer[]> {
  const now = await $.clock.now()
  const entries = await $.fs.list(paths.sessions(rt)).catch(() => [])
  const peers: SyncPeer[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    if (entry.mtimeMs > 0 && now - entry.mtimeMs > 24 * 60 * MINUTE_MS) continue
    const id = entry.name.slice(0, -'.json'.length)
    if (id === rt.me) continue
    const peer = parsePeer(await readJson($, paths.session(rt, id)))
    if (peer !== null) peers.push(peer)
  }
  return peers
}

/** Where a path really lands (links resolved), for a file that may not exist yet. */
async function realPathOf($: EngineInterface, path: string): Promise<string> {
  const own = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  if (own?.realPath !== undefined) return own.realPath
  const cut = path.lastIndexOf('/')
  if (cut <= 0) return path
  const folder = await $.fs.stat(path.slice(0, cut), { resolve: true }).catch(() => undefined)
  return folder?.realPath === undefined ? path : `${folder.realPath.replace(/\/$/, '')}/${path.slice(cut + 1)}`
}

async function git($: EngineInterface, rt: Runtime, args: readonly string[]): Promise<string | undefined> {
  try {
    const ran = await $.process.run(['git', ...args], { cwd: rt.cwd, timeoutMs: GIT_TIMEOUT_MS })
    return ran.exitCode === 0 ? ran.stdout : undefined
  } catch {
    return undefined
  }
}

// ── The session in its repository ───────────────────────────────────────────────────────────────────

async function startSession($: EngineInterface, rt: Runtime): Promise<void> {
  const now = await $.clock.now()
  await $.command.register({
    name: 'sync',
    description: 'Shows the other Claude sessions on this repo, their branches, files and leases; ask one something, or release your leases.',
    argumentHint: '[status | ask <session> <message> | release]',
  })
  await $.command.register({
    name: 'handoff-to',
    description: 'Hands your work over to another Claude session on this repo: it gets a note with your context as a prompt when it is idle.',
    argumentHint: '<session> [message]',
  })
  await hubHello($, { version: '1.0.0', publishes: ['x.session-sync.conflict', 'x.session-sync.handoff'], consumes: [] })
  rt.cwd = await $.session.cwd()
  rt.me = await $.session.id()
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  const top = (await git($, rt, ['rev-parse', '--show-toplevel']))?.trim()
  const repo = await $.session.repo().catch(() => null)
  if (home === undefined || home === '' || top === undefined || top === '') return
  rt.tree = top
  const key = repoKey(repo?.remote ?? null, repo?.root ?? top)
  rt.repo = key.slice(0, key.lastIndexOf('-'))
  rt.dir = `${home}/${DIR}/${key}`
  const project = (repo?.root ?? top).split('/').pop() || rt.repo
  rt.self = { ...blankPeer(), id: rt.me, label: labelOf(project, rt.me), project, tree: top, startedAt: now }
  for (const timer of rt.timers) timer.cancel()
  rt.timers = [$.clock.every(TICK_MS, () => void tick($, rt)), $.clock.every(INBOX_MS, () => void poll($, rt))]
  $.clock.after(0, () => void tick($, rt))
}

async function refreshGit($: EngineInterface, rt: Runtime): Promise<void> {
  rt.lastGitAt = await $.clock.now()
  const status = await git($, rt, ['status', '--porcelain', '--branch'])
  if (status === undefined) return
  const parsed = parseStatus(status)
  rt.self.branch = parsed.branch
  rt.self.isDirty = parsed.isDirty
}

async function writeSelf($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.dir === '') return
  rt.self.updatedAt = await $.clock.now()
  await writeText($, paths.session(rt, rt.me), JSON.stringify(rt.self))
}

/** Every 10 s: a new id after /clear, git status now and then, this session's file, its leases renewed while active, warnings. */
async function tick($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.dir === '') return
  try {
    const now = await $.clock.now()
    const id = await $.session.id().catch(() => rt.me)
    if (id !== '' && id !== rt.me) {
      await leaveRepo($, rt)
      rt.me = id
      rt.self = { ...rt.self, id, label: labelOf(rt.self.project, id), acked: [], ended: false, touched: [] }
    }
    if (now - rt.lastGitAt >= GIT_MS) await refreshGit($, rt)
    await writeSelf($, rt)
    if (rt.lastActivityAt > rt.lastRenewAt) {
      const file = await readLeases($, rt)
      if (leasesOf(file, rt.me).length > 0) await writeLeases($, rt, renewLeasesOf(file, rt.me, now, rt.ttlMs))
      rt.lastRenewAt = now
    }
    await checkBranches($, rt, now)
  } catch (error) {
    $.ui.log(`${NAME}: ${messageOf(error)}`, { to: 'debug' })
  }
}

/** Same branch, both with uncommitted changes: once per session and branch, a toast and a note for the model. */
async function checkBranches($: EngineInterface, rt: Runtime, now: number): Promise<void> {
  const peers = await readPeers($, rt)
  const warnings: string[] = []
  for (const peer of sameBranchConflicts({ id: rt.me, branch: rt.self.branch, isDirty: rt.self.isDirty }, peers, now)) {
    const text = branchWarning(peer, rt.tree, rt.self.branch)
    warnings.push(text)
    const key = `branch:${peer.id}:${rt.self.branch}`
    if (!rt.isWarning || rt.warned.has(key)) continue
    rt.warned.add(key)
    rt.pendingContext.push(`session-sync: ${text}`)
    await hubNotify($, { level: 'info', title: `⇆ ${text}`, audience: 'terminal', topic: 'x.session-sync.branch' })
  }
  rt.warnings = warnings
  await refreshView($, rt, peers, now)
}

async function refreshView($: EngineInterface, rt: Runtime, peers: readonly SyncPeer[], now: number): Promise<SyncView> {
  const file = await readLeases($, rt)
  const live = peers.filter(peer => isPeerLive(peer, now))
  const view: SyncView = {
    repo: rt.repo,
    me: rt.self.label,
    branch: rt.self.branch,
    isDirty: rt.self.isDirty,
    peers: live.map(peer => ({
      id: peer.id,
      label: peer.label,
      branch: peer.branch,
      isDirty: peer.isDirty,
      task: peer.task,
      files: peer.touched.filter(entry => now - entry.at <= 30 * MINUTE_MS).length,
      sameTree: peer.tree === rt.tree,
      leases: leasesOf(file, peer.id).filter(lease => lease.expiresAt > now).map(lease => lease.rel),
    })),
    myLeases: leasesOf(file, rt.me).map(lease => lease.rel),
    warnings: rt.warnings,
    at: now,
  }
  await update($, viewAtom, () => view)
  const n = live.length
  showStatus($, rt, n === 0 ? undefined : `⇆ ${n} other session${n === 1 ? '' : 's'} on this repo${rt.warnings.length > 0 ? ' · ⚠ same branch' : ''} · /sync`)
  return view
}

function showStatus($: EngineInterface, rt: Runtime, text: string | undefined): void {
  if (!rt.showStatus || text === rt.shownStatus) return
  rt.shownStatus = text
  $.ui.status(text)
}

/** The session ends (or /clear starts a new one): its leases go, its file says it ended. */
async function leaveRepo($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.dir === '' || rt.me === '') return
  const file = await readLeases($, rt)
  if (leasesOf(file, rt.me).length > 0) await writeLeases($, rt, withoutLeasesOf(file, rt.me))
  rt.self.ended = true
  await writeSelf($, rt)
}

// ── Leases: the guard on every edit ─────────────────────────────────────────────────────────────────

/** Takes or renews the lease on `path` for this session; the refusal text when another live session holds it. */
async function acquire($: EngineInterface, rt: Runtime, path: string, rel: string): Promise<string | undefined> {
  const now = await $.clock.now()
  const file = await readLeases($, rt)
  const peers = await readPeers($, rt)
  const live = new Set(peers.filter(peer => isPeerLive(peer, now)).map(peer => peer.id))
  const isLive = (session: string): boolean => session === rt.me || live.has(session)
  const decision = decideLease({ file, key: path, me: rt.me, now, isLive, isOverride: rt.isOverride })
  if (decision.kind === 'deny') {
    await hubPublish($, { topic: 'x.session-sync.conflict', data: { path: rel, holder: decision.holder.label, session: rt.self.label } })
    return denyMessage(decision.holder, now)
  }
  if (decision.kind === 'renew' && now - decision.lease.renewedAt < RENEW_WRITE_MS && decision.lease.expiresAt > now) return undefined
  const since = decision.kind === 'renew' ? decision.lease.since : now
  const lease: SyncLease = { path, rel, session: rt.me, label: rt.self.label, branch: rt.self.branch, task: rt.self.task, since, renewedAt: now, expiresAt: now + rt.ttlMs }
  await writeLeases($, rt, withLease(file, lease, now, isLive))
  // Two sessions taking the same file at once: the file says who won.
  const check = (await readLeases($, rt)).leases[path]
  if (check !== undefined && check.session !== rt.me && isLive(check.session)) return denyMessage(check, now)
  if (decision.kind === 'override') {
    const holder = decision.holder
    await sendMessage($, rt, holder.session, 'overridden', `${rt.self.label} took over ${rel} (the person said SYNC-OK there). Do not edit it again without asking the person.`)
    await hubNotify($, { level: 'info', title: `⇆ Took ${rel} over from ${holder.label} (SYNC-OK).`, audience: 'terminal' })
  }
  return undefined
}

/** After an edit went through: remember the file, and warn once when another session works in the same folder. */
async function afterEdit($: EngineInterface, rt: Runtime, rel: string): Promise<string | undefined> {
  const now = await $.clock.now()
  rt.self.touched = touch(rt.self.touched, rel, now)
  await writeSelf($, rt)
  if (!rt.isWarning) return undefined
  const fresh = overlapsAt(dirOf(rel), await readPeers($, rt), rt.me, now).filter(overlap => !rt.warned.has(`dir:${overlap.peer.id}:${overlap.dir}`))
  for (const overlap of fresh) {
    rt.warned.add(`dir:${overlap.peer.id}:${overlap.dir}`)
    await hubNotify($, { level: 'info', title: `⇆ ${overlapWarning(overlap)}`, audience: 'terminal', topic: 'x.session-sync.overlap' })
  }
  return fresh.length === 0 ? undefined : fresh.map(overlapContext).join('\n')
}

async function editedPath($: EngineInterface, rt: Runtime, input: Record<string, unknown>): Promise<{ path: string; rel: string } | undefined> {
  const raw = [input.file_path, input.notebook_path].find((value): value is string => typeof value === 'string' && value !== '')
  if (raw === undefined || rt.dir === '') return undefined
  const path = await realPathOf($, resolvePath(rt.cwd, raw))
  const rel = relativeTo(rt.tree, path)
  return rel === undefined ? undefined : { path, rel }
}

// ── Messages between sessions: hand-offs, questions, a lease taken over ─────────────────────────────

async function sendMessage($: EngineInterface, rt: Runtime, to: string, kind: SyncMessageKind, text: string): Promise<boolean> {
  const now = await $.clock.now()
  rt.seq += 1
  const message: SyncMessage = { id: `${rt.me.slice(0, 8)}-${now.toString(36)}-${rt.seq}`, at: now, kind, from: { session: rt.me, label: rt.self.label, branch: rt.self.branch }, text }
  const path = paths.inbox(rt, to)
  const acked = parsePeer(await readJson($, paths.session(rt, to)))?.acked ?? []
  return writeText($, path, appendMessage((await readText($, path)) ?? '', message, acked, now))
}

/** Every 3 s: new messages for this session; hand-offs and questions run as prompts once it is idle. */
async function poll($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.dir === '' || rt.isPolling) return
  rt.isPolling = true
  try {
    const text = await readText($, paths.inbox(rt, rt.me))
    if (text !== undefined) {
      const now = await $.clock.now()
      const fresh = pendingMessages(parseMessages(text), rt.self.acked, now)
      for (const message of fresh) {
        rt.self.acked = remember(rt.self.acked, message.id)
        if (message.kind === 'overridden') {
          rt.pendingContext.push(`session-sync: ${message.text}`)
          await hubNotify($, { level: 'info', title: `⇆ ${message.text}`, audience: 'terminal' })
        } else {
          rt.queue.push(message)
          $.ui.toast(`⇆ ${message.kind === 'handoff' ? 'Hand-off' : 'Message'} from ${message.from.label}${rt.turnId === undefined ? '' : ': it runs when Claude is idle'}.`)
        }
      }
      if (fresh.length > 0) await writeSelf($, rt)
    }
    await deliver($, rt)
  } catch (error) {
    $.ui.log(`${NAME}: ${messageOf(error)}`, { to: 'debug' })
  } finally {
    rt.isPolling = false
  }
}

async function deliver($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.turnId !== undefined || rt.isSubmitting) return
  const message = rt.queue.shift()
  if (message === undefined) return
  const text =
    message.kind === 'handoff'
      ? message.text
      : `Message from ${message.from.label}${message.from.branch === '' ? '' : ` (branch ${message.from.branch})`}, another Claude session on this repo, sent by the person with /sync ask:\n${message.text}`
  rt.isSubmitting = true
  // Not the person's SYNC-OK turn: a hand-off never inherits an override.
  rt.isArmed = false
  try {
    const submitted = await $.prompt.submit({ text, asUser: true })
    if (submitted.drop !== undefined) $.ui.toast(`The ${message.kind === 'handoff' ? 'hand-off' : 'message'} did not run: ${oneLine(submitted.drop, 120)}`)
  } catch (error) {
    $.ui.log(`${NAME}: ${messageOf(error)}`, { to: 'debug' })
  } finally {
    rt.isSubmitting = false
  }
}

// ── Commands ────────────────────────────────────────────────────────────────────────────────────────

async function livePeers($: EngineInterface, rt: Runtime): Promise<SyncPeer[]> {
  const now = await $.clock.now()
  return (await readPeers($, rt)).filter(peer => isPeerLive(peer, now))
}

async function runSync($: EngineInterface, rt: Runtime, args: string, isPerson: boolean): Promise<string> {
  if (rt.dir === '') return 'session-sync works inside a git repository; this session is not in one.'
  const parsed = parseSyncArgs(args)
  if (parsed.kind === 'error') return `${parsed.message}\n${SYNC_USAGE}`
  if (parsed.kind === 'ask' && !isPerson) return ONLY_PERSON
  if (parsed.kind === 'release') {
    const file = await readLeases($, rt)
    const mine = leasesOf(file, rt.me)
    if (mine.length > 0) await writeLeases($, rt, withoutLeasesOf(file, rt.me))
    return mine.length === 0 ? 'You hold no leases.' : `Released ${mine.length} lease${mine.length === 1 ? '' : 's'}: ${mine.map(lease => lease.rel).join(', ')}.`
  }
  if (parsed.kind === 'ask') {
    const target = resolvePeer(await livePeers($, rt), parsed.who)
    if (typeof target === 'string') return target
    return (await sendMessage($, rt, target.id, 'ask', parsed.text)) ? `Sent to ${target.label}: it runs there as a prompt when that session is idle.` : `Could not reach ${target.label}.`
  }
  const now = await $.clock.now()
  await refreshGit($, rt)
  const view = await refreshView($, rt, await readPeers($, rt), now)
  const lines = [
    `Repo ${view.repo} · this session ${view.me} on ${view.branch || '?'}${view.isDirty ? ', uncommitted changes' : ''}`,
    `Your leases: ${view.myLeases.length === 0 ? 'none' : view.myLeases.join(', ')}`,
    view.peers.length === 0 ? 'No other session on this repo.' : 'Other sessions here:',
    ...view.peers.map(
      peer =>
        `  ${peer.label} (${peer.branch || '?'}${peer.isDirty ? ', uncommitted' : ''}${peer.sameTree ? ', same checkout' : ''})${peer.task === '' ? '' : ` · "${peer.task}"`} · ${peer.files} file${peer.files === 1 ? '' : 's'} lately${peer.leases.length === 0 ? '' : ` · leases: ${peer.leases.join(', ')}`}`,
    ),
    ...view.warnings.map(warning => `⚠ ${warning}`),
  ]
  return lines.join('\n')
}

async function runHandoff($: EngineInterface, rt: Runtime, args: string): Promise<string> {
  if (rt.dir === '') return 'session-sync works inside a git repository; this session is not in one.'
  const parsed = parseHandoffArgs(args)
  if (typeof parsed === 'string') return parsed
  const target = resolvePeer(await livePeers($, rt), parsed.who)
  if (typeof target === 'string') return target
  const now = await $.clock.now()
  await refreshGit($, rt)
  const file = await readLeases($, rt)
  const released = leasesOf(file, rt.me).map(lease => lease.rel)
  if (released.length > 0) await writeLeases($, rt, withoutLeasesOf(file, rt.me))
  const overlap = overlapWith(rt.self.touched, target, now)
  const text = composeHandoff({
    from: rt.self.label,
    branch: rt.self.branch,
    isDirty: rt.self.isDirty,
    task: rt.self.task,
    touched: rt.self.touched.map(entry => entry.path),
    released,
    message: parsed.message,
    overlap,
  })
  if (!(await sendMessage($, rt, target.id, 'handoff', text))) return `Could not reach ${target.label}.`
  await hubPublish($, { topic: 'x.session-sync.handoff', data: { from: rt.self.label, to: target.label, files: rt.self.touched.length, isHeavyOverlap: overlap.isHeavy } })
  return `Hand-off sent to ${target.label}: it runs there as a prompt when that session is idle.${released.length === 0 ? '' : ` Released your ${released.length} lease${released.length === 1 ? '' : 's'}.`}${overlap.isHeavy ? ' Your sessions overlap heavily: the note suggests a worktree.' : ''}`
}

// ── The section in Mission Control ──────────────────────────────────────────────────────────────────

async function drawSection($: EngineInterface, e: RenderInput<'Pane'>): Promise<RenderElement | null> {
  const view = await read($, viewAtom)
  if (view.repo === '') return null
  const { Box, Text } = $.ui.resolve(e)
  return (
    <Box key="session-sync" flexDirection="column" marginTop={1}>
      <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
        <Text bold>{`Same repo · ${view.repo}`}</Text>
        <Text dimColor wrap="truncate-end">{`${view.me} on ${view.branch || '?'}${view.isDirty ? ' · uncommitted' : ''}`}</Text>
      </Box>
      {view.peers.length === 0 ? (
        <Text dimColor>No other session on this repo.</Text>
      ) : (
        view.peers.map(peer => (
          <Box key={`sync-${peer.id}`} flexDirection="column">
            <Text wrap="truncate-end">
              <Text color="claude">{'⇆ '}</Text>
              <Text bold>{peer.label}</Text>
              <Text dimColor>{` ${peer.branch || '?'}${peer.isDirty ? ' · uncommitted' : ''}${peer.sameTree ? ' · same checkout' : ''} · ${peer.files} file${peer.files === 1 ? '' : 's'} lately`}</Text>
            </Text>
            {peer.leases.length === 0 ? null : <Text dimColor wrap="truncate-end">{`  leases: ${peer.leases.join(', ')}`}</Text>}
          </Box>
        ))
      )}
      <Text dimColor wrap="truncate-end">{`Your leases: ${view.myLeases.length === 0 ? 'none' : view.myLeases.join(', ')}`}</Text>
      {view.warnings.map((warning, index) => (
        <Box key={`sync-warning-${index}`}>
          <Text color="warning" wrap="truncate-end">{`⚠ ${warning}`}</Text>
        </Box>
      ))}
    </Box>
  )
}

// ── Registration ────────────────────────────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  const rt = newRuntime(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      await startSession($, rt)
    } catch (error) {
      $.ui.log(`${NAME}: ${messageOf(error)}`, { to: 'debug' })
    }
    return started
  })

  on('session.end', async ($, e, next) => {
    // A /clear goes on under a new id: the next tick releases the old one's leases.
    if (e.reason === 'clear') return next(e)
    for (const timer of rt.timers) timer.cancel()
    await leaveRepo($, rt).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'sync' }, async ($, e) => ({ text: await runSync($, rt, e.args, isPersonOrigin(e.origin)) }))
  on('command.run', { command: 'handoff-to' }, async ($, e) => ({ text: isPersonOrigin(e.origin) ? await runHandoff($, rt, e.args) : ONLY_PERSON }))

  // SYNC-OK counts only when the person typed it, and only for the turn it starts (or the one it lands in).
  on('prompt.submit', async ($, e, next) => {
    const origin = e.origin
    const isPerson = PERSON_ORIGINS.has(origin.kind)
    const saysOk = isPerson && hasSyncOk(e.text)
    if (e.turnId !== undefined) {
      if (saysOk) rt.isOverride = true
    } else {
      rt.isArmed = saysOk
    }
    const notes = [...rt.pendingContext.splice(0), ...(saysOk ? [OVERRIDE_CONTEXT] : [])]
    return notes.length === 0 ? next(e) : next({ ...e, context: [...(e.context ?? []), ...notes] })
  })

  on('turn.start', async ($, e, next) => {
    rt.turnId = e.turnId
    rt.isOverride = rt.isArmed && hasSyncOk(e.text)
    rt.isArmed = false
    rt.lastActivityAt = await $.clock.now()
    if (e.text.trim() !== '') rt.self.task = oneLine(e.text.split('\n').find(line => line.trim() !== '') ?? '', 100)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      rt.turnId = undefined
      rt.isOverride = false
      $.clock.after(0, () => void deliver($, rt))
    }
    return result
  })

  on('tool.call', { tool: EDIT_TOOLS }, async ($, e, next) => {
    rt.lastActivityAt = await $.clock.now()
    const target = rt.isGuarding ? await editedPath($, rt, e as unknown as Record<string, unknown>) : undefined
    if (target === undefined) return next(e)
    const refusal = await acquire($, rt, target.path, target.rel)
    if (refusal !== undefined) return { deny: refusal }
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const note = await afterEdit($, rt, target.rel)
    return note === undefined ? ran : { ...ran, context: [...(ran.context ?? []), note] }
  })

  // Any other tool: the session is active, so its leases stay renewed.
  on('tool.call', async ($, e, next) => {
    if (!EDIT_TOOLS.test(String(e.tool))) rt.lastActivityAt = await $.clock.now()
    return next(e)
  })

  // A section of Mission Control: in its own pane, and in its tab of the hub's panel.
  on('ui.render', { component: 'Pane', requestId: MISSION_PANE }, async ($, e, next) => {
    const section = await drawSection($, e)
    if (section === null) return next(e)
    const { Box } = $.ui.resolve(e)
    // Beneath mission-control, what is below may be the engine's bare pane: the section stands alone then.
    let above: RenderElement | null = null
    try {
      above = await next(e)
    } catch {
      above = null
    }
    return (
      <Box flexDirection="column">
        {above}
        {section}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: HUB_PANE }, async ($, e, next) => {
    if (!(await hubTabIs($, MISSION_TAB))) return next(e)
    const section = await drawSection($, e)
    if (section === null) return next(e)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {await next(e)}
        {section}
      </Box>
    )
  })
}

// #region @vendored shared/hub-client.ts sha256:0acb840d81b7: edit the source, then run `node scripts/sync-shared.mjs`.
// mods-hub client (docs/MOD_CONTRACT.md): uses the hub when it is installed, keeps working when it is not.

type HubMods = EngineInterface['mods']

/** Publishes an event on the hub's bus; false when there is no hub or it refused the event. */
async function hubPublish($: EngineInterface, input: Parameters<HubMods['publish']>[0]): Promise<boolean> {
  try {
    await $.mods.publish(input)
    return true
  } catch {
    return false
  }
}

/**
 * Routes a notification through the hub (channels, silent, night, presence), or shows it as a toast when there is
 * no hub: `title — body`, for `fallback.timeoutMs` when given (the toast's own option).
 */
async function hubNotify($: EngineInterface, input: Parameters<HubMods['notify']>[0], fallback: { timeoutMs?: number } = {}): Promise<void> {
  try {
    await $.mods.notify(input)
  } catch {
    const text = input.body === undefined || input.body === '' ? input.title : `${input.title} — ${input.body}`
    if (fallback.timeoutMs === undefined) $.ui.toast(text)
    else $.ui.toast(text, { timeoutMs: fallback.timeoutMs })
  }
}

/** The global mode (presence, silent, night, interaction), or undefined when there is no hub. */
async function hubMode($: EngineInterface): Promise<Awaited<ReturnType<HubMods['mode']>> | undefined> {
  try {
    return await $.mods.mode()
  } catch {
    return undefined
  }
}

/** Announces this mod to the hub, with its panel tab when it has one; call once from `session.start`. */
async function hubHello($: EngineInterface, hello: Parameters<HubMods['hello']>[0], tab?: Parameters<HubMods['registerTab']>[0]): Promise<boolean> {
  try {
    await $.mods.hello(hello)
    if (tab !== undefined) await $.mods.registerTab(tab)
    return true
  } catch {
    return false
  }
}

/** Opens the shared panel on this mod's tab; false when there is no hub (open your own pane then). */
async function hubShowTab($: EngineInterface, id: string): Promise<boolean> {
  try {
    return (await $.mods.showTab({ id })).isPlaced
  } catch {
    return false
  }
}

/**
 * Stops, pauses or resumes the automatic work (`control.stop` / `control.pause` / `control.resume`) in this session
 * or, with `scope: 'all'`, in every session; false when there is no hub (stop what you run yourself then).
 */
async function hubStop($: EngineInterface, input: Parameters<HubMods['stop']>[0]): Promise<boolean> {
  try {
    await $.mods.stop(input)
    return true
  } catch {
    return false
  }
}

/** Puts a fact on the hub's blackboard as `<this mod>.<name>`; false when there is no hub or it refused the fact. */
async function hubShareFact($: EngineInterface, input: Parameters<HubMods['share']>[0]): Promise<boolean> {
  try {
    await $.mods.share(input)
    return true
  } catch {
    return false
  }
}

/** A fact from the hub's blackboard by its full key (`stack-detector.stack`); undefined when there is no hub or no such fact. */
async function hubReadFact($: EngineInterface, key: string): Promise<Awaited<ReturnType<HubMods['read']>> | undefined> {
  try {
    return (await $.mods.read({ key })) ?? undefined
  } catch {
    return undefined
  }
}

/** Whether the shared panel shows tab `id` now; read while drawing, it subscribes the drawing. */
async function hubTabIs($: EngineInterface, id: string): Promise<boolean> {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
  return value === id
}
// #endregion @vendored shared/hub-client.ts
