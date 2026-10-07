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
  if (reached !== undefined) $.ui.toast(`🎉 Goal reached: ${reached}`)
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
    await $.command.register({ name: 'daily-goal', description: "Set today's goal for this project and keep it in view", argumentHint: ARGUMENT_HINT })
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
