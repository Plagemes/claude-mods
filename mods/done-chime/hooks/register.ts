import type { EngineInterface, Register } from 'claude-code'

const CHIME = 'assets/chime.wav'
const DEFAULT_SECONDS = 20
const DEFAULT_VOLUME = 1
const MAX_VOLUME = 4

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

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

/** Plays the chime, unless the hub says the person asked for quiet (Silent, or Night: the hub would hold it anyway). */
async function chime($: EngineInterface, gain: number): Promise<void> {
  const mode = await hubMode($)
  if (mode?.isSilent === true || mode?.isNight === true) return
  // A machine with no player just stays silent.
  await $.audio.play({ asset: CHIME }, { gain }).catch(() => undefined)
}

export const register: Register = (on, options) => {
  const thresholdMs = Math.max(0, numberOr(options.seconds, DEFAULT_SECONDS)) * 1000
  const gain = Math.min(MAX_VOLUME, Math.max(0, numberOr(options.volume, DEFAULT_VOLUME)))

  on('session.start', async ($, e, next) => {
    await greetHub($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const isLongAnswer = e.agentId === undefined && e.reason === 'answer' && e.durationMs > thresholdMs

    if (isLongAnswer && gain > 0) {
      // From a timer, so the sound never holds up the end of the turn.
      $.clock.after(0, () => void chime($, gain))
    }
    return next(e)
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
