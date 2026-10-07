import type { EngineInterface, Register } from 'claude-code'

import { NO_SPACE, SUGGESTIONS, describeDisk, isHeavyWrite, parseDf, shortage } from './disk'
import type { DiskUsage } from './disk'

type Settings = { minFreeGb: number; maxUsedPercent: number }
type Reading = { at: number; disk: DiskUsage }
/** The df readings kept for a minute, per working directory, and whether this machine has `df` at all. */
type Guard = { readings: Map<string, Reading>; isDfMissing: boolean }

const CACHE_MS = 60_000
const DF_TIMEOUT_MS = 5000
const DEFAULT_MIN_FREE_GB = 2
const DEFAULT_MAX_USED_PERCENT = 95
const MAX_COMMAND_LENGTH = 60

const numberOr = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

/** How full the disk under `cwd` is. `isFresh` says whether `df` was run for this answer or a reading under a minute old was reused. */
const readDisk = async ($: EngineInterface, guard: Guard, cwd: string, isForced: boolean): Promise<{ disk: DiskUsage; isFresh: boolean } | undefined> => {
  const now = await $.clock.now()
  const cached = guard.readings.get(cwd)
  if (!isForced && cached !== undefined && now - cached.at < CACHE_MS) return { disk: cached.disk, isFresh: false }
  if (guard.isDfMissing) return undefined

  try {
    const { exitCode, stdout } = await $.process.run(['df', '-Pk', '.'], { cwd, timeoutMs: DF_TIMEOUT_MS })
    const disk = exitCode === 0 ? parseDf(stdout) : undefined
    if (disk === undefined) return undefined
    guard.readings.set(cwd, { at: now, disk })
    return { disk, isFresh: true }
  } catch (error) {
    // A machine without `df` (a bare Windows shell) is not worth asking again.
    if (String(error).includes('ENOENT')) guard.isDfMissing = true
    return undefined
  }
}

const noteFor = (problem: string, command: string, hasFailed: boolean): string => {
  const shown = command.length > MAX_COMMAND_LENGTH ? `${command.slice(0, MAX_COMMAND_LENGTH - 1)}…` : command
  const lead = hasFailed
    ? `disk-guard: the command failed because the disk is full (${problem}). Free some space before trying again.`
    : `disk-guard: ${problem}, and \`${shown}\` writes a lot. If it fails with "No space left on device", free some space and run it again.`
  return [lead, ...SUGGESTIONS.map(suggestion => `- ${suggestion}`)].join('\n')
}

const toastFor = (problem: string, hasFailed: boolean): string =>
  `${hasFailed ? 'disk full' : 'disk nearly full'}: ${problem}\ntry: du -sh node_modules ~/.cache | sort -h, docker system df`

export const register: Register = (on, options) => {
  const settings: Settings = {
    minFreeGb: Math.max(0, numberOr(options.minFreeGb, DEFAULT_MIN_FREE_GB)),
    maxUsedPercent: numberOr(options.maxUsedPercent, DEFAULT_MAX_USED_PERCENT),
  }
  const guard: Guard = { readings: new Map(), isDfMissing: false }

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const cwd = await $.session.cwd()
    let problem: string | undefined
    if (isHeavyWrite(e.command)) {
      const reading = await readDisk($, guard, cwd, false)
      problem = reading === undefined ? undefined : shortage(reading.disk, settings.minFreeGb, settings.maxUsedPercent)
      // One toast per fresh reading: a string of installs in a minute is not a string of toasts.
      if (problem !== undefined && reading?.isFresh === true) $.ui.toast(toastFor(problem, false))
    }

    const ran = await next(e)
    if (ran.deny !== undefined) return ran

    const hasFailedForSpace = ran.isError === true && NO_SPACE.test(ran.text ?? '')
    if (hasFailedForSpace) {
      const reading = await readDisk($, guard, cwd, true)
      problem = reading === undefined ? 'no space left on device' : describeDisk(reading.disk)
      $.ui.toast(toastFor(problem, true))
    }
    return problem === undefined ? ran : { ...ran, context: [...(ran.context ?? []), noteFor(problem, e.command, hasFailedForSpace)] }
  })
}
