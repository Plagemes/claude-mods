import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput, Timer } from 'claude-code'

import type { DigestView } from '../types'
import type { ModsNotice } from '../types/mods-hub'
import { composeDigest } from './compose'
import type { Digest, DigestInput, Language, Period, Tone } from './compose'
import { LEASE_RENEW_MS, leaseAction, parseLease } from './lease'
import type { Lease } from './lease'
import { buildMime, parseRecipients, readResend, readSendgrid, readSmtp, resendRequest, sendgridRequest, smtpPlan, without } from './mail'
import type { Mail, SendResult } from './mail'
import { EMPTY_SCHED, afterAttempt, dueNow, parseSchedState, scheduleText, windowFor } from './schedule'
import type { Due, SchedState } from './schedule'
import { readSettings, readiness, secretsOf } from './settings'
import type { Settings } from './settings'
import { redactText } from './shared/secrets'
import type { SecretCategory } from './shared/secrets'
import { eventFromHub, eventFromNotice, gitLogArgv, mergeEvents, parseDaily, parseGitLog, parseJournal } from './sources'
import type { Commit, DigestEvent, Journal } from './sources'
import { addDays, dateKey, epochToWall, startOfDay } from './zones'
import { paneFailure } from './shared/render-safe'

const NAME = 'email-digest'
const PANE = 'email-digest'
const VERSION = '1.0.0'
const FILES_DIR = '.claude/claude-mods/email-digest'
const BEAT_MS = LEASE_RENEW_MS
const COLLECT_MS = 20_000
const EVENT_CAP = 300
const KEEP_DAYS = 9
const DAY_MS = 86_400_000
const GIT_TIMEOUT_MS = 20_000
const SMTP_TIMEOUT_MS = 100_000
const REDACTED: ReadonlySet<SecretCategory> = new Set<SecretCategory>(['secrets', 'cards', 'ibans', 'privateIps'])
const TONES: readonly Tone[] = ['client', 'manager', 'technical']
const LANGUAGES: readonly Language[] = ['en', 'it']
const USAGE = 'Usage: /digest [preview [daily|weekly] | send [daily|weekly] | recipients [a@x.com, b@y.com] | tone client|manager|technical | lang en|it | note <text> | status | setup]'
const SETUP_TEXT = [
  'email-digest sends one summary email per project, by Resend, SendGrid or SMTP. Set these in /config under email-digest:',
  '  1. provider and its key: resendApiKey, or sendgridApiKey, or smtpUrl (+ smtpUser, smtpPassword)',
  '  2. from: a sender on a domain your provider has verified, e.g. Acme Studio <digest@acme.com>',
  '  3. recipients (default for every project), or per project: /digest recipients ana@client.com, boss@acme.com',
  '  4. frequency: off (default: you send by hand with /digest send), daily, weekly or both',
  'Check what would go out with /digest preview, and send it with /digest send. Nothing is ever sent without a provider, a sender and recipients.',
].join('\n')

const EMPTY_VIEW: DigestView = {
  phase: 'idle',
  period: 'daily',
  tone: 'client',
  language: 'en',
  project: '',
  subject: '',
  preview: '',
  isEmpty: true,
  recipients: [],
  invalid: [],
  problem: '',
  message: '',
  messageTone: 'info',
  schedule: '',
  provider: '',
  lastSent: null,
  isEditing: false,
}

const viewAtom = atom({ plugin: 'email-digest', key: 'view' } as const, EMPTY_VIEW)
const leaderAtom = atom({ plugin: 'email-digest', key: 'isLeader' } as const, false)

/** Per-project choices, kept in config.json: the recipients and the voice of that project's digest. */
type ProjectConfig = { recipients?: string; tone?: Tone; language?: Language; note?: string }

/** One session's file: the hub events and AI cost it saw for its project, for the leader to read. */
type SessionFile = { id: string; root: string; project: string; updatedAt: number; events: DigestEvent[]; costByDay: Record<string, number>; cursor: string | null }

type LastSent = { at: number; period: string; count: number }

type Runtime = {
  settings: Settings
  dir: string
  home: string
  me: string
  root: string
  project: string
  /** A short hash of the project root: names this project's lease and state files. */
  key: string
  isInteractive: boolean
  isLeader: boolean
  leaseVerified: boolean
  state: SchedState
  lastSent: LastSent | null
  period: Period
  events: DigestEvent[]
  costByDay: Record<string, number>
  lastEventAt: number
  lastUsd: number
  /** The id of the last channel notice handled: the next drain acknowledges up to it. */
  cursor: string | null
  isDirty: boolean
  isSending: boolean
  isReadyLogged: boolean
  timers: Timer[]
}

const newRuntime = (settings: Settings): Runtime => ({
  settings,
  dir: '',
  home: '',
  me: '',
  root: '',
  project: '',
  key: '',
  isInteractive: false,
  isLeader: false,
  leaseVerified: false,
  state: EMPTY_SCHED,
  lastSent: null,
  period: 'daily',
  events: [],
  costByDay: {},
  lastEventAt: 0,
  lastUsd: 0,
  cursor: null,
  isDirty: false,
  isSending: false,
  isReadyLogged: false,
  timers: [],
})

const paths = {
  config: (rt: Runtime): string => `${rt.dir}/config.json`,
  state: (rt: Runtime): string => `${rt.dir}/state/${rt.key}.json`,
  lease: (rt: Runtime): string => `${rt.dir}/lease/${rt.key}.json`,
  sessions: (rt: Runtime): string => `${rt.dir}/sessions`,
  session: (rt: Runtime, id: string): string => `${rt.dir}/sessions/${id}.json`,
  outbox: (rt: Runtime): string => `${rt.dir}/outbox/message.eml`,
  daily: (rt: Runtime): string => `${rt.home}/.claude/claude-mods/smart-router/daily.json`,
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** A short non-cryptographic hash (FNV-1a) to name files after a path without putting the path in a name. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

const baseName = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'project'

// ── Files ──────────────────────────────────────────────────────────────────────────────────────────

async function readJson($: EngineInterface, path: string): Promise<unknown> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? (JSON.parse(text) as unknown) : undefined
  } catch {
    return undefined
  }
}

async function writeJson($: EngineInterface, path: string, value: unknown): Promise<void> {
  try {
    await $.fs.write(path, JSON.stringify(value, null, 1))
  } catch (error) {
    $.ui.log(`${NAME}: could not write ${path}: ${messageOf(error)}`, { to: 'debug' })
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

async function readConfig($: EngineInterface, rt: Runtime): Promise<ProjectConfig> {
  const file = await readJson($, paths.config(rt))
  const projects = isRecord(file) && isRecord(file.projects) ? file.projects : {}
  const mine = projects[rt.root]
  if (!isRecord(mine)) return {}
  return {
    ...(typeof mine.recipients === 'string' ? { recipients: mine.recipients } : {}),
    ...(typeof mine.tone === 'string' && (TONES as readonly string[]).includes(mine.tone) ? { tone: mine.tone as Tone } : {}),
    ...(typeof mine.language === 'string' && (LANGUAGES as readonly string[]).includes(mine.language) ? { language: mine.language as Language } : {}),
    ...(typeof mine.note === 'string' && mine.note !== '' ? { note: mine.note } : {}),
  }
}

/** Changes this project's entry in config.json and leaves the others as they are. */
async function writeConfig($: EngineInterface, rt: Runtime, change: (current: ProjectConfig) => ProjectConfig): Promise<ProjectConfig> {
  const file = await readJson($, paths.config(rt))
  const projects: Record<string, unknown> = isRecord(file) && isRecord(file.projects) ? { ...file.projects } : {}
  const next = change(await readConfig($, rt))
  projects[rt.root] = next
  await writeJson($, paths.config(rt), { version: 1, projects })
  return next
}

// ── Hub, softly ────────────────────────────────────────────────────────────────────────────────────

async function hubRecent($: EngineInterface, since: number): Promise<{ topic: string; data: unknown; at: number }[]> {
  try {
    return await $.mods.recent({ since, limit: 100 })
  } catch {
    return []
  }
}

/** The notices queued for the email channel after the cursor (the id of the last one handled; the hub drops those up to it). */
async function hubDrain($: EngineInterface, after: string | null): Promise<ModsNotice[]> {
  try {
    return await $.mods.drain({ channel: 'email', after })
  } catch {
    return []
  }
}

async function hubSessionUsd($: EngineInterface): Promise<number | undefined> {
  try {
    const latest = await $.mods.latest({ topic: 'cost.update' })
    const data = latest?.data
    return isRecord(data) && typeof data.sessionUsd === 'number' ? data.sessionUsd : undefined
  } catch {
    return undefined
  }
}

async function hubChannel($: EngineInterface, status: 'connected' | 'unconfigured', detail: string): Promise<void> {
  try {
    await $.mods.registerChannel({ id: 'email', title: 'Email digest', audience: 'me', delivery: 'pull', status, detail })
  } catch {
    // no hub: there is no channel to register
  }
}

// ── Gathering what happened ────────────────────────────────────────────────────────────────────────

async function readSessionFiles($: EngineInterface, rt: Runtime, now: number): Promise<SessionFile[]> {
  const entries = await $.fs.list(paths.sessions(rt)).catch(() => [])
  const files: SessionFile[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    const id = entry.name.slice(0, -'.json'.length)
    if (id === rt.me) continue
    const value = await readJson($, paths.session(rt, id))
    if (!isRecord(value) || value.root !== rt.root || typeof value.updatedAt !== 'number' || now - value.updatedAt > KEEP_DAYS * DAY_MS) continue
    files.push({
      id,
      root: rt.root,
      project: typeof value.project === 'string' ? value.project : '',
      updatedAt: value.updatedAt,
      events: Array.isArray(value.events) ? (value.events as DigestEvent[]) : [],
      costByDay: isRecord(value.costByDay) ? (value.costByDay as Record<string, number>) : {},
      cursor: typeof value.cursor === 'string' ? value.cursor : null,
    })
  }
  return files
}

async function readCommits($: EngineInterface, rt: Runtime, from: number, to: number): Promise<Commit[]> {
  const repo = await $.session.repo().catch(() => null)
  if (repo === null) return []
  try {
    const run = await $.process.run(gitLogArgv(new Date(from).toISOString(), new Date(to).toISOString()), { cwd: repo.root, timeoutMs: GIT_TIMEOUT_MS })
    return run.exitCode === 0 ? parseGitLog(run.stdout) : []
  } catch {
    return []
  }
}

async function readJournals($: EngineInterface, rt: Runtime, from: number, to: number): Promise<Journal[]> {
  const journals: Journal[] = []
  const zone = rt.settings.zone
  for (let day = startOfDay(from, zone); day < to; day = addDays(day, 1, zone)) {
    const date = dateKey(epochToWall(day, zone))
    try {
      const text = await $.fs.read(`${rt.root}/${rt.settings.journalDir}/${date}.md`)
      if (typeof text === 'string') journals.push(parseJournal(text, date))
    } catch {
      // no journal for that day
    }
  }
  return journals
}

/** What the AI cost in the window: this project's sessions when the hub fed them, else smart-router's daily totals. */
function costOf(rt: Runtime, files: readonly SessionFile[], from: number, to: number): { usd: number; scope: 'project' | 'all' } | undefined {
  const zone = rt.settings.zone
  const days: string[] = []
  for (let day = startOfDay(from, zone); day < to; day = addDays(day, 1, zone)) days.push(dateKey(epochToWall(day, zone)))
  const perProject = days.reduce((sum, date) => sum + [...files.map(file => file.costByDay), rt.costByDay].reduce((all, byDay) => all + (byDay[date] ?? 0), 0), 0)
  if (perProject > 0) return { usd: perProject, scope: 'project' }
  const global = days.reduce((sum, date) => sum + (rt.state.costs[date] ?? 0), 0)
  return global > 0 ? { usd: global, scope: 'all' } : undefined
}

async function gather($: EngineInterface, rt: Runtime, period: Period, now: number, note: string): Promise<DigestInput> {
  const { from, to } = windowFor(period, now, rt.settings.zone)
  const files = await readSessionFiles($, rt, now)
  const events = [...files.flatMap(file => file.events), ...rt.events].filter(event => event.at >= from && event.at <= to)
  const cost = costOf(rt, files, from, to)
  return {
    project: rt.settings.projectName === '' ? rt.project : rt.settings.projectName,
    period,
    from,
    to,
    zone: rt.settings.zone,
    commits: await readCommits($, rt, from, to),
    events: mergeEvents([], events, 2_000),
    journals: await readJournals($, rt, from, to),
    ...(cost === undefined ? {} : { costUsd: cost.usd, costScope: cost.scope }),
    ...(note === '' ? {} : { note }),
  }
}

type Built = {
  digest: Digest
  mail: Mail
  recipients: { valid: string[]; invalid: string[] }
  tone: Tone
  language: Language
  problem: string
}

/** Builds the digest for a period as it would be sent: gathered, composed, secrets masked, addressed. */
async function buildDigest($: EngineInterface, rt: Runtime, period: Period, now: number): Promise<Built> {
  const config = await readConfig($, rt)
  const tone = config.tone ?? rt.settings.tone
  const language = config.language ?? rt.settings.language
  const recipientsText = config.recipients ?? rt.settings.recipients
  const input = await gather($, rt, period, now, config.note ?? '')
  const composed = composeDigest(input, { tone, language, includeCost: rt.settings.includeCost, signature: rt.settings.signature })
  const mask = (text: string): string => redactText(text, { enabled: REDACTED }).text
  const digest: Digest = { ...composed, subject: mask(composed.subject), text: mask(composed.text), html: mask(composed.html) }
  const recipients = parseRecipients(recipientsText)
  const ready = readiness(rt.settings, recipientsText)
  return {
    digest,
    recipients,
    tone,
    language,
    problem: ready.problem,
    mail: { from: rt.settings.from, to: recipients.valid, ...(rt.settings.replyTo === '' ? {} : { replyTo: rt.settings.replyTo }), subject: digest.subject, text: digest.text, html: digest.html },
  }
}

// ── Sending ────────────────────────────────────────────────────────────────────────────────────────

async function sendMail($: EngineInterface, rt: Runtime, mail: Mail, now: number): Promise<SendResult> {
  const { settings } = rt
  try {
    if (settings.provider === 'smtp') {
      const id = `${now}.${fingerprint(`${mail.subject}${mail.to.join(',')}`)}`
      await $.fs.write(paths.outbox(rt), buildMime(mail, now, id))
      try {
        const plan = smtpPlan(mail, { url: settings.smtpUrl, username: settings.smtpUser, password: settings.smtpPassword }, paths.outbox(rt))
        const run = await $.process.run(plan.argv, { stdin: plan.stdin, timeoutMs: SMTP_TIMEOUT_MS })
        return readSmtp(run.exitCode, run.stderr)
      } finally {
        // The message is not kept: there is no delete, so the file is emptied.
        await $.fs.write(paths.outbox(rt), '').catch(() => undefined)
      }
    }
    const request = settings.provider === 'resend' ? resendRequest(mail, settings.resendApiKey) : sendgridRequest(mail, settings.sendgridApiKey)
    const response = await $.http.fetch(request.url, request.init)
    return settings.provider === 'resend' ? readResend(response.status, response.text) : readSendgrid(response.status, response.text)
  } catch (error) {
    return { isSent: false, detail: `could not reach ${settings.provider}: ${messageOf(error)}` }
  }
}

type Outcome = { isSent: boolean; detail: string; count: number; subject: string; isEmpty: boolean }

/** Builds and sends one digest. Everything that goes to the person is free of the keys. */
async function sendDigest($: EngineInterface, rt: Runtime, period: Period, prebuilt?: Built): Promise<Outcome> {
  const now = await $.clock.now()
  const built = prebuilt ?? (await buildDigest($, rt, period, now))
  const base = { count: built.recipients.valid.length, subject: built.digest.subject, isEmpty: built.digest.isEmpty }
  if (built.problem !== '') return { ...base, isSent: false, detail: built.problem }
  if (built.recipients.invalid.length > 0) return { ...base, isSent: false, detail: `These recipients are not valid addresses: ${built.recipients.invalid.join(', ')}` }
  if (rt.isSending) return { ...base, isSent: false, detail: 'A digest is being sent already.' }
  rt.isSending = true
  await setView($, { phase: 'sending' })
  try {
    const result = await sendMail($, rt, built.mail, now)
    const detail = without(result.detail, secretsOf(rt.settings))
    if (result.isSent) {
      rt.lastSent = { at: now, period, count: base.count }
      await writeConfig($, rt, current => {
        const { note: _note, ...rest } = current
        return rest
      })
    }
    return { ...base, isSent: result.isSent, detail }
  } finally {
    rt.isSending = false
  }
}

// ── The schedule (leader) ──────────────────────────────────────────────────────────────────────────

async function saveState($: EngineInterface, rt: Runtime): Promise<void> {
  const keep = Object.fromEntries(Object.entries(rt.state.costs).sort(([a], [b]) => a.localeCompare(b)).slice(-14))
  rt.state = { ...rt.state, costs: keep }
  await writeJson($, paths.state(rt), { ...rt.state, lastSent: rt.lastSent })
}

/** Records smart-router's total for its day, so a weekly digest can add the days up. */
async function noteDailyCost($: EngineInterface, rt: Runtime): Promise<void> {
  const daily = parseDaily(await readJson($, paths.daily(rt)))
  if (daily === undefined || (rt.state.costs[daily.date] ?? 0) >= daily.spent) return
  rt.state = { ...rt.state, costs: { ...rt.state.costs, [daily.date]: daily.spent } }
  await saveState($, rt)
}

async function runDue($: EngineInterface, rt: Runtime, due: Due, now: number): Promise<void> {
  const recipientsText = (await readConfig($, rt)).recipients ?? rt.settings.recipients
  // Not set up: nothing to do, and no point rebuilding the digest every beat.
  if (!readiness(rt.settings, recipientsText).isReady) return
  const built = await buildDigest($, rt, due.period, now)
  if (built.digest.isEmpty) {
    rt.state = afterAttempt(rt.state, due, true, now)
    await saveState($, rt)
    return
  }
  const outcome = await sendDigest($, rt, due.period, built)
  rt.state = afterAttempt(rt.state, due, outcome.isSent, now)
  await saveState($, rt)
  if (outcome.isSent) {
    await hubNotify($, { level: 'success', title: `Digest sent to ${outcome.count} ${outcome.count === 1 ? 'person' : 'people'}`, body: outcome.subject, audience: 'terminal' })
  } else if (rt.state.attempt !== null && rt.state.attempt.count >= 3) {
    await hubNotify($, { level: 'error', title: 'The scheduled digest could not be sent', body: outcome.detail, audience: 'terminal' })
  } else {
    $.ui.log(`${NAME}: digest not sent, will retry: ${outcome.detail}`, { to: 'debug' })
  }
  await refreshView($, rt)
}

/** Renews, takes or follows the lease of this project. A taken lease is trusted only once read back on the next beat. */
async function tickLease($: EngineInterface, rt: Runtime, now: number): Promise<void> {
  const lease = parseLease(await readJson($, paths.lease(rt)))
  const action = leaseAction(lease, rt.me, now)
  if (action === 'follow') {
    rt.isLeader = false
    rt.leaseVerified = false
  } else {
    const next: Lease = { sessionId: rt.me, heartbeatAt: now, since: action === 'renew' && lease !== null ? lease.since : now }
    await writeJson($, paths.lease(rt), next)
    if (action === 'renew' && rt.isLeader) rt.leaseVerified = true
    else {
      const isTaking = !rt.isLeader
      rt.isLeader = true
      rt.leaseVerified = action === 'renew'
      if (isTaking) {
        const stored = await readJson($, paths.state(rt))
        rt.state = parseSchedState(stored)
        rt.lastSent = isRecord(stored) && isRecord(stored.lastSent) && typeof stored.lastSent.at === 'number' ? (stored.lastSent as LastSent) : rt.lastSent
      }
    }
  }
  await update($, leaderAtom, () => rt.isLeader && rt.leaseVerified)
}

/** Every 10 seconds: the lease, and when this session leads, whether a digest is due. */
async function beat($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.dir === '' || rt.root === '') return
  const now = await $.clock.now()
  await tickLease($, rt, now)
  if (!rt.isLeader || !rt.leaseVerified) return
  await noteDailyCost($, rt)
  const due = dueNow(now, rt.settings.zone, rt.settings.schedule, rt.state)
  if (due !== undefined && !rt.isSending) await runDue($, rt, due, now)
}

// ── What this session sees (hub events, notices, cost) ─────────────────────────────────────────────

async function persistSession($: EngineInterface, rt: Runtime, now: number): Promise<void> {
  if (!rt.isDirty || rt.dir === '' || rt.me === '') return
  rt.isDirty = false
  const cutoff = now - KEEP_DAYS * DAY_MS
  rt.events = rt.events.filter(event => event.at >= cutoff)
  const file: SessionFile = { id: rt.me, root: rt.root, project: rt.project, updatedAt: now, events: rt.events, costByDay: rt.costByDay, cursor: rt.cursor }
  await writeJson($, paths.session(rt, rt.me), file)
}

/** Every 20 seconds: pull the hub's new events and the notices queued for the email channel, and keep the cost. */
async function collect($: EngineInterface, rt: Runtime): Promise<void> {
  const now = await $.clock.now()
  const fresh: DigestEvent[] = []
  for (const event of await hubRecent($, rt.lastEventAt)) {
    rt.lastEventAt = Math.max(rt.lastEventAt, event.at)
    const mapped = eventFromHub(event)
    if (mapped !== undefined) fresh.push(mapped)
  }
  const notices = await hubDrain($, rt.cursor)
  for (const notice of notices) {
    const mapped = eventFromNotice(notice)
    if (mapped !== undefined) fresh.push(mapped)
  }
  const lastNotice = notices[notices.length - 1]
  if (lastNotice !== undefined) {
    rt.cursor = lastNotice.id
    rt.isDirty = true
  }
  const usd = await hubSessionUsd($)
  if (usd !== undefined) {
    const spent = usd >= rt.lastUsd ? usd - rt.lastUsd : usd
    rt.lastUsd = usd
    if (spent > 0) {
      const day = dateKey(epochToWall(now, rt.settings.zone))
      rt.costByDay = { ...rt.costByDay, [day]: (rt.costByDay[day] ?? 0) + spent }
      rt.isDirty = true
    }
  }
  if (fresh.length > 0) {
    rt.events = mergeEvents(rt.events, fresh, EVENT_CAP)
    rt.isDirty = true
  }
  await persistSession($, rt, now)
}

// ── The view ───────────────────────────────────────────────────────────────────────────────────────

async function setView($: EngineInterface, change: Partial<DigestView>): Promise<void> {
  await update($, viewAtom, view => ({ ...view, ...change }))
}

/** Builds the preview and puts it in the pane. */
async function refreshView($: EngineInterface, rt: Runtime): Promise<void> {
  await setView($, { phase: 'building' })
  const now = await $.clock.now()
  try {
    const built = await buildDigest($, rt, rt.period, now)
    await setView($, {
      phase: 'idle',
      period: rt.period,
      tone: built.tone,
      language: built.language,
      project: rt.settings.projectName === '' ? rt.project : rt.settings.projectName,
      subject: built.digest.subject,
      preview: built.digest.text,
      isEmpty: built.digest.isEmpty,
      recipients: built.recipients.valid,
      invalid: built.recipients.invalid,
      problem: built.problem,
      schedule: scheduleText(rt.settings.schedule),
      provider: rt.settings.provider,
      lastSent: rt.lastSent,
    })
    await hubChannel($, built.problem === '' ? 'connected' : 'unconfigured', built.problem === '' ? `${rt.settings.provider} → ${built.recipients.valid.length} recipient${built.recipients.valid.length === 1 ? '' : 's'} · ${scheduleText(rt.settings.schedule)}` : built.problem)
  } catch (error) {
    await setView($, { phase: 'idle', message: `Could not build the preview: ${messageOf(error)}`, messageTone: 'error' })
  }
}

async function sendFromPane($: EngineInterface, rt: Runtime): Promise<void> {
  const outcome = await sendDigest($, rt, rt.period)
  await refreshView($, rt)
  await setView($, outcome.isSent ? { message: `Sent to ${outcome.count} ${outcome.count === 1 ? 'recipient' : 'recipients'}.`, messageTone: 'success' } : { message: outcome.detail, messageTone: 'error' })
}

async function pickPeriod($: EngineInterface, rt: Runtime, period: Period): Promise<void> {
  rt.period = period
  await setView($, { message: '' })
  await refreshView($, rt)
}

async function cycleTone($: EngineInterface, rt: Runtime): Promise<void> {
  const current = (await readConfig($, rt)).tone ?? rt.settings.tone
  const next = TONES[(TONES.indexOf(current) + 1) % TONES.length] ?? 'client'
  await writeConfig($, rt, config => ({ ...config, tone: next }))
  await refreshView($, rt)
}

async function cycleLanguage($: EngineInterface, rt: Runtime): Promise<void> {
  const current = (await readConfig($, rt)).language ?? rt.settings.language
  const next = current === 'en' ? 'it' : 'en'
  await writeConfig($, rt, config => ({ ...config, language: next }))
  await refreshView($, rt)
}

async function saveRecipients($: EngineInterface, rt: Runtime, text: string): Promise<string> {
  const parsed = parseRecipients(text)
  if (parsed.invalid.length > 0) return `Not valid addresses: ${parsed.invalid.join(', ')}. Nothing was saved.`
  await writeConfig($, rt, config => ({ ...config, recipients: parsed.valid.join(', ') }))
  await setView($, { isEditing: false })
  await refreshView($, rt)
  return parsed.valid.length === 0 ? 'Recipients cleared for this project.' : `Recipients for this project: ${parsed.valid.join(', ')}`
}

async function submitRecipients($: EngineInterface, rt: Runtime, text: string): Promise<void> {
  const message = await saveRecipients($, rt, text)
  await setView($, { message, messageTone: message.startsWith('Not valid') ? 'error' : 'success' })
}

async function toggleEditing($: EngineInterface): Promise<void> {
  await update($, viewAtom, view => ({ ...view, isEditing: !view.isEditing }))
}

// ── The command ────────────────────────────────────────────────────────────────────────────────────

const periodArg = (word: string | undefined): Period | undefined => (word === 'weekly' || word === 'week' ? 'weekly' : word === 'daily' || word === 'day' || word === 'today' ? 'daily' : undefined)

async function previewText($: EngineInterface, rt: Runtime, period: Period): Promise<string> {
  const built = await buildDigest($, rt, period, await $.clock.now())
  const header = [`Subject: ${built.digest.subject}`, `To: ${built.recipients.valid.length === 0 ? '(no recipients yet)' : built.recipients.valid.join(', ')}`, `Tone: ${built.tone} · language: ${built.language}`]
  const hint = built.problem === '' ? '' : `\nNot ready to send: ${built.problem}`
  return `${header.join('\n')}\n\n${built.digest.text}${hint}`
}

async function openPane($: EngineInterface, rt: Runtime): Promise<string> {
  await refreshView($, rt)
  const opened = await $.ui.open({ id: PANE, title: 'Email digest' })
  return opened.isPlaced ? 'Email digest pane opened.' : `The terminal is too narrow for a pane.\n${await previewText($, rt, rt.period)}`
}

async function statusText($: EngineInterface, rt: Runtime): Promise<string> {
  const config = await readConfig($, rt)
  const recipients = config.recipients ?? rt.settings.recipients
  const ready = readiness(rt.settings, recipients)
  const lines = [
    `Project: ${rt.project}`,
    `Provider: ${rt.settings.provider}${ready.isReady ? '' : ` (not ready: ${ready.problem})`}`,
    `Recipients: ${parseRecipients(recipients).valid.join(', ') || 'none'}`,
    `Schedule: ${scheduleText(rt.settings.schedule)}`,
    `Voice: ${config.tone ?? rt.settings.tone}, ${config.language ?? rt.settings.language}${rt.settings.includeCost ? ', with cost line' : ''}`,
    `This session ${rt.isLeader && rt.leaseVerified ? 'sends the scheduled digests of this project' : 'follows another session for the schedule'}.`,
  ]
  if (rt.lastSent !== null) lines.push(`Last sent: ${new Date(rt.lastSent.at).toISOString().slice(0, 16).replace('T', ' ')} UTC (${rt.lastSent.period}, ${rt.lastSent.count} recipients)`)
  if (config.note !== undefined) lines.push(`Note for the next digest: ${config.note}`)
  return lines.join('\n')
}

async function runDigest($: EngineInterface, rt: Runtime, args: string): Promise<string> {
  const [word = '', ...rest] = args.trim().split(/\s+/)
  const command = word.toLowerCase()
  const argument = rest.join(' ').trim()
  if (command === '') return openPane($, rt)
  if (command === 'setup' || command === 'help') return `${SETUP_TEXT}\n${USAGE}`
  if (command === 'status') return statusText($, rt)
  if (command === 'preview') return previewText($, rt, periodArg(rest[0]) ?? rt.period)
  if (command === 'send') {
    const outcome = await sendDigest($, rt, periodArg(rest[0]) ?? rt.period)
    await refreshView($, rt)
    return outcome.isSent ? `Sent "${outcome.subject}" to ${outcome.count} ${outcome.count === 1 ? 'recipient' : 'recipients'}.` : `Not sent: ${outcome.detail}`
  }
  if (command === 'recipients') {
    if (argument === '') {
      const current = (await readConfig($, rt)).recipients ?? rt.settings.recipients
      return parseRecipients(current).valid.length === 0 ? 'No recipients for this project yet. Usage: /digest recipients ana@client.com, boss@acme.com' : `Recipients: ${parseRecipients(current).valid.join(', ')}`
    }
    return saveRecipients($, rt, argument === 'none' || argument === 'clear' ? '' : argument)
  }
  if (command === 'tone') {
    const tone = TONES.find(one => one === argument.toLowerCase())
    if (tone === undefined) return 'Usage: /digest tone client|manager|technical'
    await writeConfig($, rt, config => ({ ...config, tone }))
    await refreshView($, rt)
    return `Tone for this project: ${tone}.`
  }
  if (command === 'lang' || command === 'language') {
    const language = LANGUAGES.find(one => one === argument.toLowerCase())
    if (language === undefined) return 'Usage: /digest lang en|it'
    await writeConfig($, rt, config => ({ ...config, language }))
    await refreshView($, rt)
    return `Language for this project: ${language}.`
  }
  if (command === 'note') {
    if (argument === '') return 'Usage: /digest note <text for the next digest> (or: /digest note clear)'
    await writeConfig($, rt, config => {
      const { note: _note, ...rest2 } = config
      return argument === 'clear' ? rest2 : { ...rest2, note: argument.slice(0, 600) }
    })
    await refreshView($, rt)
    return argument === 'clear' ? 'Note cleared.' : 'Note saved: it goes in the next digest, then it is cleared.'
  }
  return USAGE
}

// ── The pane ───────────────────────────────────────────────────────────────────────────────────────

const TONE_COLOR = { success: 'success', error: 'error', info: 'suggestion' } as const
const TONE_GLYPH = { success: '✓', error: '✗', info: '•' } as const
const capital = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`
const PREVIEW_LINES = 40

async function drawDigest($: EngineInterface, e: RenderInput<'Pane'>, rt: Runtime): Promise<RenderElement> {
  const { Box, Button, Text } = $.ui.resolve(e)
  const fields = e.surface === 'mobile' ? undefined : $.ui.resolve(e)
  const [view, isLeader] = await Promise.all([read($, viewAtom), read($, leaderAtom)])
  const isBusy = view.phase !== 'idle'
  const lines = view.preview.split('\n')
  const shown = lines.slice(0, PREVIEW_LINES)
  const Field = fields === undefined ? undefined : 'Input' in fields ? fields.Input : undefined
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={1}>
        <Text bold color="claude">✉ Email digest{view.project === '' ? '' : ` · ${view.project}`}</Text>
        <Text dimColor>{isLeader ? 'sends the schedule' : 'follower'}</Text>
      </Box>
      <Text dimColor wrap="wrap">{`${view.schedule} · ${view.provider}`}</Text>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
        <Text wrap="wrap">{`To: ${view.recipients.length === 0 ? '(nobody yet)' : view.recipients.join(', ')}`}</Text>
        <Button key="digest-edit" label={view.isEditing ? 'Cancel' : 'Edit recipients'} onPress={() => toggleEditing($)} />
      </Box>
      {view.isEditing && Field !== undefined ? (
        <Field key="digest-recipients" label="Recipients" placeholder="ana@client.com, boss@acme.com" value={view.recipients.join(', ')} submitLabel="save" autoFocus onSubmit={(value: string) => submitRecipients($, rt, value)} />
      ) : null}
      {view.isEditing && Field === undefined ? <Text dimColor wrap="wrap">Use /digest recipients a@x.com, b@y.com on this surface.</Text> : null}
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
        <Button key="digest-period-daily" label="Daily" variant={view.period === 'daily' ? 'primary' : 'secondary'} onPress={() => pickPeriod($, rt, 'daily')} />
        <Button key="digest-period-weekly" label="Weekly" variant={view.period === 'weekly' ? 'primary' : 'secondary'} onPress={() => pickPeriod($, rt, 'weekly')} />
        <Button key="digest-tone" label={`Tone: ${capital(view.tone)}`} onPress={() => cycleTone($, rt)} />
        <Button key="digest-lang" label={`Language: ${view.language.toUpperCase()}`} onPress={() => cycleLanguage($, rt)} />
      </Box>
      <Box key="digest-preview" flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
        <Text bold wrap="wrap">{view.subject === '' ? 'Preview' : view.subject}</Text>
        {view.phase === 'building' ? <Text color="suggestion">⟳ Building the preview…</Text> : null}
        {shown.map((line, index) => (
          <Text key={`line-${index}`} wrap="wrap">{line === '' ? ' ' : line}</Text>
        ))}
        {lines.length > shown.length ? <Text dimColor>{`… ${lines.length - shown.length} more lines`}</Text> : null}
      </Box>
      {view.problem === '' ? null : <Text color="warning" wrap="wrap">{`⚠ ${view.problem}`}</Text>}
      {view.invalid.length === 0 ? null : <Text color="error" wrap="wrap">{`✗ Not valid addresses: ${view.invalid.join(', ')}`}</Text>}
      {view.isEmpty ? <Text dimColor wrap="wrap">Nothing happened in this period: the schedule would skip it.</Text> : null}
      {view.message === '' ? null : <Text color={TONE_COLOR[view.messageTone]} wrap="wrap">{`${TONE_GLYPH[view.messageTone]} ${view.message}`}</Text>}
      {view.lastSent === null ? null : <Text dimColor wrap="wrap">{`Last sent ${new Date(view.lastSent.at).toISOString().slice(0, 16).replace('T', ' ')} UTC · ${view.lastSent.period} · ${view.lastSent.count} recipients`}</Text>}
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
        {isBusy ? <Text color="suggestion">{view.phase === 'sending' ? '⟳ Sending…' : '⟳ Working…'}</Text> : <Button key="digest-send" label="Send now" variant="primary" onPress={() => sendFromPane($, rt)} />}
        <Button key="digest-refresh" label="Refresh preview" onPress={() => refreshView($, rt)} />
      </Box>
    </Box>
  )
}

// ── Start ──────────────────────────────────────────────────────────────────────────────────────────

async function startUp($: EngineInterface, rt: Runtime, isInteractive: boolean): Promise<void> {
  rt.home = ((await $.env.get('HOME').catch(() => undefined)) ?? (await $.env.get('USERPROFILE').catch(() => undefined)) ?? '').replace(/[\\/]+$/, '')
  rt.dir = rt.home === '' ? '' : `${rt.home}/${FILES_DIR}`
  rt.me = await $.session.id().catch(() => '')
  rt.root = (await $.session.repo().catch(() => null))?.root ?? (await $.session.root().catch(() => ''))
  rt.project = baseName(rt.root)
  rt.key = fingerprint(rt.root)
  rt.isInteractive = isInteractive
  rt.state = parseSchedState(await readJson($, paths.state(rt)))
  const stored = await readJson($, paths.session(rt, rt.me))
  if (isRecord(stored) && Array.isArray(stored.events)) {
    rt.events = stored.events as DigestEvent[]
    rt.costByDay = isRecord(stored.costByDay) ? (stored.costByDay as Record<string, number>) : {}
    rt.cursor = typeof stored.cursor === 'string' ? stored.cursor : null
  }
  await hubHello($, { version: VERSION, publishes: [], consumes: ['ci.result', 'deploy.finished', 'deploy.failed', 'pr.opened', 'decision.recorded', 'test.result', 'error.repeated', 'cost.update'] })
  const recipients = (await readConfig($, rt)).recipients ?? rt.settings.recipients
  const ready = readiness(rt.settings, recipients)
  await hubChannel($, ready.isReady ? 'connected' : 'unconfigured', ready.isReady ? `${rt.settings.provider} · ${scheduleText(rt.settings.schedule)}` : ready.problem)
  if (!isInteractive) return
  rt.timers.push($.clock.every(BEAT_MS, () => void beat($, rt).catch(error => $.ui.log(`${NAME}: ${messageOf(error)}`, { to: 'debug' }))))
  rt.timers.push($.clock.every(COLLECT_MS, () => void collect($, rt).catch(error => $.ui.log(`${NAME}: ${messageOf(error)}`, { to: 'debug' }))))
  await beat($, rt)
}

/** Start-up, run once per session: after session.start has returned (afterStart) or at the first /digest. */
type Boot = { started?: Promise<void>; isInteractive: boolean }

function ensureStarted($: EngineInterface, rt: Runtime, boot: Boot): Promise<void> {
  boot.started ??= startUp($, rt, boot.isInteractive).catch(error => $.ui.log(`${NAME}: start-up failed: ${messageOf(error)}`, { to: 'debug' }))
  return boot.started
}

export const register: Register = (on, options) => {
  const rt = newRuntime(readSettings(options))
  // Start-up runs once, after session.start has returned or at the first /digest, whichever comes first.
  const boot: Boot = { isInteractive: false }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await registerCommand($, { name: 'digest', description: 'Preview and send the daily or weekly email summary for clients and managers', argumentHint: '[preview | send | recipients | tone | lang | note | status | setup]' })
    // Start-up (the hub hello, the cache, the first fetch) waits until session.start has returned (afterStart): with
    // every mod installed, waiting on the network, the disk or the hub here ran session.start past its 10 s budget.
    boot.started = undefined
    boot.isInteractive = e.isInteractive
    afterStart($, 'email-digest', () => ensureStarted($, rt, boot))
    return started
  })

  on('session.end', async ($, e, next) => {
    // A /clear ends the conversation, not the session. Otherwise keep what was seen since the last collection.
    if (e.reason !== 'clear') {
      try {
        await persistSession($, rt, await $.clock.now())
      } catch (error) {
        $.ui.log(`${NAME}: ${messageOf(error)}`, { to: 'debug' })
      }
    }
    return next(e)
  })

  on('command.run', { command: 'digest' }, async ($, e) => {
    try {
      await ensureStarted($, rt, boot)
      return { text: await runDigest($, rt, e.args) }
    } catch (error) {
      return { text: `The /digest command failed: ${without(messageOf(error), secretsOf(rt.settings))}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: 'email-digest' }, async ($, e) => drawDigest($, e, rt)).catch(async ($, e, next) =>
    next.error.kind === 're-entry'
      ? next(e)
      : paneFailure($.ui.resolve(e), { title: 'email-digest', failure: next.error, below: await next(e).catch(() => null), onRetry: () => $.ui.invalidate('ui.render') }),
  )
}

/** Registers a slash command. A refused name (Claude Code's own, or another mod's) is reported as a notice, never thrown, so the rest of session.start still runs. */
async function registerCommand($: EngineInterface, spec: Parameters<EngineInterface['command']['register']>[0]): Promise<boolean> {
  try {
    await $.command.register(spec)
    return true
  } catch (error) {
    $.ui.log(`${$.plugin.name}: /${spec.name} was not registered (${error instanceof Error ? error.message : String(error)}).`)
    return false
  }
}

// #region @vendored shared/hub-client.ts sha256:6b153e2e759f: edit the source, then run `node scripts/sync-shared.mjs`.
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
/**
 * Runs a mod's start-up work (the hub hello, a first scan, loading what it keeps) once `session.start` has returned,
 * after a short delay staggered by the mod's name (0.15–1.35 s), so ~200 mods sharing one hooks worker do not all wait
 * on the hub, a process or the disk inside the session.start chain (`ran past its 10s budget`). A failure is logged
 * to the debug log. Call it from `session.start` in place of `await work()`; never await the hub there
 * (scripts/check-startup.mjs).
 */
function afterStart($: EngineInterface, mod: string, work: () => Promise<unknown>): void {
  let hash = 7
  for (let i = 0; i < mod.length; i += 1) hash = (hash * 31 + mod.charCodeAt(i)) % 1_200
  $.clock.after(150 + hash, () => {
    void work().catch(error => $.ui.log(`${mod}: start-up work failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' }))
  })
}
// #endregion @vendored shared/hub-client.ts
