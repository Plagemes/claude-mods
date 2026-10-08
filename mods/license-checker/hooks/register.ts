import type { EngineInterface, HttpResponse, Register } from 'claude-code'

import { lookupOf, installsIn } from './install'
import type { InstallRequest } from './install'
import { isPermissive, kindOf, licenseOfNpm, licenseOfPackageJson, licenseOfPypi, licenseOfPyproject, licenseOfText } from './licenses'
import type { Kind } from './licenses'

type Settings = { projectLicense: string; allowed: ReadonlySet<string>; checkDev: boolean; timeoutMs: number }
type Finding = { name: string; license: string | null; kind: Exclude<Kind, 'permissive'> }
/** A package's license as the registry names it: null when the metadata names none. */
type CachedLicense = { at: number; license: string | null }

const DEFAULT_TIMEOUT_MS = 4000
const CACHE_TTL_MS = 7 * 86_400_000
const CACHE_PREFIX = 'license:'
const USER_AGENT = 'license-checker (https://github.com/plagemes/claude-mods)'
const TIMED_OUT = Symbol('timed out')
const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'COPYING']

const LABEL: Record<Exclude<Kind, 'permissive' | 'unknown'>, string> = {
  copyleft: 'copyleft',
  'weak-copyleft': 'weak copyleft',
}

const readText = async ($: EngineInterface, path: string): Promise<string | undefined> => {
  try {
    return String(await $.fs.read(path))
  } catch {
    return undefined
  }
}

/** The project's license from package.json, pyproject.toml or a LICENSE file, the first one that names a real license. */
async function detectProjectLicense($: EngineInterface): Promise<string | undefined> {
  const cwd = await $.session.cwd()
  const candidates: (string | undefined)[] = []
  const packageJson = await readText($, `${cwd}/package.json`)
  if (packageJson !== undefined) candidates.push(licenseOfPackageJson(packageJson))
  const pyproject = await readText($, `${cwd}/pyproject.toml`)
  if (pyproject !== undefined) candidates.push(licenseOfPyproject(pyproject))
  for (const name of LICENSE_FILES) {
    const text = await readText($, `${cwd}/${name}`)
    if (text !== undefined) candidates.push(licenseOfText(text))
  }
  return candidates.find(license => license !== undefined && kindOf(license) !== 'unknown')
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

/** What the registry says the license is: a string, null for "none declared", undefined when it could not be asked. */
async function askRegistry($: EngineInterface, request: InstallRequest, timeoutMs: number): Promise<string | null | undefined> {
  try {
    const response = await fetchWithin($, lookupOf(request).url, timeoutMs)
    if (response === TIMED_OUT || !response.ok) return undefined
    const document: unknown = JSON.parse(response.text)
    return (request.ecosystem === 'npm' ? licenseOfNpm(document) : licenseOfPypi(document)) ?? null
  } catch {
    return undefined
  }
}

/** The package's license, from the store when it was asked in the last week. */
async function licenseOf($: EngineInterface, request: InstallRequest, timeoutMs: number, now: number): Promise<string | null | undefined> {
  const key = CACHE_PREFIX + lookupOf(request).key
  const cached = (await $.store.get(key)) as CachedLicense | undefined
  if (cached !== undefined && now - cached.at < CACHE_TTL_MS) return cached.license
  const license = await askRegistry($, request, timeoutMs)
  if (license !== undefined) await $.store.set(key, { at: now, license } satisfies CachedLicense)
  return license
}

/** The new dependencies whose license a permissively licensed project should look at twice. */
async function check($: EngineInterface, requests: readonly InstallRequest[], settings: Settings): Promise<{ project: string; findings: Finding[] }> {
  const wanted = requests.filter(request => !settings.allowed.has(request.name) && (settings.checkDev || !request.isDev))
  if (wanted.length === 0) return { project: '', findings: [] }
  const project = settings.projectLicense !== '' ? settings.projectLicense : await detectProjectLicense($)
  if (project === undefined || !isPermissive(project)) return { project: project ?? '', findings: [] }

  const now = await $.clock.now()
  const licenses = await Promise.all(wanted.map(request => licenseOf($, request, settings.timeoutMs, now)))
  const findings: Finding[] = []
  wanted.forEach((request, index) => {
    const license = licenses[index]
    if (license === undefined) return
    const kind = license === null ? 'unknown' : kindOf(license)
    if (kind !== 'permissive') findings.push({ name: request.name, license, kind })
  })
  return { project, findings }
}

const phrase = (finding: Finding): string => {
  if (finding.license === null) return `${finding.name} declares no license`
  if (finding.kind === 'unknown') return `${finding.name} has a license I do not recognise ("${finding.license}")`
  return `${finding.name} is ${finding.license} (${LABEL[finding.kind]})`
}

const toastOf = (project: string, findings: readonly Finding[]): string => {
  const [first] = findings
  const more = findings.length > 1 ? ` and ${findings.length - 1} more` : ''
  return `⚠ ${first === undefined ? '' : phrase(first)}${more}, but your project is ${project}`
}

const noteOf = (project: string, findings: readonly Finding[]): string =>
  [
    `license-checker: this project is licensed ${project}. The packages just installed need a look before you build on them:`,
    ...findings.map(finding => `- ${phrase(finding)}`),
    'A copyleft license can require the code that uses the package to be released under the same license, and a package with no license gives no right to use it.',
    'Tell the user about this in your answer and, unless they say it is fine, suggest a permissively licensed alternative. This is not legal advice.',
  ].join('\n')

const asNumber = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback)

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

/** Tells mods-hub's bus about each license worth a look (`risk.blocked`: guardian and audit-trail list it; nothing is blocked, the install already ran). */
async function reportFindings($: EngineInterface, project: string, findings: readonly Finding[]): Promise<void> {
  for (const finding of findings) {
    await hubPublish($, {
      topic: 'risk.blocked',
      data: { guard: 'license-checker', tool: 'Bash', reason: `${phrase(finding)}, but your project is ${project}`, severity: finding.kind === 'copyleft' ? 'medium' : 'low' },
    })
  }
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    projectLicense: typeof options.projectLicense === 'string' ? options.projectLicense.trim() : '',
    allowed: new Set(String(options.allowedPackages ?? '').split(',').map(name => name.trim().toLowerCase()).filter(name => name !== '')),
    checkDev: options.checkDev === true,
    timeoutMs: asNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS),
  }

  on('session.start', async ($, e, next) => {
    afterStart($, 'license-checker', () => greetHub($))
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const requests = installsIn(e.command)
    if (requests.length === 0) return next(e)

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    try {
      const { project, findings } = await check($, requests, settings)
      if (findings.length === 0) return ran
      await reportFindings($, project, findings)
      // A warning through the hub (your phone channel while you are away); the same toast, for the same time, without it.
      await hubNotify($, { level: 'warning', title: toastOf(project, findings) }, { timeoutMs: 10_000 })
      return { ...ran, context: [...(ran.context ?? []), noteOf(project, findings)] }
    } catch {
      // The install already ran; a failed check must not turn it into an error.
      return ran
    }
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
