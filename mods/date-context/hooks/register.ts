import type { EngineInterface, Register } from 'claude-code'

/** Prompts worth stamping: the person's own, and scheduled runs that nobody watches. */
const STAMPED_ORIGINS: readonly string[] = ['composer', 'bridge', 'sdk', 'scheduled-trigger']
const COMMAND_TIMEOUT_MS = 2000
const GIT_NOT_ON_A_BRANCH = 1

const pad = (n: number): string => String(n).padStart(2, '0')

/** ISO 8601 local date and time to the minute, with the UTC offset: 2026-10-07T14:03+02:00. */
const isoLocal = (ms: number): string => {
  const date = new Date(ms)
  const offset = -date.getTimezoneOffset()
  const sign = offset < 0 ? '-' : '+'
  const hours = pad(Math.floor(Math.abs(offset) / 60))
  const minutes = pad(Math.abs(offset) % 60)
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return `${day}T${pad(date.getHours())}:${pad(date.getMinutes())}${sign}${hours}:${minutes}`
}

const timeZoneName = (): string | undefined => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return undefined
  }
}

/** The branch checked out in the session's directory; undefined outside a git repository. */
const gitBranch = async ($: EngineInterface): Promise<string | undefined> => {
  try {
    const git = await $.process.run(['git', 'symbolic-ref', '--short', '-q', 'HEAD'], {
      timeoutMs: COMMAND_TIMEOUT_MS,
    })
    if (git.exitCode === 0) return git.stdout.trim() || undefined
    return git.exitCode === GIT_NOT_ON_A_BRANCH ? 'detached HEAD' : undefined
  } catch {
    return undefined
  }
}

const PLATFORM_NAMES: [RegExp, string][] = [
  [/^linux/i, 'Linux'],
  [/^darwin/i, 'macOS'],
  [/^(mingw|msys|cygwin)/i, 'Windows'],
]

const detectPlatform = async ($: EngineInterface): Promise<string | undefined> => {
  try {
    const uname = await $.process.run(['uname', '-s'], { timeoutMs: COMMAND_TIMEOUT_MS })
    const name = uname.stdout.trim()
    if (uname.exitCode === 0 && name !== '') return PLATFORM_NAMES.find(([pattern]) => pattern.test(name))?.[1] ?? name
  } catch {
    // No uname: fall through to the one variable Windows sets.
  }
  return (await $.env.get('OS')) === 'Windows_NT' ? 'Windows' : undefined
}

export const register: Register = on => {
  let platform: Promise<string | undefined> | undefined

  on('prompt.submit', async ($, e, next) => {
    if (!STAMPED_ORIGINS.includes(e.origin.kind) || e.text.startsWith('/')) return next(e)

    platform ??= detectPlatform($)
    const [now, branch, os] = await Promise.all([$.clock.now(), gitBranch($), platform])

    const zone = timeZoneName()
    const facts = [
      zone === undefined ? isoLocal(now) : `${isoLocal(now)} (${zone})`,
      ...(branch === undefined ? [] : [`git branch ${branch}`]),
      ...(os === undefined ? [] : [os]),
    ]
    return next({ ...e, context: [...(e.context ?? []), `Current context: ${facts.join(', ')}.`] })
  })
}
