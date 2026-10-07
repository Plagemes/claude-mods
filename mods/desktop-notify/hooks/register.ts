import type { EngineInterface, Register } from 'claude-code'

type Platform = 'macos' | 'linux' | 'windows'
type Notifier = { platform?: Platform | 'unsupported' }
/**
 * The hub's notices on their way to the desktop: the collecting timer (kept so a second `session.start` does not start a
 * second one), the last notice handled (the next drain acknowledges up to it), the ids already shown (a notice comes
 * back until acknowledged), whether a collection is running, and how often the oldest waiting notice failed.
 */
type Courier = { timer?: { cancel: () => void }; cursor: string | null; shown: string[]; isBusy: boolean; failures: number; isFailing: boolean }
type Command = { argv: string[]; env?: Record<string, string> }

const DEFAULT_MIN_SECONDS = 30
const COMMAND_TIMEOUT_MS = 5000
/** How often the notices mods-hub queued for the `desktop` channel are collected. */
const DRAIN_MS = 5000
const CHANNEL_ID = 'desktop'
/** A notice the notifier refused this many times in a row is given up, so it cannot hold back the ones behind it. */
const MAX_TRIES = 5
/** Ids of shown notices remembered for deduplication. */
const SHOWN_KEEP = 200
const MAX_TITLE_LENGTH = 60
const MAX_BODY_LENGTH = 200
const APP_NAME = 'Claude Code'
/**
 * Windows shows a desktop app's toast only for an AppUserModelID registered by a Start menu shortcut:
 * an arbitrary one ('Claude Code') is accepted and then silently dropped. Windows PowerShell's own always exists.
 */
const WINDOWS_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

// AppleScript reads title and message as arguments, so nothing is ever spliced into the script text.
const MACOS_SCRIPT = [
  'on run argv',
  'display notification (item 1 of argv) with title (item 2 of argv)',
  'end run',
]
// Title and body travel in the environment for the same reason.
const WINDOWS_SCRIPT = [
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
  '$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
  "$text = $xml.GetElementsByTagName('text')",
  '$text.Item(0).AppendChild($xml.CreateTextNode($env:CLAUDE_NOTIFY_TITLE)) | Out-Null',
  '$text.Item(1).AppendChild($xml.CreateTextNode($env:CLAUDE_NOTIFY_BODY)) | Out-Null',
  `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${WINDOWS_APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($xml))`,
].join('; ')

const clip = (text: string, max: number): string => {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

const formatDuration = (ms: number): string => {
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

const commandFor = (platform: Platform, title: string, body: string): Command => {
  if (platform === 'macos') {
    return { argv: ['osascript', ...MACOS_SCRIPT.flatMap(line => ['-e', line]), body, title] }
  }
  if (platform === 'linux') {
    return { argv: ['notify-send', '--app-name', APP_NAME, '--', title, body] }
  }
  return {
    argv: ['powershell', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT],
    env: { CLAUDE_NOTIFY_TITLE: title, CLAUDE_NOTIFY_BODY: body },
  }
}

const detectPlatform = async ($: EngineInterface): Promise<Platform | 'unsupported'> => {
  if ((await $.env.get('OS')) === 'Windows_NT') return 'windows'
  try {
    const { stdout } = await $.process.run(['uname', '-s'], { timeoutMs: COMMAND_TIMEOUT_MS })
    const kernel = stdout.trim()
    if (kernel === 'Darwin') return 'macos'
    if (kernel === 'Linux') return 'linux'
    if (/^(MINGW|MSYS|CYGWIN)/.test(kernel)) return 'windows'
  } catch {
    // No uname: not a host this mod knows.
  }
  return 'unsupported'
}

const projectName = async ($: EngineInterface): Promise<string> => {
  try {
    return (await $.session.cwd()).split(/[\\/]/).filter(Boolean).at(-1) ?? ''
  } catch {
    return ''
  }
}

// Fails silently: a notification is never worth an error in the session. Resolves whether the notifier took it.
const notify = async ($: EngineInterface, notifier: Notifier, body: string): Promise<boolean> => {
  try {
    notifier.platform ??= await detectPlatform($)
    if (notifier.platform === 'unsupported') return false
    const project = await projectName($)
    const title = clip(project === '' ? APP_NAME : `${APP_NAME} · ${project}`, MAX_TITLE_LENGTH)
    const { argv, env } = commandFor(notifier.platform, title, clip(body, MAX_BODY_LENGTH))
    const ran = await $.process.run(argv, { timeoutMs: COMMAND_TIMEOUT_MS, ...(env === undefined ? {} : { env }) })
    return ran.exitCode === 0
  } catch {
    // Missing notifier binary, denied by the OS, or timed out.
    return false
  }
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

/** A notice as one desktop line: its title, then its body. */
const lineOf = (notice: { title: string; body?: string }): string => (notice.body === undefined || notice.body === '' ? notice.title : `${notice.title}: ${notice.body}`)

/** Tells the hub's Channels list when the notifier starts or stops failing; quiet without the hub. */
const reportFailing = async ($: EngineInterface, courier: Courier, isFailing: boolean): Promise<void> => {
  if (courier.isFailing === isFailing) return
  courier.isFailing = isFailing
  try {
    await $.mods.channelStatus({ id: CHANNEL_ID, status: isFailing ? 'error' : 'connected', ...(isFailing ? { detail: 'the desktop notifier failed' } : {}) })
  } catch {
    // No hub any more.
  }
}

/**
 * Shows what mods-hub queued for the desktop channel (a pull channel: the hub never calls this mod), at least once:
 * the cursor acknowledges only notices shown (or given up after MAX_TRIES failures), so a notice the notifier failed on,
 * or the process died on, comes back on the next collection; ids already shown are skipped. One collection at a time.
 */
const drain = async ($: EngineInterface, notifier: Notifier, courier: Courier): Promise<void> => {
  if (courier.isBusy) return
  courier.isBusy = true
  try {
    for (const notice of await $.mods.drain({ channel: CHANNEL_ID, after: courier.cursor })) {
      if (!courier.shown.includes(notice.id)) {
        const isShown = await notify($, notifier, lineOf(notice))
        await reportFailing($, courier, !isShown)
        if (!isShown) {
          courier.failures += 1
          if (courier.failures < MAX_TRIES) return
        }
        courier.shown = [...courier.shown, notice.id].slice(-SHOWN_KEEP)
      }
      courier.failures = 0
      courier.cursor = notice.id
    }
  } catch {
    // The hub went away: the next tick finds out again.
  } finally {
    courier.isBusy = false
  }
}

/**
 * With mods-hub installed: says hello, registers the `desktop` channel (the hub routes notifications to it by level,
 * presence and its own on/off switch) and starts collecting what it queued. Without the hub nothing happens.
 */
const connectHub = async ($: EngineInterface, notifier: Notifier, courier: Courier): Promise<void> => {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: [] })
  notifier.platform ??= await detectPlatform($)
  const isSupported = notifier.platform !== 'unsupported'
  try {
    await $.mods.registerChannel({
      id: CHANNEL_ID,
      title: 'Desktop',
      audience: 'me',
      delivery: 'pull',
      status: isSupported ? 'connected' : 'unconfigured',
      ...(isSupported ? {} : { detail: 'no desktop notifier for this OS' }),
    })
  } catch {
    return
  }
  courier.timer?.cancel()
  courier.timer = isSupported ? $.clock.every(DRAIN_MS, () => void drain($, notifier, courier)) : undefined
}

export const register: Register = (on, options) => {
  const minMs = (typeof options.minSeconds === 'number' ? options.minSeconds : DEFAULT_MIN_SECONDS) * 1000
  const isAttentionOn = options.attention !== false
  const notifier: Notifier = {}
  const courier: Courier = { cursor: null, shown: [], isBusy: false, failures: 0, isFailing: false }

  on('session.start', async ($, e, next) => {
    await connectHub($, notifier, courier)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const isMainTurn = e.agentId === undefined
    if (isMainTurn && e.reason !== 'aborted' && e.durationMs >= minMs) {
      const took = formatDuration(e.durationMs)
      const summary = e.reason === 'error' ? `Stopped on an error after ${took}` : `Finished in ${took}`
      await notify($, notifier, e.answer === '' || e.reason === 'error' ? summary : `${summary}: ${e.answer}`)
    }
    return result
  })

  on('classic.Notification', async ($, e, next) => {
    if (isAttentionOn && e.notification_type !== 'auth_success') {
      await notify($, notifier, e.message)
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
