import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GuardRegression } from '../types'
import { ago, applyRun, fixPrompt, isTestFile, modelNote, plural, touchedBy } from './baseline'
import type { Applied } from './baseline'
import { isTestCommand, parseResults, shortCommand } from './parse'
import { isTestCommand as isTestCommandAnywhere } from './shared/test-runners'

type Dollar = EngineInterface
/** What this load reads from userConfig, and the run being folded in now. */
type Guard = { shouldTellClaude: boolean; maxListed: number; queue: Promise<unknown> }

const COMMAND = 'baseline'
const ARGUMENT_HINT = '[reset]'
const DEFAULT_MAX_LISTED = 5
const MAX_LISTED = 20
const MAX_OUTPUT_CHARS = 1_000_000
const SUMMARY_LISTED = 30
const BAND_CHROME_ROWS = 3
const MAX_EDITED = 500
const REGRESSED_TOPIC = 'x.regression-guard.regressed'
/** How many test names go into the event and into the notification's body. */
const MAX_EVENT_TESTS = 20
const MAX_BODY_TESTS = 5

const baselineState = atom({ plugin: 'regression-guard', key: 'baseline' } as const, {})
const regressionsState = atom({ plugin: 'regression-guard', key: 'regressions' } as const, [])
const lastRunState = atom({ plugin: 'regression-guard', key: 'lastRun' } as const, null)
const dismissedState = atom({ plugin: 'regression-guard', key: 'dismissed' } as const, '')
const editedState = atom({ plugin: 'regression-guard', key: 'edited' } as const, [])

const keyOf = (regressions: readonly GuardRegression[]): string =>
  regressions.map(regression => regression.name).sort().join('\n')

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The output a Bash run showed the model, or its record's streams when no text came with it. */
function outputOf(ran: { text?: string; result?: unknown }): string {
  if (typeof ran.text === 'string') return ran.text
  if (typeof ran.result === 'string') return ran.result
  if (typeof ran.result !== 'object' || ran.result === null) return ''
  const record = ran.result as Record<string, unknown>
  return [record.stdout, record.stderr].filter((part): part is string => typeof part === 'string').join('\n')
}

function showStatus($: Dollar, regressions: readonly GuardRegression[]): void {
  $.ui.status(regressions.length === 0 ? undefined : `⚠ ${plural(regressions.length, 'regression')}`)
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
  await hubHello($, { version: await ownVersion($), publishes: [REGRESSED_TOPIC], consumes: [] })
}

/**
 * Something the person should hear about: a hub notification when mods-hub is installed (your phone while you are
 * away, held while Silent; the notice also lists the tests), this mod's own toast otherwise.
 */
async function alert($: Dollar, level: 'success' | 'error', title: string, body?: string): Promise<void> {
  try {
    await $.mods.notify({ level, title, topic: REGRESSED_TOPIC, ...(body === undefined ? {} : { body }) })
  } catch {
    $.ui.toast(title)
  }
}

/** Folds one test run into the session's baseline; undefined when the output named no tests. */
async function recordRun($: Dollar, command: string, output: string): Promise<Applied | undefined> {
  const results = parseResults(output.length > MAX_OUTPUT_CHARS ? output.slice(-MAX_OUTPUT_CHARS) : output)
  if (results.length === 0) return undefined

  const at = await $.clock.now()
  const short = shortCommand(command)
  const isTouched = touchedBy(await read($, editedState))
  const applied = applyRun(await read($, baselineState), await read($, regressionsState), results, at, short, isTouched)
  await update($, baselineState, () => applied.baseline)
  await update($, regressionsState, () => applied.regressions)
  await update($, lastRunState, () => ({ at, command: short, passed: applied.passed, failed: applied.failed }))
  showStatus($, applied.regressions)

  if (applied.added.length > 0) {
    const verb = applied.added.length === 1 ? 'fails' : 'fail'
    const names = applied.added.map(regression => regression.name)
    await hubPublish($, {
      topic: REGRESSED_TOPIC,
      data: { count: applied.added.length, total: applied.regressions.length, tests: names.slice(0, MAX_EVENT_TESTS), command: short },
    })
    const more = names.length > MAX_BODY_TESTS ? `\n…and ${names.length - MAX_BODY_TESTS} more` : ''
    await alert($, 'error', `⚠ ${plural(applied.added.length, 'test')} that passed earlier this session now ${verb}`, `${names.slice(0, MAX_BODY_TESTS).join('\n')}${more}`)
  } else if (applied.fixed.length > 0 && applied.regressions.length === 0) {
    await alert($, 'success', '✓ Every regression passes again')
  }

  return applied
}

/** Runs one fold after the other, so test runs that end together do not overwrite each other. */
function serialized($: Dollar, guard: Guard, command: string, output: string): Promise<Applied | undefined> {
  const run = guard.queue.then(() => recordRun($, command, output))
  guard.queue = run.catch(() => undefined)
  return run
}

async function askToFix($: Dollar): Promise<void> {
  const regressions = await read($, regressionsState)
  if (regressions.length === 0) return
  await update($, dismissedState, () => keyOf(regressions))
  await $.prompt.submit({ text: fixPrompt(regressions), asUser: true })
}

async function dismiss($: Dollar): Promise<void> {
  const regressions = await read($, regressionsState)
  await update($, dismissedState, () => keyOf(regressions))
}

async function reset($: Dollar): Promise<string> {
  await update($, baselineState, () => ({}))
  await update($, regressionsState, () => [])
  await update($, lastRunState, () => null)
  await update($, dismissedState, () => '')
  await update($, editedState, () => [])
  showStatus($, [])

  return '↺ Baseline cleared. The next test run becomes the new baseline.'
}

async function summary($: Dollar): Promise<string> {
  const [baseline, regressions, lastRun, now] = await Promise.all([
    read($, baselineState),
    read($, regressionsState),
    read($, lastRunState),
    $.clock.now(),
  ])
  const outcomes = Object.values(baseline)
  if (lastRun === null || outcomes.length === 0) {
    return '◆ No test run seen yet this session. Run your tests (npm test, pytest, go test ./..., cargo test…) and their first results become the baseline.'
  }
  const passing = outcomes.filter(outcome => outcome === 'pass').length
  const lines = [
    `◆ Baseline: ${plural(outcomes.length, 'test')} seen this session, ${passing} passing at their first run${passing < outcomes.length ? `, ${outcomes.length - passing} already failing` : ''}.`,
    regressions.length === 0
      ? '✓ No regressions: every test that passed still passes.'
      : `⚠ ${plural(regressions.length, 'regression')}:`,
    ...regressions.slice(0, SUMMARY_LISTED).map(regression => `  ✗ ${regression.name} (failing since ${ago(now - regression.since)}, \`${regression.command}\`)`),
    ...(regressions.length > SUMMARY_LISTED ? [`  …and ${regressions.length - SUMMARY_LISTED} more.`] : []),
    `Last test run: \`${lastRun.command}\` ${ago(now - lastRun.at)}, ${lastRun.passed} passed, ${lastRun.failed} failed.`,
    '/baseline reset forgets it all; the next test run becomes the new baseline.',
  ]

  return lines.join('\n')
}

export const register: Register = (on, options) => {
  const listed = Number(options.maxListed)
  const guard: Guard = {
    shouldTellClaude: options.tellClaude !== false,
    maxListed: Number.isFinite(listed) && listed >= 1 ? Math.min(MAX_LISTED, Math.floor(listed)) : DEFAULT_MAX_LISTED,
    queue: Promise.resolve(),
  }

  on('session.start', async ($, e, next) => {
    await registerCommand($, {
      name: 'baseline',
      description: 'Show the tests that passed at the start of this session and any that fail now',
      argumentHint: ARGUMENT_HINT,
    })
    showStatus($, await read($, regressionsState))
    afterStart($, 'regression-guard', () => greetHub($))

    return next(e)
  })

  on('command.run', { command: 'baseline' }, async ($, e) => {
    const action = e.args.trim().toLowerCase()
    if (action === 'reset') return { text: await reset($) }
    if (action === '' || action === 'show') return { text: await summary($) }

    return { text: `✗ Unknown option "${action}". Usage: /${COMMAND} ${ARGUMENT_HINT}` }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || e.run_in_background === true) return ran
    if (!isTestCommand(e.command) && !isTestCommandAnywhere(e.command)) return ran

    let applied: Applied | undefined
    try {
      applied = await serialized($, guard, e.command, outputOf(ran))
    } catch (error) {
      $.ui.log(`could not read the test run: ${describe(error)}`, { to: 'debug' })
      return ran
    }
    if (applied === undefined || applied.added.length === 0 || !guard.shouldTellClaude) return ran

    return { ...ran, context: [...(ran.context ?? []), modelNote(applied.added, applied.regressions.length)] }
  })

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const ran = await next(e)
    const path = 'file_path' in e ? String(e.file_path) : ''
    if (ran.deny === undefined && ran.isError !== true && isTestFile(path)) {
      await update($, editedState, edited => (edited.includes(path) ? edited : [...edited, path].slice(-MAX_EDITED)))
    }

    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const regressions = await read($, regressionsState)
    const isQuiet = e.props.hasSurvey || regressions.length === 0 || (await read($, dismissedState)) === keyOf(regressions)
    if (isQuiet) return next(e)

    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const room = Math.max(1, Math.min(guard.maxListed, e.props.maxRows - BAND_CHROME_ROWS))
    const shown = regressions.slice(0, room)
    const hidden = regressions.length - shown.length

    return (
      <Box flexDirection="column">
        <Box key="regressions" flexDirection="column" width={e.props.bodyColumns}>
          <Text wrap="truncate-end">
            <Text bold color="warning">⚠ Regressions: {regressions.length}</Text>
            <Text dimColor> · passed earlier this session, failing now</Text>
          </Text>
          {shown.map(regression => (
            <Box key={`regression:${regression.name}`}>
              <Text wrap="truncate-end">
                <Text color="error">  ✗ </Text>
                {regression.name}
                <Text dimColor> · {ago(now - regression.since)}</Text>
              </Text>
            </Box>
          ))}
          {hidden > 0 && <Text dimColor>  +{hidden} more · /{COMMAND} lists them all</Text>}
          <Box flexDirection="row" gap={1}>
            <Button key="fix" label="Ask Claude to fix regressions" hotkey="f" variant="primary" onPress={() => askToFix($)} />
            <Button key="dismiss" label="Dismiss" hotkey="x" role="dismiss" onPress={() => dismiss($)} />
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
