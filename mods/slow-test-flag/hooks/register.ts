import type { EngineInterface, Register } from 'claude-code'

import { HINTS, formatMs, hasRunTests, isTestCommand, parseTimings, runnerOf, slowest } from './durations'
import type { Runner, Timing } from './durations'

type Settings = { top: number; thresholdMs: number; isStatusOn: boolean }
type LastRun = { at: number; command: string; runner?: Runner; level: Timing['level']; hasTimings: boolean; items: Timing[] }

const STORE_KEY = 'last-run'
const KEPT = 20
const LISTED = 10
const TOAST_MS = 10_000
const MAX_NAME_LENGTH = 70
const MINUTE_MS = 60_000

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

/** Reads one finished test command's output, keeps what it found for `/slow-tests`, and says what is slow. */
const inspect = async ($: EngineInterface, hinted: Set<Runner>, settings: Settings, command: string, output: string): Promise<void> => {
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
        $.ui.toast(`no per-test times in that output: ${hint}`)
      }
      return
    }

    const slowestOne = items[0]
    if (settings.isStatusOn) {
      $.ui.status(slowestOne === undefined ? undefined : `🐢 slowest ${level === 'test' ? 'test' : 'file'}: ${formatMs(slowestOne.ms)} · ${clip(slowestOne.name, 40)}`)
    }
    if (slowestOne !== undefined) {
      const shown = items.slice(0, settings.top)
      $.ui.toast([`slowest ${level === 'test' ? 'tests' : 'files'} in that run:`, ...rows(shown)].join('\n'), { timeoutMs: TOAST_MS })
    }
  } catch {
    // Timing is a nicety: a test run is never worth an error in the session.
  }
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
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && e.run_in_background !== true && isTestCommand(e.command)) {
      await inspect($, hinted, settings, e.command, ran.text ?? '')
    }
    return ran
  })

  on('command.run', { command: 'slow-tests' }, async $ => {
    const run = readLastRun(await $.store.get(STORE_KEY))
    return { text: describeLastRun(run, await $.clock.now(), settings.thresholdMs) }
  })
}
