import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import { networkUse } from './network'

const STATUS = '✈ offline'
const OFF_HINT = 'Ask the user to run /offline off if the network is needed.'
const SUMMARY = 'WebFetch, WebSearch, curl and wget, package installs, git push/pull/fetch/clone, ssh and cloud CLIs'
const TOAST_MS = 6_000

const offline = atom({ plugin: 'offline-mode', key: 'offline' } as const, { isOn: false })

const isFromPerson = (origin: PromptOrigin): boolean => ['composer', 'bridge', 'sdk', 'slack-ping'].includes(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)

/** What a call needs the network for, or undefined when it does not. */
const networkNeeded = (tool: string, command: string | undefined): string | undefined =>
  tool === 'WebFetch' || tool === 'WebSearch' ? tool : command === undefined ? undefined : networkUse(command)

async function setOffline($: EngineInterface, isOn: boolean): Promise<void> {
  await update($, offline, () => ({ isOn }))
  $.ui.status(isOn ? STATUS : undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'offline',
      description: 'Block every network call (WebFetch, curl, installs, git push) until turned off',
      argumentHint: 'on | off',
    })
    if ((await read($, offline)).isOn) $.ui.status(STATUS)
    return next(e)
  })

  on('command.run', { command: 'offline' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const { isOn } = await read($, offline)
    if (arg === '' || !['on', 'off', 'toggle'].includes(arg)) {
      return { text: isOn ? 'Offline mode is on: the network is blocked. /offline off to go back online.' : 'Offline mode is off. /offline on blocks every network call until you turn it off.' }
    }
    if (!isFromPerson(e.origin)) return { text: 'Only you can change offline mode: type /offline yourself.' }

    const isNowOn = arg === 'toggle' ? !isOn : arg === 'on'
    await setOffline($, isNowOn)
    return isNowOn
      ? {
          text: `Offline mode on: ${SUMMARY} are blocked. /offline off to go back online.`,
          context: [`offline-mode: the user switched offline mode on. Network access is blocked (${SUMMARY}); work with what is on disk. ${OFF_HINT}`],
        }
      : { text: 'Offline mode off. Network access is back.', context: ['offline-mode: offline mode is off; network access is allowed again.'] }
  })

  on('tool.call', { tool: ['WebFetch', 'WebSearch', 'Bash'] }, async ($, e, next) => {
    if (!(await read($, offline)).isOn) return next(e)

    const what = networkNeeded(e.tool, e.tool === 'Bash' ? e.command : undefined)
    if (what === undefined) return next(e)

    $.ui.status(STATUS)
    $.ui.toast(`blocked ${what} (offline). /offline off turns it off`, { timeoutMs: TOAST_MS })
    return { deny: `offline-mode: offline mode is on, so ${what} is blocked. Work without network access, using what is already on disk. ${OFF_HINT}` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'offline-mode: could not check whether offline mode is on, so this call was held back.' }))
}
