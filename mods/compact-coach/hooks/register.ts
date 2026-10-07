import { atom, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CompactCoachMilestone, CompactCoachState } from '../types'

const INITIAL: CompactCoachState = {
  turns: 0,
  lastCoachedTurn: null,
  milestone: null,
  openTodos: 0,
  openTasks: [],
}
const coach = atom({ plugin: 'compact-coach', key: 'coach' } as const, INITIAL)

const DEFAULT_MIN_PERCENT = 60
const DEFAULT_COOLDOWN_TURNS = 10

const COMMIT_OR_PUSH = /\bgit\s+(?:-C\s+\S+\s+)?(?:commit|push)\b|\bgh\s+pr\s+create\b/
const TEST_RUN =
  /\b(?:npm|pnpm|yarn|bun|deno)\s+(?:run\s+)?test\b|\b(?:vitest|jest|pytest|mocha|rspec|phpunit)\b|\bgo\s+test\b|\bcargo\s+(?:test|nextest)\b|\b(?:mvn|gradle|gradlew)\s+test\b|\bdotnet\s+test\b|\bmake\s+test\b/

/** Task-list bookkeeping must not hide that the work before it ended on a commit or a test run. */
const BOOKKEEPING = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'])

const LABELS: Record<CompactCoachMilestone, string> = {
  commit: 'after a commit',
  tests: 'tests just passed',
}

const milestoneOf = (command: string): CompactCoachMilestone | null =>
  COMMIT_OR_PUSH.test(command) ? 'commit' : TEST_RUN.test(command) ? 'tests' : null

const createdTaskId = (result: unknown): string | undefined => {
  if (typeof result !== 'object' || result === null || !('task' in result)) {
    return undefined
  }
  const { task } = result
  return typeof task === 'object' && task !== null && 'id' in task && typeof task.id === 'string'
    ? task.id
    : undefined
}

const contextPercent = async ($: EngineInterface): Promise<number | undefined> => {
  try {
    return (await $.session.usage()).context.percent
  } catch {
    return undefined
  }
}

const asNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

export const register: Register = (on, options) => {
  const minPercent = asNumber(options.minPercent, DEFAULT_MIN_PERCENT)
  const cooldownTurns = asNumber(options.cooldownTurns, DEFAULT_COOLDOWN_TURNS)

  on('turn.start', async ($, e, next) => {
    await update($, coach, state => ({ ...state, milestone: null }))

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)

    if (e.agentId !== undefined || ran.deny !== undefined) {
      return ran
    }

    if (e.tool === 'TodoWrite') {
      const openTodos = e.todos.filter(todo => todo.status !== 'completed').length
      await update($, coach, state => ({ ...state, openTodos }))
    } else if (e.tool === 'TaskCreate') {
      const id = createdTaskId(ran.result)
      if (id !== undefined) {
        await update($, coach, state => ({ ...state, openTasks: [...state.openTasks, id] }))
      }
    } else if (e.tool === 'TaskUpdate') {
      if (e.status === 'completed' || e.status === 'deleted') {
        await update($, coach, state => ({
          ...state,
          openTasks: state.openTasks.filter(id => id !== e.taskId),
        }))
      }
    } else if (!BOOKKEEPING.has(e.tool)) {
      const milestone = e.tool === 'Bash' && ran.isError !== true ? milestoneOf(e.command) : null
      await update($, coach, state => ({ ...state, milestone }))
    }

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.reason === 'answer') {
      const state = await update($, coach, previous => ({ ...previous, turns: previous.turns + 1 }))
      const isOpenWork = state.openTodos > 0 || state.openTasks.length > 0
      const isCoolingDown =
        state.lastCoachedTurn !== null && state.turns - state.lastCoachedTurn < cooldownTurns

      if (state.milestone !== null && !isOpenWork && !isCoolingDown) {
        const percent = await contextPercent($)

        if (percent !== undefined && percent >= minPercent) {
          await update($, coach, previous => ({ ...previous, lastCoachedTurn: previous.turns }))
          $.ui.toast(
            `compact-coach: good moment to /compact (context ${Math.round(percent)}%, ${LABELS[state.milestone]})`,
          )
        }
      }
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, coach, () => INITIAL)
    }

    return next(e)
  })
}
