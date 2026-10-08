import type { EngineInterface, HttpResponse, PromptOrigin, Register } from 'claude-code'

import { packageRequests } from './parse'
import type { PackageRequest } from './parse'
import { POPULAR, nearestPopular } from './popular'
import type { Ecosystem } from './popular'
import { redactSummary } from './shared/secrets'

/** What a registry says of a package; `unknown` when it could not be asked (fail open). */
type Lookup =
  | { kind: 'missing' }
  | { kind: 'found'; createdAt: number | undefined; versions: number }
  | { kind: 'unknown'; why: string }
type CachedLookup = { at: number; lookup: Lookup }
type Finding = { name: string; ecosystem: Ecosystem; reason: string }
type Limits = { minAgeDays: number; minVersions: number; timeoutMs: number; checkRegistry: boolean }

const PLUGIN = 'dependency-sentinel'
const OVERRIDE = /\bDEPS-OK\b/
const DAY_MS = 86_400_000
const CACHE_TTL_MS = DAY_MS
/** A package this old with this many releases is a project in its own right, not a squat: `ms` is not a typo of `ws`. */
const ESTABLISHED_DAYS = 365
const ESTABLISHED_VERSIONS = 5
const APPROVED_KEY = 'approved'
const MAX_APPROVED = 500
/** How long the held-back toast stays when there is no hub. */
const HELD_TOAST_MS = 8000
const USER_AGENT = 'dependency-sentinel (https://github.com/plagemes/claude-mods)'
const TIMED_OUT = Symbol('timed out')
const HUMAN_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])
/** Words the person typed (or sent from a phone or the SDK, or a plugin sent as theirs); never a notification or a peer. */
const isPerson = (origin: PromptOrigin): boolean => HUMAN_ORIGINS.has(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)
const REGISTRY_LABEL: Record<Ecosystem, string> = { npm: 'npm', pypi: 'PyPI', crates: 'crates.io', go: 'the Go module proxy' }

const numberOption = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback

const keyOf = (request: { ecosystem: Ecosystem; name: string }): string => `${request.ecosystem}:${request.name}`

const parseJson = (text: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const timeOf = (value: unknown): number | undefined => {
  const time = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isNaN(time) ? undefined : time
}

/** Go module paths escape capitals as `!` + lower case. */
const escapeGoPath = (path: string): string => path.replace(/[A-Z]/g, letter => `!${letter.toLowerCase()}`)

const NPM_REGISTRY = 'https://registry.npmjs.org/'
const urlOf = (ecosystem: Ecosystem, name: string): string => {
  if (ecosystem === 'npm') return NPM_REGISTRY + name.replace('/', '%2f')
  if (ecosystem === 'pypi') return `https://pypi.org/pypi/${encodeURIComponent(name)}/json`
  if (ecosystem === 'crates') return `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`
  return `https://proxy.golang.org/${escapeGoPath(name)}/@v/list`
}

/** Reads the creation time and release count out of a registry's answer. */
const lookupFrom = (ecosystem: Ecosystem, response: HttpResponse): Lookup => {
  if (response.status === 404 || response.status === 410) return { kind: 'missing' }
  if (!response.ok) return { kind: 'unknown', why: `HTTP ${response.status}` }
  if (ecosystem === 'go') {
    const versions = response.text.split('\n').filter(line => line.trim() !== '').length
    return { kind: 'found', createdAt: undefined, versions }
  }
  const body = parseJson(response.text)
  if (body === undefined) return { kind: 'unknown', why: 'an unreadable answer' }
  if (ecosystem === 'npm') {
    const time = (body.time ?? {}) as Record<string, unknown>
    if (time.unpublished !== undefined) return { kind: 'missing' }
    return { kind: 'found', createdAt: timeOf(time.created), versions: Object.keys(body.versions ?? {}).length }
  }
  if (ecosystem === 'pypi') {
    const releases = (body.releases ?? {}) as Record<string, readonly { upload_time_iso_8601?: string }[]>
    const uploads = Object.values(releases)
      .flat()
      .map(file => timeOf(file.upload_time_iso_8601))
      .filter((time): time is number => time !== undefined)
    return { kind: 'found', createdAt: uploads.length > 0 ? Math.min(...uploads) : undefined, versions: Object.keys(releases).length }
  }
  const crate = (body.crate ?? {}) as Record<string, unknown>
  const versions = Array.isArray(body.versions) ? body.versions.length : 0
  return { kind: 'found', createdAt: timeOf(crate.created_at), versions }
}

/** A fetch that gives up after `ms`, resolving TIMED_OUT instead of hanging the tool call. */
const fetchWithin = ($: EngineInterface, url: string, ms: number): Promise<HttpResponse | typeof TIMED_OUT> =>
  new Promise((resolve, reject) => {
    const timer = $.clock.after(ms, () => resolve(TIMED_OUT))
    $.http.fetch(url, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } }).then(
      response => {
        timer.cancel()
        resolve(response)
      },
      error => {
        timer.cancel()
        reject(error)
      },
    )
  })

const askRegistry = async ($: EngineInterface, request: PackageRequest, limits: Limits): Promise<Lookup> => {
  // A Go package path may sit below its module's root: try the shorter prefixes too.
  const names =
    request.ecosystem === 'go'
      ? request.name.split('/').map((_, index, parts) => parts.slice(0, parts.length - index).join('/')).filter(path => path.split('/').length >= 2)
      : [request.name]
  for (const name of names) {
    try {
      const response = await fetchWithin($, urlOf(request.ecosystem, name), limits.timeoutMs)
      if (response === TIMED_OUT) return { kind: 'unknown', why: `no answer within ${limits.timeoutMs} ms` }
      const lookup = lookupFrom(request.ecosystem, response)
      if (lookup.kind !== 'missing') return lookup
    } catch (error) {
      return { kind: 'unknown', why: String(error) }
    }
  }
  return { kind: 'missing' }
}

/** The registry's answer, from the store when it was asked in the last day. */
const lookUp = async ($: EngineInterface, request: PackageRequest, limits: Limits, now: number): Promise<Lookup> => {
  const cacheKey = `registry:${keyOf(request)}`
  const cached = (await $.store.get(cacheKey)) as CachedLookup | undefined
  if (cached !== undefined && now - cached.at < CACHE_TTL_MS) return cached.lookup
  const lookup = await askRegistry($, request, limits)
  if (lookup.kind !== 'unknown') await $.store.set(cacheKey, { at: now, lookup } satisfies CachedLookup)
  return lookup
}

const inspect = async ($: EngineInterface, request: PackageRequest, limits: Limits, now: number): Promise<Finding[]> => {
  const findings: Finding[] = []
  const add = (reason: string): void => {
    findings.push({ name: request.name, ecosystem: request.ecosystem, reason })
  }
  const near = nearestPopular(request.ecosystem, request.name)
  const typo = near === undefined ? undefined : `looks like a typo of "${near.name}" (${near.distance} edit${near.distance === 1 ? '' : 's'} away)`
  if (POPULAR[request.ecosystem].has(request.name) || !limits.checkRegistry) {
    if (typo !== undefined) add(typo)
    return findings
  }

  const lookup = await lookUp($, request, limits, now)
  const registry = REGISTRY_LABEL[request.ecosystem]
  if (lookup.kind === 'unknown') {
    if (typo !== undefined) add(typo)
    await hubNotify($, { level: 'info', title: `Could not check ${request.name} on ${registry} (${lookup.why}); allowed` })
  } else if (lookup.kind === 'missing') {
    if (typo !== undefined) add(typo)
    add(`does not exist on ${registry}: a mistyped or hallucinated name, or a squat waiting to happen`)
  } else {
    const ageDays = lookup.createdAt === undefined ? undefined : Math.floor((now - lookup.createdAt) / DAY_MS)
    const isEstablished = ageDays !== undefined && ageDays >= ESTABLISHED_DAYS && lookup.versions >= ESTABLISHED_VERSIONS
    if (typo !== undefined && !isEstablished) add(typo)
    if (ageDays !== undefined && ageDays < limits.minAgeDays) add(`was first published ${ageDays === 0 ? 'today' : `${ageDays} day${ageDays === 1 ? '' : 's'} ago`}`)
    if (lookup.versions < limits.minVersions) {
      add(lookup.versions === 0 ? 'has no tagged releases' : `has only ${lookup.versions} release${lookup.versions === 1 ? '' : 's'}`)
    }
  }
  return findings
}

const denial = (command: string, findings: readonly Finding[]): string => {
  const shown = command.length > 80 ? `${command.slice(0, 77)}...` : command
  const lines = findings.map(finding => `  - ${finding.name} ${finding.reason}`)
  return [
    `${PLUGIN}: held back \`${shown}\`:`,
    ...lines,
    'Check the names. If they are intended, ask the user to reply with DEPS-OK, then run the install again.',
  ].join('\n')
}

const rememberApproved = async ($: EngineInterface, requests: readonly PackageRequest[]): Promise<void> => {
  const approved = ((await $.store.get(APPROVED_KEY)) as string[] | undefined) ?? []
  const added = requests.map(keyOf).filter(key => !approved.includes(key))
  if (added.length > 0) await $.store.set(APPROVED_KEY, [...approved, ...added].slice(-MAX_APPROVED))
}

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Says hello to mods-hub when it is installed. */
async function greetHub($: EngineInterface): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: ['risk.blocked'], consumes: [] })
}

/** Tells mods-hub (when installed) what was held back, the command masked and cut short. The deny never waits on it. */
async function reportBlock($: EngineInterface, findings: readonly Finding[], command: string): Promise<void> {
  const reasons = findings.map(finding => `${finding.name} ${finding.reason}`).join('; ')
  await hubPublish($, { topic: 'risk.blocked', data: { guard: PLUGIN, tool: 'Bash', reason: `suspicious-package: ${reasons}`, severity: 'medium', command: redactSummary(command) } })
}

export const register: Register = (on, options) => {
  const limits: Limits = {
    minAgeDays: numberOption(options.minAgeDays, 30),
    minVersions: numberOption(options.minVersions, 2),
    timeoutMs: Math.max(500, numberOption(options.timeoutMs, 4000)),
    checkRegistry: options.checkRegistry !== false,
  }
  let isOverridden = false

  on('prompt.submit', ($, e, next) => {
    if (isPerson(e.origin)) isOverridden = OVERRIDE.test(e.text)
    // A turn nobody typed (a notification, a schedule, a peer) starts without the approval of an earlier prompt.
    else if (e.turnId === undefined) isOverridden = false
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    afterStart($, 'dependency-sentinel', () => greetHub($))
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const requests = packageRequests(e.command)
    if (requests.length === 0) return next(e)

    if (isOverridden) {
      await rememberApproved($, requests)
      return next(e)
    }
    const approved = new Set(((await $.store.get(APPROVED_KEY)) as string[] | undefined) ?? [])
    const pending = requests.filter(request => !approved.has(keyOf(request)))
    const now = await $.clock.now()
    const findings = (await Promise.all(pending.map(request => inspect($, request, limits, now)))).flat()
    if (findings.length === 0) return next(e)

    const names = [...new Set(findings.map(finding => finding.name))]
    await reportBlock($, findings, e.command)
    // A question for the person (it obeys the hub's Interaction mode); a toast when there is no hub.
    await hubNotify($, { level: 'warning', kind: 'question', title: `Held back ${names.join(', ')}. Reply DEPS-OK to allow.`, topic: 'risk.blocked' }, { timeoutMs: HELD_TOAST_MS })
    return { deny: denial(e.command, findings) }
  }).catch(($, e, next) => {
    // Not a hard gate: a failed check lets the install through, and says so.
    if (!next.called && next.error.kind !== 're-entry') $.ui.toast(`Check failed (${next.error.kind}); install allowed`)
    return next(e)
  })
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
