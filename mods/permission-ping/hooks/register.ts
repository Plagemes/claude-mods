import type { EngineInterface, Register } from 'claude-code'

const PING_SOUND = { asset: 'assets/ping.wav' } as const
// The permission dialog raises PermissionRequest and Notification together; one ping per request.
const SAME_REQUEST_MS = 2000
const MAX_DETAIL_LENGTH = 60
/** What the hub's `approval.requested` event says about the request, kept short. */
const MAX_QUESTION_LENGTH = 300

type Pinger = { isSoundOn: boolean; isToastOn: boolean; lastPingAt: number }

const describeInput = (input: unknown): string => {
  if (typeof input !== 'object' || input === null) return ''
  const fields = input as Record<string, unknown>
  const detail = [fields.command, fields.file_path, fields.url, fields.pattern].find(
    (value): value is string => typeof value === 'string' && value !== '',
  )
  if (detail === undefined) return ''
  const oneLine = detail.replace(/\s+/g, ' ').trim()
  return oneLine.length > MAX_DETAIL_LENGTH ? `${oneLine.slice(0, MAX_DETAIL_LENGTH - 1)}…` : oneLine
}

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
const ownVersion = async ($: EngineInterface): Promise<string> => {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Says hello to mods-hub when it is installed. */
const greetHub = async ($: EngineInterface): Promise<void> => {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: ['approval.requested'], consumes: [] })
}

/**
 * One ping per request: the toast is a hub notification (a question at level warning: it reaches the person's
 * channels only when they may be asked, and is held while Silent), the sound is held by the hub at night and
 * while Silent; without the hub it is a plain toast and the sound. The request is published either way the hub allows.
 */
const ping = async ($: EngineInterface, pinger: Pinger, message: string, tool: string | undefined): Promise<void> => {
  const now = await $.clock.now()
  if (now - pinger.lastPingAt < SAME_REQUEST_MS) return
  pinger.lastPingAt = now

  await hubPublish($, {
    topic: 'approval.requested',
    data: { id: `permission-${now}`, question: message.slice(0, MAX_QUESTION_LENGTH), ...(tool === undefined ? {} : { tool }) },
  })
  if (pinger.isToastOn) await hubNotify($, { level: 'warning', kind: 'question', title: message, topic: 'approval.requested' })
  // Not awaited: the call resolves when the clip ends, and the dialog must not wait for the chime.
  if (pinger.isSoundOn) $.audio.play(PING_SOUND).catch(() => undefined)
}

export const register: Register = (on, options) => {
  const pinger: Pinger = {
    isSoundOn: options.sound !== false,
    isToastOn: options.toast !== false,
    lastPingAt: Number.NEGATIVE_INFINITY,
  }

  on('session.start', async ($, e, next) => {
    await greetHub($)
    return next(e)
  })

  // Raised when the permission dialog is about to open; skipped when another hook already answered it.
  on('classic.PermissionRequest', async ($, e, next) => {
    const answer = await next(e)
    if (answer.decision === undefined) {
      const detail = describeInput(e.tool_input)
      await ping($, pinger, `🔔 Approval needed: ${e.tool_name}${detail === '' ? '' : ` — ${detail}`}`, e.tool_name)
    }
    return answer
  })

  // Fallback for hosts that only announce the dialog as a notification.
  on('classic.Notification', async ($, e, next) => {
    if (e.notification_type === 'permission_prompt') {
      await ping($, pinger, '🔔 Claude is waiting for your approval', undefined)
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
