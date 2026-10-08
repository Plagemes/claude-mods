import type { EngineInterface, Register } from 'claude-code'

import { BUILT_IN, formatReport, hasIncident, incidentsUrl, parseExtra, readIncidents, readStatus, statusUrl, suspectedServices } from './status'
import type { Incident, Reading, Service } from './status'

const DEFAULT_TIMEOUT_SEC = 5
/** After a failed command the answer is waited for briefly: the model should not be kept from its error for long. */
const AUTO_TIMEOUT_MS = 3_000
const CACHE_MS = 60_000
const TOAST_MS = 10_000
const USER_AGENT = 'claude-mods-status-check'

type Settings = { services: Service[]; timeoutMs: number; isAutoCheckOn: boolean }
/** What a status page said and when, so a run of failures asks it once a minute. */
type Cache = Map<string, { at: number; reading: Reading }>

const readSettings = (options: Record<string, unknown>): Settings => ({
  services: [...BUILT_IN, ...parseExtra(typeof options.extra === 'string' ? options.extra : '')],
  timeoutMs: (typeof options.timeoutSec === 'number' && options.timeoutSec > 0 ? options.timeoutSec : DEFAULT_TIMEOUT_SEC) * 1000,
  isAutoCheckOn: options.autoCheck !== false,
})

/** A GET that gives up after `ms` instead of hanging; resolves the body, or why there is none. */
function get($: EngineInterface, url: string, ms: number): Promise<{ text: string } | { why: string }> {
  return new Promise(resolve => {
    const timer = $.clock.after(ms, () => resolve({ why: `no answer within ${ms / 1000} s` }))
    $.http.fetch(url, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } }).then(
      response => {
        timer.cancel()
        resolve(response.ok ? { text: response.text } : { why: `HTTP ${response.status}` })
      },
      (error: unknown) => {
        timer.cancel()
        resolve({ why: error instanceof Error ? error.message.replace(/^.*?\$\.http\.fetch:\s*/, '').slice(0, 80) : 'the request failed' })
      },
    )
  })
}

/** One service's status; its open incidents are fetched only when it reports a problem. */
async function readService($: EngineInterface, service: Service, ms: number): Promise<Reading> {
  const answer = await get($, statusUrl(service), ms)
  if ('why' in answer) return { kind: 'unreachable', why: answer.why }
  const status = readStatus(answer.text)
  if (status === undefined) return { kind: 'unreachable', why: 'not a Statuspage answer' }

  let incidents: Incident[] = []
  if (status.indicator !== 'none') {
    const more = await get($, incidentsUrl(service), ms)
    if ('text' in more) incidents = readIncidents(more.text)
  }
  return { kind: 'ok', ...status, incidents }
}

async function cachedReading($: EngineInterface, cache: Cache, service: Service): Promise<Reading> {
  const now = await $.clock.now()
  const known = cache.get(service.id)
  if (known !== undefined && now - known.at < CACHE_MS) return known.reading
  const reading = await readService($, service, AUTO_TIMEOUT_MS)
  cache.set(service.id, { at: now, reading })
  return reading
}

async function overview($: EngineInterface, args: string, settings: Settings): Promise<string> {
  const wanted = args.trim().toLowerCase()
  const services = wanted === '' ? settings.services : settings.services.filter(service => service.name.toLowerCase().includes(wanted) || service.id.includes(wanted))
  if (services.length === 0) return `No service called "${args.trim()}". Known: ${settings.services.map(service => service.name).join(', ')}.`

  const readings = await Promise.all(services.map(async service => ({ service, reading: await readService($, service, settings.timeoutMs) })))
  return formatReport(readings, await $.clock.now())
}

const noteFor = (service: Service, reading: Extract<Reading, { kind: 'ok' }>): string =>
  `status-check: ${service.name} reports "${reading.description || reading.indicator}" right now (${service.url}), so the failure above is probably not your code. ` +
  (reading.incidents.length === 0 ? '' : `Open incidents: ${reading.incidents.slice(0, 3).map(incident => `${incident.name} (${incident.impact})${incident.link === '' ? '' : ` ${incident.link}`}`).join('; ')}. `) +
  'Retry later or work around it rather than changing code.'

export const register: Register = (on, options) => {
  const settings = readSettings(options)
  const cache: Cache = new Map()

  on('session.start', async ($, e, next) => {
    // /status is built into Claude Code, so this one is /service-status.
    await registerCommand($, {
      name: 'service-status',
      description: 'Check whether GitHub, npm, PyPI or the Anthropic API have an outage',
      argumentHint: '[service]',
    })
    return next(e)
  })

  on('command.run', { command: 'service-status' }, async ($, e) => ({ text: await overview($, e.args, settings) }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!settings.isAutoCheckOn) return next(e)
    const ran = await next(e)
    if (ran.isError !== true) return ran

    const notes: string[] = []
    for (const id of suspectedServices(e.command, ran.text ?? '')) {
      const service = settings.services.find(item => item.id === id)
      if (service === undefined) continue
      const reading = await cachedReading($, cache, service)
      if (reading.kind === 'ok' && hasIncident(reading)) {
        notes.push(noteFor(service, reading))
        $.ui.toast(`${service.name} reports an incident ("${reading.description || reading.indicator}"): the failed command is probably not your code`, { timeoutMs: TOAST_MS })
      }
    }
    return notes.length === 0 ? ran : { ...ran, context: [...(ran.context ?? []), ...notes] }
  }).catch(($, e, next) => next(e))
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
