import type { EngineInterface, Register } from 'claude-code'

import { TIPS, dayKey, positionOf, tipAt } from './tips'

const SHOWN_ON = 'shownOn'
const NEXT = 'next'
const TOAST_MS = 12_000

const line = (position: number): string => `Tip ${position + 1} of ${TIPS.length}: ${tipAt(position).text}`

/** Takes the next tip off the rotation: its position, with the store already moved on. */
async function takeTip($: EngineInterface): Promise<number> {
  const position = positionOf(await $.store.get(NEXT))
  await $.store.set(NEXT, (position + 1) % TIPS.length)
  return position
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
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: [] })
}

/** The toast, with its own timeout, when there is no hub; an `info` notification through mods-hub when it is installed. */
async function notice($: EngineInterface, title: string, timeoutMs: number): Promise<void> {
  if ((await hubMode($)) === undefined) $.ui.toast(title, { timeoutMs })
  else await hubNotify($, { level: 'info', title })
}

/** Shows today's tip once; any trouble with the store means no tip, never a failed start. */
async function announce($: EngineInterface): Promise<void> {
  try {
    const today = dayKey(await $.clock.now())
    if ((await $.store.get(SHOWN_ON)) === today) return
    await $.store.set(SHOWN_ON, today)
    await notice($, `💡 ${tipAt(await takeTip($)).text}  ·  /tip for another`, TOAST_MS)
  } catch {
    // A tip is a nicety: stay silent when the store or clock cannot be used.
  }
}

export const register: Register = (on, options) => {
  const showAtStart = options.showAtStart !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'tip', description: 'Show the next Claude Code shortcut or feature tip' })
    await greetHub($)
    if (showAtStart && e.isInteractive) await announce($)
    return next(e)
  })

  on('command.run', { command: 'tip' }, async $ => {
    try {
      return { text: line(await takeTip($)) }
    } catch {
      return { text: line(0) }
    }
  })
}

// #region @vendored shared/hub-client.ts sha256:d76b7319c8a3: edit the source, then run `node scripts/sync-shared.mjs`.
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

/** Whether the shared panel shows tab `id` now; read while drawing, it subscribes the drawing. */
async function hubTabIs($: EngineInterface, id: string): Promise<boolean> {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
  return value === id
}
// #endregion @vendored shared/hub-client.ts
