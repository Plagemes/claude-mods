import type { EngineInterface, Register } from 'claude-code'

type Pack = 'minimal' | 'retro' | 'nature'
type SoundEvent = 'done' | 'error' | 'permission' | 'green'
type Settings = { pack: Pack; enabled: Record<SoundEvent, boolean>; gain: number; longTurnMs: number }
/** When each sound last played, so a burst of failures or prompts is one sound. */
type Player = { lastPlayed: Partial<Record<SoundEvent, number>> }

const PACKS: readonly Pack[] = ['minimal', 'retro', 'nature']
const EVENTS: readonly SoundEvent[] = ['done', 'error', 'permission', 'green']
const WHEN: Readonly<Record<SoundEvent, string>> = {
  done: 'a long turn ends',
  error: 'a command fails',
  permission: 'Claude needs your approval',
  green: 'tests pass',
}
const COOLDOWN_MS: Readonly<Record<SoundEvent, number>> = { done: 0, error: 8000, permission: 2000, green: 4000 }
const DEFAULT_LONG_TURN_SECONDS = 20
const DEFAULT_VOLUME = 1
const MAX_VOLUME = 4
/** The longest clip is 1.55 s: previews start each sound this far after the last, so they never overlap. */
const PREVIEW_SPACING_MS = 1700

/** A test runner at the start of one part of a command line (after variables and `npx`, `poetry run`, `python -m`...), not just named in it. */
const TEST_RUNNER =
  /^(?:\w+=\S*\s+)*(?:(?:sudo|time|npx|bunx|pnpx|exec|(?:bundle|pnpm|yarn|npm) exec|(?:poetry|uv|pipenv|pdm|hatch) run|python[\d.]* -m)\s+)*(?:\S*\/)?(?:jest|vitest|pytest|mocha|rspec|phpunit|tox|ctest|go test|cargo (?:test|nextest)|deno test|bun test|dotnet test|mvn test|gradlew? test|(?:npm|yarn|pnpm|bun)(?: run)? test(?::[\w:-]+)?|npm t)(?=\s|$)/
const COMMAND_PARTS = /&&|\|\||[;|&\n()]/
// A runner that printed failures but still exited 0 (for example `npm test || true`).
const FAILURE_REPORT = /\b[1-9]\d* (?:failed|failing|failures?)\b|^FAIL\b|\bFAILED\b/m

/** Whether the command runs tests (`npm test`, `cd web && npx vitest run`), rather than merely naming a runner (`cat jest.config.js`). */
const isTestCommand = (command: string): boolean => command.split(COMMAND_PARTS).some(part => TEST_RUNNER.test(part.trim()))

const numberOr = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

const asset = (pack: Pack, event: SoundEvent): string => `assets/${pack}/${event}.wav`

const packOf = (value: unknown): Pack => PACKS.find(pack => pack === value) ?? 'minimal'

/** Plays a sound at most once per cooldown, from a timer, so nothing ever waits for it; a machine with no player stays silent. */
const play = async ($: EngineInterface, player: Player, settings: Settings, event: SoundEvent): Promise<void> => {
  if (!settings.enabled[event] || settings.gain <= 0) return
  const now = await $.clock.now()
  const last = player.lastPlayed[event]
  if (last !== undefined && now - last < COOLDOWN_MS[event]) return
  player.lastPlayed[event] = now

  $.clock.after(0, () => {
    $.audio.play({ asset: asset(settings.pack, event) }, { gain: settings.gain }).catch(() => undefined)
  })
}

const GENERIC_PLATFORM_NOTE = 'Claude Code plays sounds with afplay, which only macOS has: on Linux and Windows terminals the sounds are silent for now.'

/** What to say about whether this machine can play sound at all; Claude Code reports a clip it cannot play as played, so ask the system. */
const platformNote = async ($: EngineInterface): Promise<string> => {
  try {
    const kernel = (await $.process.run(['uname', '-s'], { timeoutMs: 3000 })).stdout.trim()
    if (kernel === 'Darwin') return 'This is macOS: sounds play through afplay.'
    return kernel === '' ? GENERIC_PLATFORM_NOTE : `Claude Code plays sounds with afplay, which only macOS has, so nothing is heard on this ${kernel} machine.`
  } catch {
    return GENERIC_PLATFORM_NOTE
  }
}

const describeSettings = (settings: Settings, platform: string): string[] => [
  `Pack: ${settings.pack} (minimal, retro, nature; change it in /config). Volume: ${settings.gain}.`,
  ...EVENTS.map(event => `  ${event.padEnd(10)} ${settings.enabled[event] ? 'on ' : 'off'}  when ${WHEN[event]}`),
  platform,
]

/** `/soundpack`: plays the current pack's four sounds, a pack's, or one event's; says what is set and whether playback worked. */
const preview = async ($: EngineInterface, settings: Settings, args: string): Promise<string> => {
  const word = args.trim().toLowerCase()
  const pack = PACKS.find(candidate => candidate === word)
  const event = EVENTS.find(candidate => candidate === word)
  if (word !== '' && pack === undefined && event === undefined) {
    return `Usage: /soundpack [${PACKS.join(' | ')} | ${EVENTS.join(' | ')}]. With no argument it plays the four sounds of the current pack.`
  }

  const chosen = pack ?? settings.pack
  const events = event === undefined ? EVENTS : [event]
  const gain = Math.max(0.1, settings.gain)
  events.slice(1).forEach((next, i) => {
    $.clock.after((i + 1) * PREVIEW_SPACING_MS, () => {
      $.audio.play({ asset: asset(chosen, next) }, { gain }).catch(() => undefined)
    })
  })
  // Only the first clip is waited for, to learn whether this machine can play sound at all.
  const failure = await $.audio.play({ asset: asset(chosen, events[0] ?? 'done') }, { gain }).then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )

  const sounds = event === undefined ? `the ${chosen} pack: ${events.join(', ')}` : `${event} from the ${chosen} pack`
  return [
    failure === undefined ? `Playing ${sounds}.` : `Could not play ${sounds}: ${failure.replace(/\.$/, '')}.`,
    ...describeSettings(settings, await platformNote($)),
  ].join('\n')
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    pack: packOf(options.pack),
    enabled: { done: options.done !== false, error: options.error !== false, permission: options.permission !== false, green: options.green !== false },
    gain: Math.min(MAX_VOLUME, Math.max(0, numberOr(options.volume, DEFAULT_VOLUME))),
    longTurnMs: Math.max(0, numberOr(options.longTurnSeconds, DEFAULT_LONG_TURN_SECONDS)) * 1000,
  }
  const player: Player = { lastPlayed: {} }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'soundpack',
      description: 'Plays the sounds of your sound pack, so you can hear them.',
      argumentHint: `[${PACKS.join('|')}|${EVENTS.join('|')}]`,
    })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.reason === 'answer' && e.durationMs > settings.longTurnMs) await play($, player, settings, 'done')
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran

    const isTestRun = isTestCommand(e.command)
    const hasFailed = ran.isError === true || (isTestRun && FAILURE_REPORT.test(ran.text ?? ''))
    if (hasFailed) await play($, player, settings, 'error')
    else if (isTestRun && e.run_in_background !== true) await play($, player, settings, 'green')
    return ran
  })

  // The permission dialog raises PermissionRequest and Notification together; the cooldown makes that one sound.
  on('classic.PermissionRequest', async ($, e, next) => {
    const answer = await next(e)
    if (answer.decision === undefined) await play($, player, settings, 'permission')
    return answer
  })

  on('classic.Notification', async ($, e, next) => {
    if (e.notification_type === 'permission_prompt') await play($, player, settings, 'permission')
    return next(e)
  })

  on('command.run', { command: 'soundpack' }, async ($, e) => ({ text: await preview($, settings, e.args) }))
}
