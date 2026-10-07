import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import { hostOf, isLoopback, matchesAny, parseEntry, parseList, urlsInCommand } from './hosts'
import { redactSummary } from './shared/secrets'

const MOD = 'url-allowlist'

const DEFAULT_HOSTS =
  'developer.mozilla.org,docs.python.org,github.com,raw.githubusercontent.com,npmjs.com,pypi.org,stackoverflow.com,docs.anthropic.com,code.claude.com,nodejs.org,typescriptlang.org,react.dev,docs.rs,crates.io,pkg.go.dev,go.dev,learn.microsoft.com,wikipedia.org,readthedocs.io'
const TOAST_MS = 8_000
const LISTED_HOSTS = 8

/** Hosts the person allowed for this session with /allow-host. */
const extraHosts = atom({ plugin: 'url-allowlist', key: 'extra' } as const, [])

type Settings = { isAllowMode: boolean; allowed: string[]; blocked: string[]; checkBash: boolean }

const isFromPerson = (origin: PromptOrigin): boolean => ['composer', 'bridge', 'sdk', 'slack-ping'].includes(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)

/** Why a host may not be reached (`rule` is for mods-hub's risk.blocked), or undefined when it may. */
const refusalFor = (host: string | undefined, settings: Settings, extra: readonly string[]): { rule: string; reason: string } | undefined => {
  if (settings.isAllowMode) {
    if (host === undefined) return { rule: 'unreadable-host', reason: 'its host could not be read' }
    return isLoopback(host) || matchesAny(host, [...settings.allowed, ...extra]) ? undefined : { rule: 'not-allowed', reason: `${host} is not on the allowlist` }
  }
  return host !== undefined && !matchesAny(host, extra) && matchesAny(host, settings.blocked) ? { rule: 'blocked-host', reason: `${host} is on the blocklist` } : undefined
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

/** Tells mods-hub (when installed) what was blocked, the URL or command masked and cut short. The deny never waits on it. */
async function reportBlock($: EngineInterface, tool: string, refusal: { rule: string; reason: string }, url: string, command: string | undefined): Promise<void> {
  await hubPublish($, {
    topic: 'risk.blocked',
    data: {
      guard: MOD,
      tool,
      reason: `${refusal.rule}: ${refusal.reason}`,
      severity: 'medium',
      ...(command === undefined ? { path: redactSummary(url) } : { command: redactSummary(command) }),
    },
  })
}

const listOf = (hosts: readonly string[]): string =>
  hosts.length === 0 ? 'none' : hosts.length > LISTED_HOSTS ? `${hosts.slice(0, LISTED_HOSTS).join(', ')} and ${hosts.length - LISTED_HOSTS} more` : hosts.join(', ')

export const register: Register = (on, options) => {
  const settings: Settings = {
    isAllowMode: options.mode !== 'block',
    allowed: parseList(typeof options.hosts === 'string' ? options.hosts : DEFAULT_HOSTS),
    blocked: parseList(typeof options.blockedHosts === 'string' ? options.blockedHosts : ''),
    checkBash: options.checkBash === true,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'allow-host',
      description: 'Allow a host for WebFetch for this session (no argument: show the lists)',
      argumentHint: '[host | remove <host> | clear]',
    })
    await greetHub($)
    return next(e)
  })

  on('command.run', { command: 'allow-host' }, async ($, e) => {
    if (!isFromPerson(e.origin)) return { text: 'Only you can change which hosts are allowed: type /allow-host yourself.' }
    const args = e.args.trim()
    const session = await read($, extraHosts)

    if (args === '') {
      const configured = settings.isAllowMode ? settings.allowed : settings.blocked
      return {
        text: [
          settings.isAllowMode ? 'Mode: allow. Only these hosts (and their subdomains) can be fetched, plus localhost.' : 'Mode: block. Every host can be fetched except the blocked ones.',
          `${settings.isAllowMode ? 'Allowed' : 'Blocked'} in the settings: ${listOf(configured)}`,
          `${settings.isAllowMode ? 'Allowed' : 'Let through'} for this session: ${listOf(session)}`,
          'Use /allow-host <host> to add one, /allow-host remove <host>, or /allow-host clear.',
        ].join('\n'),
      }
    }
    if (args === 'clear') {
      await update($, extraHosts, () => [])
      return { text: 'Cleared the hosts added for this session.' }
    }

    const isRemoval = /^remove\s+/i.test(args)
    const entries = args.replace(/^remove\s+/i, '').split(/[\s,]+/).filter(entry => entry !== '')
    const parsed = entries.map(entry => ({ entry, host: parseEntry(entry) }))
    const invalid = parsed.filter(item => item.host === undefined).map(item => item.entry)
    if (invalid.length > 0) return { text: `${invalid.map(entry => `"${entry}"`).join(', ')} ${invalid.length === 1 ? 'is not a host' : 'are not hosts'} I can use. Give a full name such as docs.example.com.` }

    const hosts = parsed.flatMap(item => (item.host === undefined ? [] : [item.host]))
    await update($, extraHosts, current => (isRemoval ? current.filter(host => !hosts.includes(host)) : [...new Set([...current, ...hosts])]))
    const verb = isRemoval ? 'Removed' : settings.isAllowMode ? 'Allowed' : 'Unblocked'
    return { text: `${verb} ${hosts.join(', ')} for this session${isRemoval ? '' : ' (subdomains included)'}.` }
  })

  on('tool.call', { tool: ['WebFetch', 'Bash'] }, async ($, e, next) => {
    const urls = e.tool === 'WebFetch' ? [e.url] : e.tool === 'Bash' && settings.checkBash ? urlsInCommand(e.command) : []
    if (urls.length === 0) return next(e)

    const extra = await read($, extraHosts)
    for (const url of urls) {
      const host = hostOf(url)
      const refusal = refusalFor(host, settings, extra)
      if (refusal === undefined) continue
      const reason = refusal.reason
      const what = e.tool === 'WebFetch' ? 'this WebFetch' : 'this command'
      await reportBlock($, e.tool, refusal, url, e.tool === 'Bash' ? e.command : undefined)
      if (host === undefined) return { deny: `${MOD}: ${reason} in "${url.slice(0, 120)}", so ${what} was blocked. Use a plain https://host/path URL.` }
      const note = `blocked ${e.tool === 'WebFetch' ? 'fetch' : 'download'} from ${host}. /allow-host ${host} allows it for this session`
      await hubNotify($, { level: 'warning', title: note, topic: 'risk.blocked' }, { timeoutMs: TOAST_MS })
      return {
        deny:
          `${MOD}: ${reason}, so ${what} was blocked. Ask the user to run /allow-host ${host} (or add it to the url-allowlist settings), ` +
          (settings.isAllowMode ? 'or use one of the allowed sources.' : 'or use another source.'),
      }
    }
    return next(e)
  }).catch(($, e, next) => (next.called || (e.tool === 'Bash' && !settings.checkBash) ? next(e) : { deny: `${MOD}: the URL could not be checked, so the call was blocked.` }))
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
