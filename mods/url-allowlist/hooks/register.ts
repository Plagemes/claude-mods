import { atom, read, update } from 'claude-code'
import type { PromptOrigin, Register } from 'claude-code'

import { hostOf, isLoopback, matchesAny, parseEntry, parseList, urlsInCommand } from './hosts'

const DEFAULT_HOSTS =
  'developer.mozilla.org,docs.python.org,github.com,raw.githubusercontent.com,npmjs.com,pypi.org,stackoverflow.com,docs.anthropic.com,code.claude.com,nodejs.org,typescriptlang.org,react.dev,docs.rs,crates.io,pkg.go.dev,go.dev,learn.microsoft.com,wikipedia.org,readthedocs.io'
const TOAST_MS = 8_000
const LISTED_HOSTS = 8

/** Hosts the person allowed for this session with /allow-host. */
const extraHosts = atom({ plugin: 'url-allowlist', key: 'extra' } as const, [])

type Settings = { isAllowMode: boolean; allowed: string[]; blocked: string[]; checkBash: boolean }

const isFromPerson = (origin: PromptOrigin): boolean => ['composer', 'bridge', 'sdk', 'slack-ping'].includes(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)

/** Why a host may not be reached, or undefined when it may. */
const refusalFor = (host: string | undefined, settings: Settings, extra: readonly string[]): string | undefined => {
  if (settings.isAllowMode) {
    if (host === undefined) return 'its host could not be read'
    return isLoopback(host) || matchesAny(host, [...settings.allowed, ...extra]) ? undefined : `${host} is not on the allowlist`
  }
  return host !== undefined && !matchesAny(host, extra) && matchesAny(host, settings.blocked) ? `${host} is on the blocklist` : undefined
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
      const reason = refusalFor(host, settings, extra)
      if (reason === undefined) continue
      const what = e.tool === 'WebFetch' ? 'this WebFetch' : 'this command'
      if (host === undefined) return { deny: `url-allowlist: ${reason} in "${url.slice(0, 120)}", so ${what} was blocked. Use a plain https://host/path URL.` }
      $.ui.toast(`blocked ${e.tool === 'WebFetch' ? 'fetch' : 'download'} from ${host}. /allow-host ${host} allows it for this session`, { timeoutMs: TOAST_MS })
      return {
        deny:
          `url-allowlist: ${reason}, so ${what} was blocked. Ask the user to run /allow-host ${host} (or add it to the url-allowlist settings), ` +
          (settings.isAllowMode ? 'or use one of the allowed sources.' : 'or use another source.'),
      }
    }
    return next(e)
  }).catch(($, e, next) => (next.called || (e.tool === 'Bash' && !settings.checkBash) ? next(e) : { deny: 'url-allowlist: the URL could not be checked, so the call was blocked.' }))
}
