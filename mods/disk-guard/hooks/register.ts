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
  await hubHello($, { version: await ownVersion($), publishes: ['risk.blocked'], consumes: [] })
}

/**
 * A full or nearly full disk, once per fresh reading: a warning (an error when the command already failed for lack of space)
 * through the hub (your phone channel while you are away), a toast without it, and `risk.blocked` on the hub's bus.
 * Nothing is blocked (the command runs); the event is how guardian and audit-trail see the warning.
 */
async function warn($: EngineInterface, problem: string, cwd: string, hasFailed: boolean): Promise<void> {
  await hubPublish($, { topic: 'risk.blocked', data: { guard: 'disk-guard', tool: 'Bash', reason: hasFailed ? `a command failed for lack of disk space: ${problem}` : `a heavy command is about to run on a nearly full disk: ${problem}`, severity: hasFailed ? 'high' : 'medium', path: cwd } })
  await hubNotify($, { level: hasFailed ? 'error' : 'warning', title: toastFor(problem, hasFailed) })
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    minFreeGb: Math.max(0, numberOr(options.minFreeGb, DEFAULT_MIN_FREE_GB)),
    maxUsedPercent: numberOr(options.maxUsedPercent, DEFAULT_MAX_USED_PERCENT),
  }
  const guard: Guard = { readings: new Map(), isDfMissing: false }

  on('session.start', async ($, e, next) => {
    await greetHub($)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const cwd = await $.session.cwd()
    let problem: string | undefined
    if (isHeavyWrite(e.command)) {
      const reading = await readDisk($, guard, cwd, false)
      problem = reading === undefined ? undefined : shortage(reading.disk, settings.minFreeGb, settings.maxUsedPercent)
      // One toast per fresh reading: a string of installs in a minute is not a string of toasts.
      if (problem !== undefined && reading?.isFresh === true) await warn($, problem, cwd, false)
    }

    const ran = await next(e)
    if (ran.deny !== undefined) return ran

    const hasFailedForSpace = ran.isError === true && NO_SPACE.test(ran.text ?? '')
    if (hasFailedForSpace) {
      const reading = await readDisk($, guard, cwd, true)
      problem = reading === undefined ? 'no space left on device' : describeDisk(reading.disk)
      await warn($, problem, cwd, true)
    }
    return problem === undefined ? ran : { ...ran, context: [...(ran.context ?? []), noteFor(problem, e.command, hasFailedForSpace)] }
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
