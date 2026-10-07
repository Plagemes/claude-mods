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
/** From here the hub's own `context.pressure` steps (85 %) call it urgent: the suggestion is a warning, not an FYI. */
const URGENT_PERCENT = 85
/** A `context.pressure` older than this says nothing about the window now (a compaction may have followed it). */
const PRESSURE_FRESH_MS = 10 * 60_000

const COMMIT_OR_PUSH = /\bgit\s+(?:-C\s+\S+\s+)?(?:commit|push)\b|\bgh\s+pr\s+create\b/
/** A test runner as the command a shell segment runs, after env assignments and launchers (`npx`, `python -m`, ...). */
const TEST_RUN = new RegExp(
  String.raw`^\s*(?:\w+=\S*\s+|(?:sudo|time|env|nice|command|npx|pnpx|bunx|yarn|pnpm|bun)\s+|timeout\s+\S+\s+|(?:python3?|py)\s+-m\s+|(?:poetry|uv|pipenv|pdm|hatch|rye)\s+run\s+|(?:bundle|pnpm|yarn|npm)\s+exec\s+(?:--\s+)?)*?` +
    String.raw`(?:[\w.~-]*\/)*` +
    String.raw`(?:(?:npm|pnpm|yarn|bun|deno)\s+(?:run\s+)?test|vitest|jest|pytest|mocha|rspec|phpunit|go\s+test|cargo\s+(?:test|nextest)|(?:mvn|gradle|gradlew)\s+test|dotnet\s+test|make\s+test)(?![\w./])`,
)
const SEGMENTS = /&&|\|\||[;|&\n(){}]/

/** A command that runs tests; `cat jest.config.js` or `pip install pytest` runs none. */
const runsTests = (command: string): boolean => command.split(SEGMENTS).some(segment => TEST_RUN.test(segment))

/** Task-list bookkeeping must not hide that the work before it ended on a commit or a test run. */
const BOOKKEEPING = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'])

const LABELS: Record<CompactCoachMilestone, string> = {
  commit: 'after a commit',
  tests: 'tests just passed',
}

const milestoneOf = (command: string): CompactCoachMilestone | null =>
  COMMIT_OR_PUSH.test(command) ? 'commit' : runsTests(command) ? 'tests' : null

const createdTaskId = (result: unknown): string | undefined => {
  if (typeof result !== 'object' || result === null || !('task' in result)) {
    return undefined
  }
  const { task } = result
  return typeof task === 'object' && task !== null && 'id' in task && typeof task.id === 'string'
    ? task.id
    : undefined
}

/** The fill from the hub's last `context.pressure`, when it is recent; undefined without a hub. */
async function hubPercent($: EngineInterface): Promise<number | undefined> {
  try {
    const event = await $.mods.latest({ topic: 'context.pressure' })
    const data: unknown = event?.data
    const percent = typeof data === 'object' && data !== null ? (data as { percent?: unknown }).percent : undefined
    return event !== null && typeof percent === 'number' && (await $.clock.now()) - event.at <= PRESSURE_FRESH_MS ? percent : undefined
  } catch {
    return undefined
  }
}

/** The context fill: the engine's reading, or when it has none the hub's last `context.pressure`. */
async function contextPercent($: EngineInterface): Promise<number | undefined> {
  try {
    const percent = (await $.session.usage()).context.percent
    if (percent !== undefined) return percent
  } catch {
    // Fall through to the hub.
  }
  return hubPercent($)
}

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** With mods-hub installed: hello (this mod reads `context.pressure`). */
async function greetHub($: EngineInterface): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: ['context.pressure'] })
}

const asNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

export const register: Register = (on, options) => {
  const minPercent = asNumber(options.minPercent, DEFAULT_MIN_PERCENT)
  const cooldownTurns = asNumber(options.cooldownTurns, DEFAULT_COOLDOWN_TURNS)

  on('session.start', async ($, e, next) => {
    await greetHub($)
    return next(e)
  })

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
          // An info notice (a toast); once the window is past the hub's 85 % step it is a warning, which also reaches your phone while you are away.
          await hubNotify($, {
            level: percent >= URGENT_PERCENT ? 'warning' : 'info',
            title: `Good moment to /compact (context ${Math.round(percent)}%, ${LABELS[state.milestone]})`,
          })
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
