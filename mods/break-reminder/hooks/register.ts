import type { EngineInterface, Register } from 'claude-code'

const DEFAULT_MINUTES = 50
const DEFAULT_IDLE_MINUTES = 5
const MINUTE_MS = 60_000
const TICK_MS = 30_000
const TOAST_MS = 12_000
const CURSOR_KEY = 'cursor'

const REMINDERS = [
  '🧍 Stand up and stretch your legs.',
  '💧 Water break: refill your glass.',
  '👀 Look at something 20 feet away for 20 seconds.',
  '🚶 Take a short walk; Claude will keep the context warm.',
  '🫁 Roll your shoulders and take three slow breaths.',
  '🖐 Shake out your wrists and fingers.',
] as const

const positive = (value: unknown, fallback: number): number =>
  typeof value === 'number' && value > 0 ? value : fallback

/** What mods-hub says about breaks, read on each tick: the person is away, a focus round runs, or one just ended. */
type HubBreaks = { isAway: boolean; isFocusing: boolean; focusEndedAt: number | undefined }

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
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: ['session.idle', 'session.away', 'focus.started', 'focus.ended'] })
}

/**
 * The breaks mods-hub knows of: presence (`session.idle` / `session.away`, from activity in every session) and
 * focus-timer's rounds (`focus.started` / `focus.ended`). Undefined without the hub.
 */
async function hubBreaks($: EngineInterface): Promise<HubBreaks | undefined> {
  const mode = await hubMode($)
  if (mode === undefined) return undefined
  try {
    const started = await $.mods.latest({ topic: 'focus.started' })
    const ended = await $.mods.latest({ topic: 'focus.ended' })
    return { isAway: mode.presence === 'away', isFocusing: started !== null && (ended === null || started.at > ended.at), focusEndedAt: ended?.at }
  } catch {
    return { isAway: mode.presence === 'away', isFocusing: false, focusEndedAt: undefined }
  }
}

/** The reminder: a toast without the hub; with it, a terminal notice (held while Silent, like every mod's). */
async function remind($: EngineInterface, text: string, hasHub: boolean): Promise<void> {
  if (hasHub) await hubNotify($, { level: 'info', title: text, audience: 'terminal' })
  else $.ui.toast(text, { timeoutMs: TOAST_MS })
}

export const register: Register = (on, options) => {
  const intervalMs = positive(options.minutes, DEFAULT_MINUTES) * MINUTE_MS
  const idleMs = positive(options.idleMinutes, DEFAULT_IDLE_MINUTES) * MINUTE_MS

  let activeMs = 0
  let lastTickAt = 0
  let lastActivityAt = Number.NEGATIVE_INFINITY
  let isTurnRunning = false
  let cursor = 0
  let lastFocusEndAt: number | undefined

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (!e.isInteractive) return started

    lastTickAt = await $.clock.now()
    await greetHub($)
    try {
      const saved = await $.store.get(CURSOR_KEY)
      if (typeof saved === 'number') cursor = saved
    } catch {
      // The rotation simply starts over.
    }

    $.clock.every(TICK_MS, async () => {
      try {
        const now = await $.clock.now()
        // A long gap means the machine slept: do not count it as work.
        const elapsed = Math.min(now - lastTickAt, 2 * TICK_MS)
        lastTickAt = now
        const breaks = await hubBreaks($)
        // A focus round that ended starts its own break; being away (in every session) is a break.
        if (breaks?.focusEndedAt !== undefined && breaks.focusEndedAt !== lastFocusEndAt) {
          lastFocusEndAt = breaks.focusEndedAt
          activeMs = 0
        }
        if (breaks?.isAway === true) {
          activeMs = 0
          return
        }
        if (!isTurnRunning && now - lastActivityAt > idleMs) return

        activeMs += elapsed
        // focus-timer paces the breaks of a focus round: the reminder waits for its end.
        if (activeMs < intervalMs || breaks?.isFocusing === true) return
        const reminder = REMINDERS[cursor % REMINDERS.length]
        await remind($, `${reminder} (${Math.round(activeMs / MINUTE_MS)} min of active work)`, breaks !== undefined)
        activeMs = 0
        cursor += 1
        await $.store.set(CURSOR_KEY, cursor)
      } catch {
        // A missed tick costs nothing: the next one carries on.
      }
    })
    return started
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') lastActivityAt = await $.clock.now()
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    isTurnRunning = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnRunning = false
      lastActivityAt = await $.clock.now()
    }
    return next(e)
  })
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
