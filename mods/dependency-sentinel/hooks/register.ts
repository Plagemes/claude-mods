import type { EngineInterface, HttpResponse, PromptOrigin, Register } from 'claude-code'

import { packageRequests } from './parse'
import type { PackageRequest } from './parse'
import { POPULAR, nearestPopular } from './popular'
import type { Ecosystem } from './popular'

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
    $.ui.toast(`Could not check ${request.name} on ${registry} (${lookup.why}); allowed`)
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
    $.ui.toast(`Held back ${names.join(', ')}. Reply DEPS-OK to allow.`, { timeoutMs: 8000 })
    return { deny: denial(e.command, findings) }
  }).catch(($, e, next) => {
    // Not a hard gate: a failed check lets the install through, and says so.
    if (!next.called && next.error.kind !== 're-entry') $.ui.toast(`Check failed (${next.error.kind}); install allowed`)
    return next(e)
  })
}
