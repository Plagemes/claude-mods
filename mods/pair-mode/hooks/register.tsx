import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallInput } from 'claude-code'

import type { PairModeSession } from '../types'
import { absolutePath, describeStats, parseAction, parseNumstat, reviewContext, reviewRequest, writesFiles } from './pair'

type Git = { ok: boolean; out: string; err: string }
type Settings = { guardShell: boolean }

const EDIT_TOOLS = /^(?:Edit|MultiEdit|Write|NotebookEdit)$/
const GIT_TIMEOUT_MS = 30_000
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const INDEX_NAME = 'pair-mode.index'
const NARROW_COLUMNS = 76
const OFF: PairModeSession = { isOn: false, baseline: null, since: 'head', isChecking: false }

const BRIEFING =
  'Pair mode is on: the user is practising and types every code change themselves. Do not modify files: the Edit, Write and ' +
  'NotebookEdit tools are blocked, and so are shell commands that write files (sed -i, redirections, tee, rm, formatters with --write...). ' +
  'Reading files and running read-only commands and tests is fine. Present each change as a unified diff in a ```diff block ' +
  '(--- a/path and +++ b/path headers, @@ hunks with a few lines of context), small enough to type by hand, and say in a sentence why. ' +
  'Then wait for the user to apply it. When they ask for a review, compare what they typed with what you proposed.'

const session = atom({ plugin: 'pair-mode', key: 'session' } as const, OFF)

const USAGE = [
  'Usage: /pair on | off | check',
  '  on     Claude proposes changes as diffs and you type them (its file edits are blocked)',
  '  off    back to normal: Claude edits files again',
  '  check  send what you changed since pair mode started (or the last check) to Claude for review',
].join('\n')

async function git($: EngineInterface, cwd: string | undefined, args: readonly string[], env?: Record<string, string>): Promise<Git> {
  try {
    const run = await $.process.run(['git', ...args], { cwd, env, timeoutMs: GIT_TIMEOUT_MS })
    return { ok: run.exitCode === 0, out: run.stdout, err: run.stderr.trim() }
  } catch (error) {
    return { ok: false, out: '', err: String(error) }
  }
}

async function repoRoot($: EngineInterface): Promise<string | undefined> {
  const top = await git($, undefined, ['rev-parse', '--show-toplevel'])
  return top.ok ? top.out.trim() : undefined
}

/**
 * The whole worktree as a git tree id, untracked files included and ignored
 * ones left out, built in an index of the mod's own so the person's staging
 * area is never touched.
 */
async function snapshot($: EngineInterface, root: string): Promise<string | undefined> {
  const indexPath = await git($, root, ['rev-parse', '--git-path', INDEX_NAME])
  if (!indexPath.ok) return undefined
  const env = { GIT_INDEX_FILE: absolutePath(root, indexPath.out.trim()) }
  const hasHead = (await git($, root, ['rev-parse', '--verify', '-q', 'HEAD'])).ok
  const steps = [hasHead ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], ['add', '-A']]
  for (const args of steps) {
    if (!(await git($, root, args, env)).ok) return undefined
  }
  const tree = await git($, root, ['write-tree'], env)
  return tree.ok ? tree.out.trim() : undefined
}

async function turnOn($: EngineInterface): Promise<string> {
  await update($, session, () => ({ ...OFF, isOn: true }))
  const root = await repoRoot($)
  const baseline = root === undefined ? undefined : await snapshot($, root)
  await update($, session, (current): PairModeSession =>
    current.isOn ? { ...current, baseline: baseline ?? null, since: baseline === undefined ? 'head' : 'start' } : current,
  )
  const check = root === undefined ? 'Outside a git repository, so /pair check is not available.' : 'Run /pair check after you apply a change.'
  return `Pair mode on: Claude proposes each change as a diff and you type it. ${check}`
}

async function turnOff($: EngineInterface): Promise<string> {
  await update($, session, () => OFF)
  return 'Pair mode off: Claude edits files again.'
}

/** Diffs the worktree against the baseline and asks Claude to review it; answers what the person is told. */
async function runCheck($: EngineInterface): Promise<string> {
  const current = await read($, session)
  if (current.isChecking) return 'A check is already gathering your changes.'
  const root = await repoRoot($)
  if (root === undefined) return '/pair check needs a git repository to see what you changed.'

  await update($, session, value => ({ ...value, isChecking: true }))
  try {
    const now = await snapshot($, root)
    if (now === undefined) return 'Could not read the working tree with git.'
    const hasHead = (await git($, root, ['rev-parse', '--verify', '-q', 'HEAD'])).ok
    const base = current.baseline ?? (hasHead ? 'HEAD' : EMPTY_TREE)
    const since = current.baseline === null ? 'head' : current.since
    const [numstat, diff] = await Promise.all([
      git($, root, ['diff', '--numstat', '-M', base, now]),
      git($, root, ['diff', '--no-color', '--no-ext-diff', '-M', base, now]),
    ])
    if (!numstat.ok || !diff.ok) return `git diff failed: ${numstat.err || diff.err}`
    const stats = parseNumstat(numstat.out)
    if (stats.files === 0) {
      return since === 'head' ? 'No changes since the last commit.' : `No changes since ${since === 'start' ? 'pair mode started' : 'the last check'}.`
    }

    await update($, session, (value): PairModeSession => ({ ...value, baseline: now, since: 'review' }))
    // Queued from a timer, once this dispatch has ended, so the prompt starts a turn of its own.
    const request = reviewRequest(stats, since)
    const context = reviewContext(diff.out, since)
    $.clock.after(1, () => void submitReview($, request, context))
    return `Sent your changes (${describeStats(stats)}) to Claude for review.`
  } finally {
    await update($, session, value => ({ ...value, isChecking: false }))
  }
}

/**
 * Puts the diff in the conversation as a note only the model reads, then asks
 * for the review in the person's words; where the note cannot be appended
 * the diff rides in the prompt itself.
 */
async function submitReview($: EngineInterface, request: string, context: string): Promise<void> {
  let text = request
  try {
    const appended = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: context }] } })
    if (appended.deny !== undefined) text = `${request}\n\n${context}`
  } catch {
    text = `${request}\n\n${context}`
  }
  await $.prompt.submit({ text, asUser: true }).catch(() => undefined)
}

async function pressCheck($: EngineInterface): Promise<void> {
  $.ui.toast(await runCheck($))
}

async function pressOff($: EngineInterface): Promise<void> {
  $.ui.toast(await turnOff($))
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

/** Says hello to mods-hub when it is installed. */
async function greetHub($: EngineInterface): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: [] })
}

function editedPath(e: ToolCallInput): string {
  if ('file_path' in e && typeof e.file_path === 'string') return e.file_path
  if ('notebook_path' in e && typeof e.notebook_path === 'string') return e.notebook_path
  return 'this file'
}

export const register: Register = (on, options) => {
  const settings: Settings = { guardShell: options.guardShell !== false }

  on('session.start', async ($, e, next) => {
    await registerCommand($, {
      name: 'pair',
      description: 'Pair mode: Claude proposes diffs, you type them (on, off, check)',
      argumentHint: '[on|off|check]',
    })
    afterStart($, 'pair-mode', () => greetHub($))
    if (options.startOn === true) $.clock.after(0, () => void turnOn($))
    return next(e)
  })

  on('command.run', { command: 'pair' }, async ($, e) => {
    const action = parseAction(e.args)
    const isOn = (await read($, session)).isOn
    if (action === 'help') return { text: USAGE }
    if (action === 'check') return { text: await runCheck($) }
    if (action === 'on' || (action === 'toggle' && !isOn)) {
      if (action === 'on' && isOn) return { text: 'Pair mode is already on. /pair check sends your changes for review.' }
      return { text: await turnOn($), context: [BRIEFING] }
    }
    if (!isOn) return { text: 'Pair mode is already off.' }
    return { text: await turnOff($), context: ['Pair mode is off: you may edit files again.'] }
  })

  on('tool.call', { tool: EDIT_TOOLS }, async ($, e, next) => {
    if (!(await read($, session)).isOn) return next(e)
    return {
      deny:
        `pair-mode: pair mode is on, so the user types every change. Do not edit ${editedPath(e)}: show the change as a unified diff ` +
        'in your answer (```diff with --- a/path and +++ b/path headers and @@ hunks), explain it in a sentence, and let the user ' +
        'apply it. They can turn this off with /pair off.',
    }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!settings.guardShell || e.tool !== 'Bash' || !(await read($, session)).isOn) return next(e)
    const writer = writesFiles(e.command)
    if (writer === undefined) return next(e)
    return {
      deny:
        `pair-mode: pair mode is on and this command writes files (${writer}). The user types every change: show it as a ` +
        'unified diff instead, or give them the command to run themselves. Read-only commands and tests are fine.',
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (e.traits.includes('bare') || !(await read($, session)).isOn) return composed
    return { sections: [...composed.sections, { id: 'pair-mode:rules', text: BRIEFING, scope: 'session' }] }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, session)
    if (!current.isOn || e.props.hasSurvey) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const below = await next(e)
    const isNarrow = e.props.bodyColumns < NARROW_COLUMNS
    return (
      <Box flexDirection="column">
        <Box key="pair" flexDirection="row" gap={1} alignItems="center">
          <Text bold color="claude">
            ⌨ Pair mode: you drive
          </Text>
          {!isNarrow && <Text dimColor>· Claude proposes diffs, you type them</Text>}
          <Button
            key="check"
            label={current.isChecking ? 'Checking…' : 'Check my changes'}
            hotkey="c"
            plain
            onPress={() => void pressCheck($)}
          />
          <Button key="off" label="Off" hotkey="o" plain dimColor onPress={() => void pressOff($)} />
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
