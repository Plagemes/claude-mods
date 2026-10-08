import type { EngineInterface, PromptOrigin, Register, Timer } from 'claude-code'

import { calendar, currentStreak, days, isoOf, localDay, longestStreak, parseIso, parseMilestones } from './streak'
import type { DayNumber, Run } from './streak'

type Settings = { isPersistent: boolean; milestones: number[] }
/** What is saved between sessions: the active days (`YYYY-MM-DD`), and the longest streak ever, which outlives the days kept. */
type Saved = { days: string[]; best: { length: number; end: string } | null }
/** What lives only while the module is loaded: the timer that clears the status line, and the last day already recorded. */
type Display = { clearTimer: Timer | undefined; lastDay: DayNumber | undefined }

const STORE_KEY = 'streaks'
const KEPT_DAYS = 400
const CALENDAR_DAYS = 30
/** A streak of one day is not much of a streak: the status line waits for two. */
const MIN_STATUS_STREAK = 2
const STATUS_MS = 10_000

const isPerson = (origin: PromptOrigin): boolean =>
  ['composer', 'bridge', 'sdk', 'slack-ping'].includes(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)

const readSaved = (value: unknown): Saved => {
  const saved = typeof value === 'object' && value !== null ? (value as Partial<Saved>) : {}
  const best = saved.best
  return {
    days: Array.isArray(saved.days) ? saved.days.filter((day): day is string => typeof day === 'string') : [],
    best: typeof best === 'object' && best !== null && typeof best.length === 'number' && typeof best.end === 'string' ? best : null,
  }
}

const activeDays = (saved: Saved): Set<DayNumber> =>
  new Set(saved.days.map(parseIso).filter((day): day is DayNumber => day !== undefined))

/** The longest streak among the saved days and the one saved as the best, whichever is longer. */
const longest = (saved: Saved, active: ReadonlySet<DayNumber>): Run => {
  const computed = longestStreak(active)
  const bestEnd = saved.best === null ? undefined : parseIso(saved.best.end)
  return saved.best !== null && bestEnd !== undefined && saved.best.length > computed.length ? { length: saved.best.length, end: bestEnd } : computed
}

/** Puts the streak in the status line, and unless it is meant to stay, takes it out again after ten seconds. */
const showStatus = ($: EngineInterface, display: Display, settings: Settings, streak: number): void => {
  display.clearTimer?.cancel()
  display.clearTimer = undefined
  if (streak < MIN_STATUS_STREAK) return
  $.ui.status(`🔥 ${days(streak)} streak`)
  if (!settings.isPersistent) {
    display.clearTimer = $.clock.after(STATUS_MS, () => $.ui.status(undefined))
  }
}

/** At the start of a session: shows the streak that is alive, if there is one. */
const announce = async ($: EngineInterface, display: Display, settings: Settings): Promise<void> => {
  try {
    const active = activeDays(readSaved(await $.store.get(STORE_KEY)))
    showStatus($, display, settings, currentStreak(active, localDay(await $.clock.now())))
  } catch {
    // A streak is never worth an error at the start of a session.
  }
}

/** Counts today as active, the first time a prompt of the person's arrives on a day; and says so when it reaches a milestone. */
const recordPrompt = async ($: EngineInterface, display: Display, settings: Settings): Promise<void> => {
  try {
    const today = localDay(await $.clock.now())
    if (display.lastDay === today) return
    display.lastDay = today

    const saved = readSaved(await $.store.get(STORE_KEY))
    const active = activeDays(saved)
    if (active.has(today)) return
    active.add(today)

    const current = currentStreak(active, today)
    const best = longest(saved, active)
    const kept = [...active].sort((a, b) => a - b).slice(-KEPT_DAYS)
    await $.store.set(STORE_KEY, { days: kept.map(isoOf), best: { length: best.length, end: isoOf(best.end) } } satisfies Saved)

    showStatus($, display, settings, current)
    if (settings.milestones.includes(current)) $.ui.toast(`🔥 ${days(current)} in a row! Milestone reached.`)
  } catch {
    // Same here: the prompt has gone through, and the count can catch up with the next one.
    display.lastDay = undefined
  }
}

const describeStreaks = async ($: EngineInterface): Promise<string> => {
  const saved = readSaved(await $.store.get(STORE_KEY))
  const active = activeDays(saved)
  if (active.size === 0) return 'No days recorded yet. Send a prompt and your streak starts today.'

  const today = localDay(await $.clock.now())
  const current = currentStreak(active, today)
  const best = longest(saved, active)
  const recent = [...active].filter(day => day > today - CALENDAR_DAYS && day <= today).length
  const first = isoOf(Math.min(...active))
  const keepAlive = current > 0 && !active.has(today) ? ' (send a prompt today to keep it going)' : ''

  return [
    current > 0 ? `🔥 Current streak: ${days(current)}${keepAlive}` : '🔥 No streak right now: send a prompt to start one.',
    `🏆 Longest streak: ${days(best.length)}, ended ${isoOf(best.end)}`,
    `📅 Active on ${recent} of the last ${CALENDAR_DAYS} days, and on ${days(active.size)} since ${first}`,
    '',
    ...calendar(active, today, CALENDAR_DAYS),
    '',
    '● active day   · quiet day   [ ] today',
  ].join('\n')
}

export const register: Register = (on, options) => {
  const settings: Settings = { isPersistent: options.persistent === true, milestones: parseMilestones(String(options.milestones ?? '')) }
  const display: Display = { clearTimer: undefined, lastDay: undefined }

  on('session.start', async ($, e, next) => {
    await registerCommand($, { name: 'streak', description: 'Shows your streak of days with Claude, and the last 30 days as a calendar.' })
    await announce($, display, settings)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    // From a timer, so the prompt never waits for the store.
    if (result.drop === undefined && isPerson(e.origin)) {
      $.clock.after(0, () => {
        void recordPrompt($, display, settings)
      })
    }
    return result
  })

  on('command.run', { command: 'streak' }, async $ => ({ text: await describeStreaks($) }))
}

/** Registers a slash command. A refused name (Claude Code's own, or another mod's) is reported as a notice, never thrown, so the rest of session.start still runs. */
async function registerCommand($: EngineInterface, spec: Parameters<EngineInterface['command']['register']>[0]): Promise<boolean> {
  try {
    await $.command.register(spec)
    return true
  } catch (error) {
    $.ui.log(`${$.plugin.name}: /${spec.name} was not registered (${error instanceof Error ? error.message : String(error)}).`)
    return false
  }
}
