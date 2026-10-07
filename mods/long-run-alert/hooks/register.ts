import type { EngineInterface, Register } from 'claude-code'

const DEFAULT_SECONDS = 60
const MAX_COMMAND_LENGTH = 60

const clip = (command: string): string => {
  const oneLine = command.replace(/\s+/g, ' ').trim()
  return oneLine.length > MAX_COMMAND_LENGTH ? `${oneLine.slice(0, MAX_COMMAND_LENGTH - 1)}…` : oneLine
}

const formatElapsed = (seconds: number): string =>
  seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60 === 0 ? '' : ` ${seconds % 60}s`}`

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
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: [] })
}

/**
 * The alert is a warning through mods-hub when it is installed (your phone too while you are away, held while
 * Silent), a plain toast otherwise.
 */
async function alert($: EngineInterface, elapsedSeconds: number, command: string): Promise<void> {
  await hubNotify($, { level: 'warning', title: `⏱ still running (${formatElapsed(elapsedSeconds)}): ${clip(command)}` })
}

export const register: Register = (on, options) => {
  const seconds = typeof options.seconds === 'number' && options.seconds > 0 ? options.seconds : DEFAULT_SECONDS
  const isRepeating = options.repeat === true

  on('session.start', async ($, e, next) => {
    await greetHub($)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // A background command returns at once; the shell is not held up by it.
    if (e.run_in_background === true) return next(e)

    let alerts = 0
    const command = e.command
    const raise = () => {
      alerts += 1
      void alert($, alerts * seconds, command)
    }
    const timer = isRepeating ? $.clock.every(seconds * 1000, raise) : $.clock.after(seconds * 1000, raise)
    next.signal.addEventListener('abort', () => timer.cancel(), { once: true })

    try {
      return await next(e)
    } finally {
      timer.cancel()
    }
  })
}

// #region @vendored shared/hub-client.ts sha256:3ade61508f36: edit the source, then run `node scripts/sync-shared.mjs`.
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

/** Routes a notification through the hub (channels, silent, night, presence), or shows a toast when there is no hub. */
async function hubNotify($: EngineInterface, input: Parameters<HubMods['notify']>[0]): Promise<void> {
  try {
    await $.mods.notify(input)
  } catch {
    $.ui.toast(input.body === undefined || input.body === '' ? input.title : `${input.title} — ${input.body}`)
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

/** Whether the shared panel shows tab `id` now; read while drawing, it subscribes the drawing. */
async function hubTabIs($: EngineInterface, id: string): Promise<boolean> {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
  return value === id
}
// #endregion @vendored shared/hub-client.ts
