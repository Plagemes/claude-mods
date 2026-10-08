import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallInput, ToolCallResult } from 'claude-code'

import type { TestFirstPhase, TestFirstStatus } from '../types'
import { isProductionCode, isTestCommand, isTestFile, looksFailed, shortCommand } from './files'

const COMMAND = 'tdd'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
const PHASES: readonly TestFirstPhase[] = ['red', 'green', 'refactor']
const PHASE_COLORS: Record<TestFirstPhase, string> = { red: 'error', green: 'success', refactor: 'suggestion' }
const NARROW_COLUMNS = 72

const OFF: TestFirstStatus = { isOn: false, phase: 'red', hasTestThisTurn: false, lastRun: null }
const status = atom({ plugin: 'test-first', key: 'status' } as const, OFF)

const MODEL_BRIEFING =
  'TDD mode is on (test-first). Work red → green → refactor: write or update a test that fails for the change, ' +
  'run it and see it fail, then change production code until it passes. Production code is locked each turn until a test file has been edited, ' +
  'unless the last test run failed.'

/** The hub's own `test.result` comes from the Bash runs this mod already reads; other sources run tests themselves. */
const HUB = 'mods-hub'

/** How far mods-hub's `test.result` events were read. */
type Cursor = { at: number }

// ── mods-hub: test runs other mods report, and refusals on the bus ──────────────────────────────────

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
  await hubHello($, { version: await ownVersion($), publishes: ['risk.blocked'], consumes: ['test.result'] })
}

/**
 * The latest test run another mod reported since the last look (test-watch runs a test file's tests right after
 * Claude edits it), folded into the cycle like a Bash run: a red run opens the code, a green one moves to green.
 * Nothing happens without the hub.
 */
const foldHubRuns = async ($: EngineInterface, cursor: Cursor): Promise<void> => {
  let events
  try {
    events = await $.mods.recent({ topic: 'test.result', since: cursor.at, limit: 20 })
  } catch {
    return
  }
  for (const event of events) cursor.at = Math.max(cursor.at, event.at)
  const last = events.filter(event => event.source !== HUB).at(-1)
  const data = last?.data as { outcome?: unknown; command?: unknown; runner?: unknown } | undefined
  if (last === undefined || data === undefined || (data.outcome !== 'passed' && data.outcome !== 'failed')) return
  const isPassed = data.outcome === 'passed'
  const command = shortCommand(typeof data.command === 'string' && data.command !== '' ? data.command : `${String(data.runner)} (${last.source})`)
  await update($, status, (value): TestFirstStatus => ({ ...value, phase: isPassed ? 'green' : 'red', lastRun: { command, isPassed } }))
}

/** Turning TDD on starts from now: test runs reported before it say nothing about this cycle. */
const skipHubRuns = async ($: EngineInterface, cursor: Cursor): Promise<void> => {
  try {
    cursor.at = Math.max(cursor.at, (await $.mods.latest({ topic: 'test.result' }))?.at ?? 0)
  } catch {
    // No hub: nothing to skip.
  }
}

/** A locked edit on the hub's bus (guardian, audit-trail); the refusal never waits on it. */
const publishLocked = async ($: EngineInterface, tool: string, path: string): Promise<void> => {
  await hubPublish($, { topic: 'risk.blocked', data: { guard: 'test-first', tool, reason: 'TDD mode: production code locked until a test is written', severity: 'low', path } })
}

export const register: Register = on => {
  const cursor: Cursor = { at: 0 }

  on('session.start', async ($, e, next) => {
    await registerCommand($, { name: COMMAND, description: 'Test-driven mode: lock production code until a test is written', argumentHint: 'on|off' })
    afterStart($, 'test-first', () => greetHub($))
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const current = await read($, status)
    if (arg === 'on') {
      await update($, status, () => ({ ...OFF, isOn: true }))
      await skipHubRuns($, cursor)
      return { text: 'TDD mode on. Production code stays locked each turn until a test is written.', context: [MODEL_BRIEFING] }
    }
    if (arg === 'off') {
      await update($, status, () => OFF)
      return { text: 'TDD mode off.', context: ['TDD mode is off: production code may be edited freely again.'] }
    }
    return {
      text: current.isOn
        ? `TDD mode is on, phase ${current.phase}. Use /tdd off to stop.`
        : 'TDD mode is off. Use /tdd on to start.',
    }
  })

  on('turn.start', async ($, e, next) => {
    if ((await read($, status)).isOn) await update($, status, value => ({ ...value, hasTestThisTurn: false }))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const current = await read($, status)
    if (!current.isOn) return next(e)

    if (e.tool === 'Bash') {
      if (!isTestCommand(e.command) || e.run_in_background === true) return next(e)
      const ran = await next(e)
      if (ran.deny !== undefined) return ran
      const isPassed = ran.isError !== true && !looksFailed(ran.text ?? '', e.command)
      await update($, status, (value): TestFirstStatus => ({
        ...value,
        phase: isPassed ? 'green' : 'red',
        lastRun: { command: shortCommand(e.command), isPassed },
      }))
      return ran
    }

    const target = editTarget(e)
    if (target === undefined) return next(e)
    const root = await $.session.cwd().catch(() => '')
    const path = root !== '' && target.startsWith(`${root}/`) ? target.slice(root.length + 1) : target

    if (isTestFile(path)) {
      const ran = await next(e)
      if (succeeded(ran)) {
        // A new or changed test starts the next cycle in red.
        await update($, status, (value): TestFirstStatus => ({ ...value, hasTestThisTurn: true, phase: 'red' }))
      }
      return ran
    }

    if (!isProductionCode(path)) return next(e)
    await foldHubRuns($, cursor)
    const now = await read($, status)
    const isUnlocked = now.hasTestThisTurn || now.lastRun?.isPassed === false
    if (!isUnlocked) {
      await publishLocked($, String(e.tool), path)
      return {
        deny:
          `test-first: TDD mode is on, so ${path} stays locked until a test is written this turn. ` +
          'Write or update a test that fails for this change first, run it and watch it fail, then edit the code. ' +
          '(The user can switch this off with /tdd off.)',
      }
    }
    const ran = await next(e)
    if (succeeded(ran) && now.phase === 'green') {
      await update($, status, (value): TestFirstStatus => ({ ...value, phase: 'refactor' }))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, status)
    if (!current.isOn || e.props.hasSurvey) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const isUnlocked = current.hasTestThisTurn || current.lastRun?.isPassed === false
    const isNarrow = e.props.bodyColumns < NARROW_COLUMNS
    // Other plugins' bands draw beneath this one rather than being replaced by it.
    const below = await next(e)
    return (
      <Box flexDirection="column">
        <Box key="tdd" flexDirection="row" gap={1} alignItems="center">
          <Text bold>TDD</Text>
          {PHASES.map((phase, index) => (
            <Text
              bold={phase === current.phase}
              dimColor={phase !== current.phase}
              color={phase === current.phase ? PHASE_COLORS[phase] : undefined}
            >
              {phase === current.phase ? '●' : '○'} {phase}
              {index < PHASES.length - 1 ? ' →' : ''}
            </Text>
          ))}
          <Text color={isUnlocked ? 'success' : 'warning'}>{isUnlocked ? '· code open' : '· code locked'}</Text>
          {!isNarrow && <Text dimColor>· {hintFor(current)}</Text>}
          <Button key="off" label="TDD off" plain dimColor onPress={() => void update($, status, () => OFF)} />
        </Box>
        {below}
      </Box>
    )
  })
}

/** What to do next, by where the cycle stands. */
const hintFor = (current: TestFirstStatus): string => {
  const last = current.lastRun === null ? '' : ` (last: ${current.lastRun.command} ${current.lastRun.isPassed ? '✓' : '✗'})`
  switch (current.phase) {
    case 'red':
      if (current.lastRun?.isPassed === false) return `make the failing test pass${last}`
      return current.hasTestThisTurn ? 'run the new test and watch it fail' : 'write a failing test first'
    case 'green':
      return `refactor, or write the next failing test${last}`
    case 'refactor':
      return `run the tests again${last}`
  }
}

/** The file an Edit, Write or MultiEdit is about to change; undefined for any other call. */
const editTarget = (e: ToolCallInput): string | undefined => {
  if (!EDIT_TOOLS.has(String(e.tool))) return undefined
  const path = 'file_path' in e ? e.file_path : undefined
  return typeof path === 'string' && path !== '' ? path : undefined
}

const succeeded = (ran: ToolCallResult): boolean => ran.deny === undefined && ran.isError !== true

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
