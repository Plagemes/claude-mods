import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import { networkUse } from './network'
import { redactSummary } from './shared/secrets'

const MOD = 'offline-mode'

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
  // On mods-hub's blackboard as `offline-mode.on`, so other mods can read it.
  await hubShareFact($, { name: 'on', value: isOn })
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

/** Says hello to mods-hub when it is installed, and shares the flag a reload kept. */
async function greetHub($: EngineInterface): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: ['risk.blocked'], consumes: [] })
  await hubShareFact($, { name: 'on', value: (await read($, offline)).isOn })
}

/** Tells mods-hub (when installed) what was blocked, the command masked and cut short. The deny never waits on it. */
async function reportBlock($: EngineInterface, tool: string, what: string, command: string | undefined): Promise<void> {
  await hubPublish($, {
    topic: 'risk.blocked',
    data: { guard: MOD, tool, reason: `offline: ${what} needs the network`, severity: 'low', ...(command === undefined ? {} : { command: redactSummary(command) }) },
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'offline',
      description: 'Block every network call (WebFetch, curl, installs, git push) until turned off',
      argumentHint: 'on | off',
    })
    if ((await read($, offline)).isOn) $.ui.status(STATUS)
    await greetHub($)
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

    const command = e.tool === 'Bash' ? e.command : undefined
    const what = networkNeeded(e.tool, command)
    if (what === undefined) return next(e)

    $.ui.status(STATUS)
    await reportBlock($, e.tool, what, command)
    // `info`: it stays in the terminal (a toast when there is no hub).
    await hubNotify($, { level: 'info', title: `blocked ${what} (offline). /offline off turns it off`, topic: 'risk.blocked' }, { timeoutMs: TOAST_MS })
    return { deny: `${MOD}: offline mode is on, so ${what} is blocked. Work without network access, using what is already on disk. ${OFF_HINT}` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${MOD}: could not check whether offline mode is on, so this call was held back.` }))
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
