import type { EngineInterface, Register } from 'claude-code'

type Platform = 'macos' | 'linux' | 'windows'
type Notifier = { platform?: Platform | 'unsupported' }
type Command = { argv: string[]; env?: Record<string, string> }

const DEFAULT_MIN_SECONDS = 30
const COMMAND_TIMEOUT_MS = 5000
const MAX_TITLE_LENGTH = 60
const MAX_BODY_LENGTH = 200
const APP_NAME = 'Claude Code'

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
  `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_NAME}').Show([Windows.UI.Notifications.ToastNotification]::new($xml))`,
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

// Fails silently: a notification is never worth an error in the session.
const notify = async ($: EngineInterface, notifier: Notifier, body: string): Promise<void> => {
  try {
    notifier.platform ??= await detectPlatform($)
    if (notifier.platform === 'unsupported') return
    const project = await projectName($)
    const title = clip(project === '' ? APP_NAME : `${APP_NAME} · ${project}`, MAX_TITLE_LENGTH)
    const { argv, env } = commandFor(notifier.platform, title, clip(body, MAX_BODY_LENGTH))
    await $.process.run(argv, { timeoutMs: COMMAND_TIMEOUT_MS, ...(env === undefined ? {} : { env }) })
  } catch {
    // Missing notifier binary, denied by the OS, or timed out.
  }
}

export const register: Register = (on, options) => {
  const minMs = (typeof options.minSeconds === 'number' ? options.minSeconds : DEFAULT_MIN_SECONDS) * 1000
  const isAttentionOn = options.attention !== false
  const notifier: Notifier = {}

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
