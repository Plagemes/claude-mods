import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { FlakyRecord, FlakyView } from '../types'
import { applyRun, asHistory, suspectsOf } from './history'
import type { History } from './history'
import { isTestCommand, parseRun } from './runners'
import type { RunReport } from './runners'

/** What this load counts: Claude's file edits (the fingerprint outside git) and the project root once found. */
type Memory = { edits: number; root: string | undefined }

const PANE = 'flaky'
const STORE_PREFIX = 'tests:'
const INDEX_NAME = 'flaky-detector.index'
const EDIT_TOOLS = /^(?:Edit|MultiEdit|Write|NotebookEdit)$/
const GIT_TIMEOUT_MS = 20_000
const MAX_ROWS = 30
const NARROW_COLUMNS = 70
const EMPTY: FlakyView = { project: '', flaky: [], watching: [] }

const view = atom({ plugin: 'flaky-detector', key: 'view' } as const, EMPTY)

const succeeded = (ran: ToolCallResult): boolean => ran.deny === undefined && ran.isError !== true

/** The text a Bash call printed, wherever its result carries it. */
function outputOf(ran: ToolCallResult): string {
  const parts: string[] = []
  if (typeof ran.text === 'string') parts.push(ran.text)
  const result: unknown = ran.result
  if (typeof result === 'string' && parts.length === 0) parts.push(result)
  if (typeof result === 'object' && result !== null && parts.length === 0) {
    const { stdout, stderr } = result as { stdout?: unknown; stderr?: unknown }
    for (const stream of [stdout, stderr]) if (typeof stream === 'string') parts.push(stream)
  }
  return parts.join('\n')
}

async function git($: EngineInterface, cwd: string, args: readonly string[], env?: Record<string, string>): Promise<string | undefined> {
  try {
    const run = await $.process.run(['git', ...args], { cwd, env, timeoutMs: GIT_TIMEOUT_MS })
    return run.exitCode === 0 ? run.stdout.trim() : undefined
  } catch {
    return undefined
  }
}

async function projectRoot($: EngineInterface, memory: Memory): Promise<string> {
  if (memory.root !== undefined) return memory.root
  const cwd = await $.session.cwd()
  memory.root = (await git($, cwd, ['rev-parse', '--show-toplevel'])) ?? cwd
  return memory.root
}

/**
 * The code a run ran on: the whole worktree (untracked files included,
 * ignored ones not) as a git tree id, built in an index of the mod's own
 * that keeps stat data between runs. Outside git, the count of Claude's edits.
 */
async function fingerprintOf($: EngineInterface, root: string, memory: Memory): Promise<string> {
  const gitPath = await git($, root, ['rev-parse', '--git-path', INDEX_NAME])
  if (gitPath === undefined) return `edits:${memory.edits}`
  const index = gitPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(gitPath) ? gitPath : `${root}/${gitPath}`
  const env = { GIT_INDEX_FILE: index }
  if (!(await $.fs.exists(index).catch(() => false))) {
    const hasHead = (await git($, root, ['rev-parse', '--verify', '-q', 'HEAD'])) !== undefined
    await git($, root, hasHead ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], env)
  }
  if ((await git($, root, ['add', '-A'], env)) === undefined) return ''
  const tree = await git($, root, ['write-tree'], env)
  return tree === undefined ? '' : `tree:${tree}`
}

async function loadHistory($: EngineInterface, root: string): Promise<History> {
  return asHistory(await $.store.get(`${STORE_PREFIX}${root}`).catch(() => undefined))
}

async function showHistory($: EngineInterface, root: string, history: History): Promise<void> {
  const { flaky, watching } = suspectsOf(history)
  const project = root.slice(root.lastIndexOf('/') + 1) || root
  await update($, view, (): FlakyView => ({ project, flaky: flaky.slice(0, MAX_ROWS), watching: watching.slice(0, MAX_ROWS) }))
}

/** Folds a test run into the project's history; answers a note for the model when known flaky tests failed. */
async function recordRun($: EngineInterface, memory: Memory, command: string, report: RunReport): Promise<string | undefined> {
  const root = await projectRoot($, memory)
  const fingerprint = await fingerprintOf($, root, memory)
  const applied = applyRun(await loadHistory($, root), { report, command, fingerprint, at: await $.clock.now() })
  await $.store.set(`${STORE_PREFIX}${root}`, applied.history)
  await showHistory($, root, applied.history)

  for (const test of applied.newlyFlaky) $.ui.toast(`⚠ Flaky: ${shortName(test.id)} changed outcome with no code change (/flaky)`)
  if (applied.flakyFailures.length === 0) return undefined
  const names = applied.flakyFailures.map(test => `${test.id} (${test.flips} flip${test.flips === 1 ? '' : 's'})`).join('; ')
  return (
    `flaky-detector: known flaky test${applied.flakyFailures.length === 1 ? '' : 's'} failed: ${names}. ` +
    'They have passed and failed before with no code change, so this failure may not come from the current change: re-run them once before debugging.'
  )
}

const shortName = (id: string): string => (id.length > 60 ? `…${id.slice(-59)}` : id)

async function forget($: EngineInterface, memory: Memory, id: string | undefined): Promise<void> {
  const root = await projectRoot($, memory)
  const history = await loadHistory($, root)
  const kept: History = id === undefined ? { records: {}, recent: [] } : { ...history, records: Object.fromEntries(Object.entries(history.records).filter(([key]) => key !== id)) }
  await $.store.set(`${STORE_PREFIX}${root}`, kept)
  await showHistory($, root, kept)
  $.ui.toast(id === undefined ? 'Forgot every tracked test of this project.' : `Forgot ${shortName(id)}.`)
}

function stabilizePrompt(test: FlakyRecord): string {
  const runs = test.outcomes.length
  const fails = test.outcomes.filter(outcome => outcome.outcome === 'fail').length
  const command = test.outcomes.at(-1)?.command ?? ''
  return [
    `The test \`${test.id}\` (${test.runner}) is flaky: it changed between passing and failing ${test.flips} time${test.flips === 1 ? '' : 's'} ` +
      `with no code change in between (${fails} failures in the last ${runs} recorded runs${command === '' ? '' : `, run with \`${command}\``}).`,
    'Find out why: timing and timeouts, shared or global state, test order, randomness, real network, clock or filesystem use.',
    'Make it deterministic without weakening what it checks, then run it repeatedly (say 20 times) to confirm it stays green.',
  ].join(' ')
}

async function askToStabilize($: EngineInterface, test: FlakyRecord): Promise<void> {
  const text = stabilizePrompt(test)
  $.clock.after(1, () => void $.prompt.submit({ text, asUser: true }).catch(() => undefined))
  $.ui.toast(`Asked Claude to stabilise ${shortName(test.id)}.`)
}

const ago = (now: number, at: number | null): string => {
  if (at === null) return 'never'
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}

/** The last outcomes as marks, oldest first: `✓✗✓✓✗`. */
const trail = (test: FlakyRecord): string =>
  test.outcomes
    .slice(-10)
    .map(outcome => (outcome.outcome === 'pass' ? '✓' : '✗'))
    .join('')

export const register: Register = on => {
  const memory: Memory = { edits: 0, root: undefined }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'flaky', description: 'Tests that pass and fail with no code change (flaky suspects)' })
    return next(e)
  })

  on('command.run', { command: 'flaky' }, async $ => {
    const root = await projectRoot($, memory)
    const history = await loadHistory($, root)
    await showHistory($, root, history)
    await $.ui.open({ id: PANE, title: 'Flaky tests' }).catch(() => undefined)
    const { flaky, watching } = suspectsOf(history)
    if (flaky.length + watching.length === 0) return { text: 'No flaky or failing tests in this project right now; they are tracked as tests run.' }
    return { text: `${flaky.length} flaky suspect${flaky.length === 1 ? '' : 's'}, ${watching.length} failing test${watching.length === 1 ? '' : 's'} watched.` }
  })

  on('tool.call', { tool: EDIT_TOOLS }, async ($, e, next) => {
    const ran = await next(e)
    if (succeeded(ran)) memory.edits += 1
    return ran
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.tool !== 'Bash' || ran.deny !== undefined || e.run_in_background === true || !isTestCommand(e.command)) return ran
    const report = parseRun(e.command, outputOf(ran))
    if (report === undefined || (report.tests.length === 0 && report.passedScopes.length === 0 && !report.isComplete)) return ran
    try {
      const note = await recordRun($, memory, e.command, report)
      return note === undefined ? ran : { ...ran, context: [...(ran.context ?? []), note] }
    } catch (error) {
      $.ui.log(`flaky-detector: could not record the run: ${String(error)}`, { to: 'debug' })
      return ran
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const current = await read($, view)
    const now = await $.clock.now()
    const isNarrow = e.props.bodyColumns < NARROW_COLUMNS
    const close = <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />

    if (current.flaky.length + current.watching.length === 0) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold color="success">
            ✓ No flaky tests seen{current.project === '' ? '' : ` in ${current.project}`}
          </Text>
          <Text dimColor>
            Every test run through Claude's shell is recorded. A test that fails and then passes (or the other way round) with no change to
            the code is marked flaky here.
          </Text>
          {close}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box key="header" flexDirection="row" justifyContent="space-between" gap={2}>
          <Text bold color={current.flaky.length > 0 ? 'warning' : undefined}>
            ⚠ Flaky tests · {current.project}
          </Text>
          <Text dimColor>
            {current.flaky.length} suspect{current.flaky.length === 1 ? '' : 's'} · {current.watching.length} watched
          </Text>
        </Box>
        {current.flaky.length > 0 && (
          <Box key="flaky" flexDirection="column">
            {current.flaky.map(test => (
              <Box key={`flaky:${test.id}`} flexDirection={isNarrow ? 'column' : 'row'} gap={1}>
                <Box flexGrow={1} flexDirection="column">
                  <Text bold wrap="truncate-start">
                    {test.id}
                  </Text>
                  <Text dimColor wrap="truncate-end">
                    <Text color="warning">{test.flips} flip{test.flips === 1 ? '' : 's'}</Text> · {trail(test)} · {test.runner} · last flip{' '}
                    {ago(now, test.lastFlipAt)}
                  </Text>
                </Box>
                <Box flexDirection="row" gap={1}>
                  <Button key={`copy:${test.id}`} label="Copy" plain dimColor onPress={press => void $.ui.copy({ text: test.id, surface: press.surface })} />
                  <Button key={`fix:${test.id}`} label="Stabilise" plain onPress={() => void askToStabilize($, test)} />
                  <Button key={`forget:${test.id}`} label="Forget" plain dimColor onPress={() => void forget($, memory, test.id)} />
                </Box>
              </Box>
            ))}
          </Box>
        )}
        {current.watching.length > 0 && (
          <Box key="watching" flexDirection="column">
            <Text bold dimColor>
              Failed, not flaky (yet)
            </Text>
            {current.watching.map(test => (
              <Box key={`watch:${test.id}`} flexDirection="row" gap={1}>
                <Text color="error">✗</Text>
                <Box flexGrow={1}>
                  <Text wrap="truncate-start">{test.id}</Text>
                </Box>
                {!isNarrow && (
                  <Text dimColor>
                    {trail(test)} · {ago(now, test.lastFailAt)}
                  </Text>
                )}
                <Button key={`forget:${test.id}`} label="Forget" plain dimColor onPress={() => void forget($, memory, test.id)} />
              </Box>
            ))}
          </Box>
        )}
        <Box key="actions" flexDirection="row" gap={1}>
          <Button key="clear" label="Forget all" onPress={() => void forget($, memory, undefined)} />
          {close}
        </Box>
      </Box>
    )
  })
}
