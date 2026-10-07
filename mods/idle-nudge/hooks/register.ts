import type { EngineInterface, Register } from 'claude-code'

const DEFAULT_IDLE_MINUTES = 20
const TICK_MS = 60_000
const MS_PER_MINUTE = 60_000
const GIT_TIMEOUT_MS = 5_000
const TOAST_MS = 30_000

/** Files with uncommitted changes (untracked ones included); 0 outside a git repository or on any failure. */
const countChangedFiles = async ($: EngineInterface): Promise<number> => {
  try {
    const { exitCode, stdout } = await $.process.run(['git', 'status', '--porcelain'], {
      timeoutMs: GIT_TIMEOUT_MS,
    })

    return exitCode === 0 ? stdout.split('\n').filter(line => line.trim() !== '').length : 0
  } catch {
    return 0
  }
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
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: ['session.idle'] })
}

/** Whether mods-hub says you are at the keyboard, in this session or another one (false without the hub). */
async function isHereElsewhere($: EngineInterface): Promise<boolean> {
  return (await hubMode($))?.presence === 'here'
}

/** The nudge: a toast without the hub; with it, a hub notice (held while Silent, like every mod's). */
async function nudge($: EngineInterface, text: string): Promise<void> {
  if ((await hubMode($)) === undefined) $.ui.toast(text, { timeoutMs: TOAST_MS })
  else await hubNotify($, { level: 'info', title: text, topic: 'session.idle' })
}

export const register: Register = (on, options) => {
  const idleMs =
    (typeof options.idleMinutes === 'number' && options.idleMinutes > 0
      ? options.idleMinutes
      : DEFAULT_IDLE_MINUTES) * MS_PER_MINUTE

  let lastActiveAt: number | undefined
  let isWorking = false
  let hasNudged = false
  let isChecking = false

  on('session.start', async ($, e, next) => {
    lastActiveAt = await $.clock.now()
    await greetHub($)

    $.clock.every(TICK_MS, () => {
      void (async () => {
        const now = await $.clock.now()
        lastActiveAt ??= now

        if (isWorking || hasNudged || isChecking || now - lastActiveAt < idleMs) {
          return
        }

        isChecking = true
        try {
          // Idle here while typing in another session is not idle: the hub tracks activity in every session.
          if (await isHereElsewhere($)) return
          const files = await countChangedFiles($)

          if (files > 0) {
            const minutes = Math.floor((now - lastActiveAt) / MS_PER_MINUTE)
            const text = `idle-nudge: you have ${files} uncommitted ${files === 1 ? 'file' : 'files'} (idle ${minutes} min)`
            hasNudged = true
            await nudge($, text)
          }
        } finally {
          isChecking = false
        }
      })()
    })

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    hasNudged = false
    lastActiveAt = await $.clock.now()

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    isWorking = true
    lastActiveAt = await $.clock.now()

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      isWorking = false
      lastActiveAt = await $.clock.now()
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
