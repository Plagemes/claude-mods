import type { EngineInterface, Register } from 'claude-code'

import { HINTS, formatMs, hasRunTests, isTestCommand, parseTimings, runnerOf, slowest } from './durations'
import type { Runner, Timing } from './durations'
import { isTestCommand as isTestCommandAnywhere } from './shared/test-runners'

type Settings = { top: number; thresholdMs: number; isStatusOn: boolean }
type LastRun = { at: number; command: string; runner?: Runner; level: Timing['level']; hasTimings: boolean; items: Timing[] }

const STORE_KEY = 'last-run'
const KEPT = 20
const LISTED = 10
const TOAST_MS = 10_000
const MAX_NAME_LENGTH = 70
const MINUTE_MS = 60_000
/** mods-hub publishes `test.result` from a timer just after the tool returns; wait for it. */
const HUB_SETTLE_MS = 250

const numberOr = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

const baseName = (path: string): string => path.split(/[\\/]/).at(-1) ?? path

/** `login works  (auth.test.ts)`: the name, and its file when the name does not already say it. */
const label = (timing: Timing): string => {
  const name = clip(timing.name, MAX_NAME_LENGTH)
  return timing.file === undefined || timing.name.includes(timing.file) ? name : `${name}  (${baseName(timing.file)})`
}

const rows = (items: readonly Timing[]): string[] => items.map((timing, i) => `${String(i + 1).padStart(2)}. ${formatMs(timing.ms).padStart(8)}  ${label(timing)}`)

const ago = (ms: number): string => {
  if (ms < MINUTE_MS) return 'just now'
  const minutes = Math.round(ms / MINUTE_MS)
  if (minutes < 60) return `${minutes} min ago`
  return minutes < 24 * 60 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / (24 * 60))} d ago`
}

const readLastRun = (value: unknown): LastRun | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const run = value as Partial<LastRun>
  return typeof run.at === 'number' && typeof run.command === 'string' && Array.isArray(run.items) ? (run as LastRun) : undefined
}

/** The hub's `test.result` for the run that started at `since` (not another run's), when mods-hub saw it: its total time. */
const hubRunTime = async ($: EngineInterface, command: string, since: number): Promise<{ durationMs: number | undefined } | undefined> => {
  try {
    const event = await $.mods.latest({ topic: 'test.result' })
    const data: unknown = event?.data
    if (event === null || event.at < since || typeof data !== 'object' || data === null) return undefined
    const { command: ran, durationMs } = data as { command?: unknown; durationMs?: unknown }
    // The hub keeps the first 200 characters of the command; a run it did not see (test-watch's own) names another one.
    if (typeof ran !== 'string' || !command.startsWith(ran)) return undefined
    return { durationMs: typeof durationMs === 'number' && Number.isFinite(durationMs) ? durationMs : undefined }
  } catch {
    return undefined
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

/** Says hello to mods-hub when it is installed. */
const greetHub = async ($: EngineInterface): Promise<void> => {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: ['test.result'] })
}

/** The list of slow tests: a hub notification (title, rows as its body) when mods-hub is installed, the multi-line toast otherwise. */
const announce = async ($: EngineInterface, heading: string, lines: string[]): Promise<void> => {
  try {
    await $.mods.notify({ level: 'info', title: heading, body: lines.join('\n'), topic: 'test.result' })
  } catch {
    $.ui.toast([heading, ...lines].join('\n'), { timeoutMs: TOAST_MS })
  }
}

/**
 * Reads one finished test command's output, keeps what it found for `/slow-tests`, and says what is slow.
 * `runMs` is the run's total time when mods-hub knew it.
 */
const inspect = async ($: EngineInterface, hinted: Set<Runner>, settings: Settings, command: string, output: string, runMs?: number): Promise<void> => {
  try {
    const timings = parseTimings(output)
    if (timings.length === 0 && !hasRunTests(output)) return

    const runner = runnerOf(command, output)
    const { level, items } = slowest(timings, KEPT, settings.thresholdMs)
    const run: LastRun = { at: await $.clock.now(), command, level, hasTimings: timings.length > 0, items, ...(runner === undefined ? {} : { runner }) }
    await $.store.set(STORE_KEY, run)

    if (timings.length === 0) {
      const hint = runner === undefined || hinted.has(runner) ? undefined : HINTS[runner]
      if (runner !== undefined && hint !== undefined) {
        hinted.add(runner)
        await hubNotify($, { level: 'info', title: `no per-test times in that output: ${hint}`, topic: 'test.result' })
      }
      return
    }

    const slowestOne = items[0]
    if (settings.isStatusOn) {
      $.ui.status(slowestOne === undefined ? undefined : `🐢 slowest ${level === 'test' ? 'test' : 'file'}: ${formatMs(slowestOne.ms)} · ${clip(slowestOne.name, 40)}`)
    }
    if (slowestOne !== undefined) {
      const shown = items.slice(0, settings.top)
      const took = runMs === undefined ? '' : ` (${formatMs(Math.round(runMs))} in all)`
      await announce($, `slowest ${level === 'test' ? 'tests' : 'files'} in that run${took}:`, rows(shown))
    }
  } catch {
    // Timing is a nicety: a test run is never worth an error in the session.
  }
}

/** What the hook saw of one test command, for the hub path. */
type Call = { command: string; output: string; since: number }

/** The output is read the same with the hub; the hub adds the run's total time. */
const inspectWithHub = async ($: EngineInterface, hinted: Set<Runner>, settings: Settings, call: Call): Promise<void> => {
  const hub = await hubRunTime($, call.command, call.since)
  await inspect($, hinted, settings, call.command, call.output, hub?.durationMs)
}

const describeLastRun = (run: LastRun | undefined, now: number, thresholdMs: number): string => {
  if (run === undefined) {
    return 'No test run seen yet. When a test command finishes, its slowest tests are listed here (Jest, Vitest, pytest, go test, cargo test).'
  }
  const when = `${run.command.length > 60 ? `${run.command.slice(0, 59)}…` : run.command} (${ago(now - run.at)})`
  if (!run.hasTimings) {
    const hint = run.runner === undefined ? undefined : HINTS[run.runner]
    return `The last run, ${when}, printed no per-test times.${hint === undefined ? '' : ` Try this: ${hint}.`}`
  }
  if (run.items.length === 0) return `Nothing took ${formatMs(thresholdMs)} or longer in the last run, ${when}.`
  const unit = run.level === 'test' ? 'tests' : 'files'
  return [`Slowest ${unit} in the last run, ${when}:`, ...rows(run.items.slice(0, LISTED))].join('\n')
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    top: Math.max(1, Math.round(numberOr(options.top, 5))),
    thresholdMs: Math.max(0, numberOr(options.thresholdMs, 100)),
    isStatusOn: options.status !== false,
  }
  const hinted = new Set<Runner>()

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'slow-tests', description: "Lists the slowest tests of the last test run." })
    await greetHub($)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const since = await $.clock.now()
    const ran = await next(e)
    if (ran.deny !== undefined || e.run_in_background === true) return ran

    const command = e.command
    const output = ran.text ?? ''
    if (!isTestCommand(command) && !isTestCommandAnywhere(command)) return ran

    if ((await hubMode($)) === undefined) {
      await inspect($, hinted, settings, command, output)
    } else {
      // With the hub, the run is also known by its `test.result`, which brings the total time the output may not print.
      $.clock.after(HUB_SETTLE_MS, () => void inspectWithHub($, hinted, settings, { command, output, since }))
    }
    return ran
  })

  on('command.run', { command: 'slow-tests' }, async $ => {
    const run = readLastRun(await $.store.get(STORE_KEY))
    return { text: describeLastRun(run, await $.clock.now(), settings.thresholdMs) }
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
