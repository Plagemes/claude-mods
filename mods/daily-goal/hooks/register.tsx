import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DailyGoalEntry, DailyGoalQuestion } from '../types'
import { clearGoal, closeGoal, dayLabel, daysBefore, entryFor, goalSection, historyText, localDate, markAsked, parseRequest, questionFor, readEntries, setGoal } from './goals'

type Dollar = EngineInterface
type Settings = { askAfterHour: number; shouldTellClaude: boolean }

const COMMAND = 'daily-goal'
const ARGUMENT_HINT = '[<goal> | done | clear | history]'
const DEFAULT_ASK_AFTER_HOUR = 18

const todayState = atom({ plugin: 'daily-goal', key: 'today' } as const, null)
const questionState = atom({ plugin: 'daily-goal', key: 'question' } as const, null)
const hiddenState = atom({ plugin: 'daily-goal', key: 'isHidden' } as const, false)

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const storeKey = (root: string): string => `goals:${root.replace(/[\\/]+$/, '')}`

function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  return `${Math.floor(minutes / 60)} h ago`
}

async function loadEntries($: Dollar): Promise<DailyGoalEntry[]> {
  return readEntries(await $.store.get(storeKey(await $.session.root())))
}

/** Saves the entries and puts today's goal and the pending question where the band reads them. */
async function settle($: Dollar, settings: Settings, entries: readonly DailyGoalEntry[], shouldSave: boolean): Promise<void> {
  if (shouldSave) await $.store.set(storeKey(await $.session.root()), { entries })
  const now = await $.clock.now()
  const today = localDate(now)
  const question = questionFor(entries, today, new Date(now).getHours(), settings.askAfterHour)
  await update($, todayState, () => entryFor(entries, today) ?? null)
  await update($, questionState, was => (sameQuestion(was, question) ? was : question))
}

const sameQuestion = (a: DailyGoalQuestion | null, b: DailyGoalQuestion | null): boolean =>
  a?.date === b?.date && a?.text === b?.text && a?.isToday === b?.isToday

/** Re-reads the store (another session may have changed it) and refreshes the band. */
async function refresh($: Dollar, settings: Settings): Promise<void> {
  await settle($, settings, await loadEntries($), false)
}

async function changeGoals($: Dollar, settings: Settings, change: (entries: DailyGoalEntry[], today: string, now: number) => DailyGoalEntry[]): Promise<DailyGoalEntry[]> {
  const now = await $.clock.now()
  const entries = change(await loadEntries($), localDate(now), now)
  await settle($, settings, entries, true)
  return entries
}

async function markDone($: Dollar, settings: Settings, day: string): Promise<string | undefined> {
  let reached: string | undefined
  await changeGoals($, settings, (entries, _today, now) => {
    reached = entryFor(entries, day)?.text
    return reached === undefined ? entries : closeGoal(entries, day, 'done', now)
  })
  if (reached !== undefined) await hubNotify($, { level: 'success', title: `🎉 Goal reached: ${reached}` })
  return reached
}

async function answer($: Dollar, settings: Settings, question: DailyGoalQuestion, choice: 'yes' | 'no' | 'not-yet'): Promise<void> {
  if (choice === 'yes') {
    await markDone($, settings, question.date)
    return
  }
  await changeGoals($, settings, (entries, _today, now) =>
    choice === 'not-yet' ? markAsked(entries, question.date) : closeGoal(entries, question.date, 'missed', now),
  )
}

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: Dollar): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Says hello to mods-hub when it is installed. */
async function greetHub($: Dollar): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: [] })
}

async function editGoal($: Dollar, text: string): Promise<void> {
  await $.prompt.fill({ text: `/${COMMAND} ${text}`, mode: 'replace' })
}

async function runCommand($: Dollar, settings: Settings, args: string): Promise<string> {
  const request = parseRequest(args)
  const now = await $.clock.now()
  const today = localDate(now)
  switch (request.kind) {
    case 'set': {
      const had = entryFor(await loadEntries($), today)
      await changeGoals($, settings, entries => setGoal(entries, today, request.text, now))
      await update($, hiddenState, () => false)
      return `🎯 ${had === undefined ? "Today's goal" : "Today's goal is now"}: ${request.text}. It stays above the prompt; /${COMMAND} done when you get there.`
    }
    case 'done': {
      const reached = await markDone($, settings, today)
      return reached === undefined ? `No goal set for today. /${COMMAND} <goal> sets one.` : `🎉 Goal reached: ${reached}`
    }
    case 'clear': {
      const had = entryFor(await loadEntries($), today)
      if (had === undefined) return 'No goal set for today.'
      await changeGoals($, settings, entries => clearGoal(entries, today))
      return `Cleared today's goal (${had.text}).`
    }
    case 'history':
      return historyText(await loadEntries($), today)
    case 'show': {
      const entries = await loadEntries($)
      const goal = entryFor(entries, today)
      await update($, hiddenState, () => false)
      await settle($, settings, entries, false)
      if (goal === undefined) return `No goal set for today. /${COMMAND} <goal> sets one, like /${COMMAND} ship the login fix.`
      const state = goal.status === 'done' ? '✓ reached' : goal.status === 'missed' ? '✗ missed' : `set ${ago(now - goal.setAt)}`
      return `🎯 Today's goal: ${goal.text} (${state}).`
    }
    case 'usage':
      return `✗ ${request.reason} Usage: /${COMMAND} ${ARGUMENT_HINT}`
  }
}

export const register: Register = (on, options) => {
  const hour = Number(options.askAfterHour)
  const settings: Settings = {
    askAfterHour: Number.isInteger(hour) && hour >= 0 && hour <= 24 ? hour : DEFAULT_ASK_AFTER_HOUR,
    shouldTellClaude: options.tellClaude !== false,
  }

  on('session.start', async ($, e, next) => {
    afterStart($, 'daily-goal', () => greetHub($))
    await registerCommand($, { name: 'daily-goal', description: "Set today's goal for this project and keep it in view", argumentHint: ARGUMENT_HINT })
    $.clock.after(0, () => void refresh($, settings).catch(error => $.ui.log(`could not read goals: ${describe(error)}`, { to: 'debug' })))

    return next(e)
  })

  on('command.run', { command: 'daily-goal' }, async ($, e) => ({ text: await runCommand($, settings, e.args) }))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      $.clock.after(0, () => void refresh($, settings).catch(error => $.ui.log(`could not read goals: ${describe(error)}`, { to: 'debug' })))
    }

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!settings.shouldTellClaude || e.traits.includes('bare')) return composed
    const goal = await read($, todayState)
    if (goal === null || goal.status !== 'open') return composed

    return { sections: [...composed.sections, { id: 'daily-goal:goal', text: goalSection(goal.text), scope: 'session' }] }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [goal, question, isHidden] = await Promise.all([read($, todayState), read($, questionState), read($, hiddenState)])
    const isGoalShown = goal !== null && goal.status === 'open' && question?.isToday !== true
    if (e.props.hasSurvey || isHidden || (question === null && !isGoalShown)) return next(e)

    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await $.clock.now()

    if (question !== null) {
      const when = question.isToday ? "today's goal" : question.date === daysBefore(localDate(now), 1) ? "yesterday's goal" : `your goal from ${dayLabel(question.date)}`
      return (
        <Box flexDirection="column">
          <Box key="question" flexDirection="column" width={e.props.bodyColumns}>
            <Text wrap="truncate-end">
              <Text bold color="claude">🎯 Did you reach {when}? </Text>
              <Text>“{question.text}”</Text>
            </Text>
            <Box flexDirection="row" gap={1}>
              <Button key="yes" label={question.isToday ? 'Yes, done' : 'Yes'} hotkey="y" variant="primary" onPress={() => answer($, settings, question, 'yes')} />
              {question.isToday
                ? <Button key="not-yet" label="Not yet" hotkey="n" onPress={() => answer($, settings, question, 'not-yet')} />
                : <Button key="no" label="No" hotkey="n" onPress={() => answer($, settings, question, 'no')} />}
              <Button key="hide" label="Later" hotkey="h" role="dismiss" onPress={() => update($, hiddenState, () => true)} />
            </Box>
          </Box>
          {below}
        </Box>
      )
    }
    if (goal === null) return below

    return (
      <Box flexDirection="column">
        <Box key="goal" flexDirection="column" width={e.props.bodyColumns}>
          <Text wrap="truncate-end">
            <Text bold color="claude">🎯 Goal: </Text>
            <Text>{goal.text}</Text>
            <Text dimColor> · set {ago(now - goal.setAt)}</Text>
          </Text>
          <Box flexDirection="row" gap={1}>
            <Button key="done" label="Done" hotkey="d" variant="primary" onPress={() => markDone($, settings, goal.date)} />
            <Button key="edit" label="Edit" hotkey="e" onPress={() => editGoal($, goal.text)} />
            <Button key="hide" label="Hide" hotkey="h" role="dismiss" onPress={() => update($, hiddenState, () => true)} />
          </Box>
        </Box>
        {below}
      </Box>
    )
  })
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

// #region @vendored shared/hub-client.ts sha256:6b153e2e759f: edit the source, then run `node scripts/sync-shared.mjs`.
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
/**
 * Runs a mod's start-up work (the hub hello, a first scan, loading what it keeps) once `session.start` has returned,
 * after a short delay staggered by the mod's name (0.15–1.35 s), so ~200 mods sharing one hooks worker do not all wait
 * on the hub, a process or the disk inside the session.start chain (`ran past its 10s budget`). A failure is logged
 * to the debug log. Call it from `session.start` in place of `await work()`; never await the hub there
 * (scripts/check-startup.mjs).
 */
function afterStart($: EngineInterface, mod: string, work: () => Promise<unknown>): void {
  let hash = 7
  for (let i = 0; i < mod.length; i += 1) hash = (hash * 31 + mod.charCodeAt(i)) % 1_200
  $.clock.after(150 + hash, () => {
    void work().catch(error => $.ui.log(`${mod}: start-up work failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' }))
  })
}
// #endregion @vendored shared/hub-client.ts
