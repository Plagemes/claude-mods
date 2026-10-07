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

export const register: Register = (on, options) => {
  const settings: Settings = {
    projectLicense: typeof options.projectLicense === 'string' ? options.projectLicense.trim() : '',
    allowed: new Set(String(options.allowedPackages ?? '').split(',').map(name => name.trim().toLowerCase()).filter(name => name !== '')),
    checkDev: options.checkDev === true,
    timeoutMs: asNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS),
  }

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const requests = installsIn(e.command)
    if (requests.length === 0) return next(e)

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    try {
      const { project, findings } = await check($, requests, settings)
      if (findings.length === 0) return ran
      $.ui.toast(toastOf(project, findings), { timeoutMs: 10_000 })
      return { ...ran, context: [...(ran.context ?? []), noteOf(project, findings)] }
    } catch {
      // The install already ran; a failed check must not turn it into an error.
      return ran
    }
  })
}
