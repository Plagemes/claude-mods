import { atom, read, update } from 'claude-code'
import type { Register, ToolCallInput, ToolCallResult } from 'claude-code'

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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Test-driven mode: lock production code until a test is written', argumentHint: 'on|off' })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const current = await read($, status)
    if (arg === 'on') {
      await update($, status, () => ({ ...OFF, isOn: true }))
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
      const isPassed = ran.isError !== true && !looksFailed(ran.text ?? '')
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
    const isUnlocked = current.hasTestThisTurn || current.lastRun?.isPassed === false
    if (!isUnlocked) {
      return {
        deny:
          `test-first: TDD mode is on, so ${path} stays locked until a test is written this turn. ` +
          'Write or update a test that fails for this change first, run it and watch it fail, then edit the code. ' +
          '(The user can switch this off with /tdd off.)',
      }
    }
    const ran = await next(e)
    if (succeeded(ran) && current.phase === 'green') {
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
