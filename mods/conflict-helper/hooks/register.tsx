import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ConflictHelperNotice as Notice, ConflictHelperView as View } from '../types'
import { markerCount, parseConflicts, resolveInstruction } from './conflicts'
import type { ConflictFile } from './conflicts'

type Git = { ok: boolean; out: string; err: string }

const PLUGIN = 'conflict-helper'
const PANE = 'conflicts'
const GIT_TIMEOUT_MS = 20_000
const MAX_PUBLISHED_PATHS = 20
const SECTION_ID = 'conflict-helper:markers'
/** Git commands after which conflicts may appear or go away. */
const GIT_STATE_CHANGE = /\bgit\s+(?:-C\s+\S+\s+)?(?:merge|rebase|pull|cherry-pick|revert|am|stash\s+(?:pop|apply)|checkout|switch|restore|add|rm|commit|reset|mergetool)\b/
const WRITING_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit)$/
const OPERATIONS: readonly [string, string][] = [
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
]
const NOTICE_COLOR: Record<Notice['tone'], string> = { info: 'suggestion', success: 'success', error: 'error' }
const EMPTY_VIEW: View = { repo: null, operation: null, files: [], notice: null }

const view = atom({ plugin: 'conflict-helper', key: 'view' } as const, EMPTY_VIEW)

const git = async ($: EngineInterface, cwd: string | undefined, args: readonly string[]): Promise<Git> => {
  try {
    const run = await $.process.run(['git', ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS })
    return { ok: run.exitCode === 0, out: run.stdout, err: run.stderr.trim() }
  } catch (error) {
    return { ok: false, out: '', err: String(error) }
  }
}

/** Which operation stopped on conflicts: a rebase, merge, cherry-pick or revert; null when none is under way. */
const operationOf = async ($: EngineInterface, root: string): Promise<string | null> => {
  const paths = await git($, root, ['rev-parse', ...OPERATIONS.flatMap(([name]) => ['--git-path', name])])
  if (!paths.ok) return null
  const lines = paths.out.split('\n')
  for (const [index, [, operation]] of OPERATIONS.entries()) {
    const path = lines[index]?.trim()
    if (path !== undefined && path !== '' && (await $.fs.exists(path.startsWith('/') ? path : `${root}/${path}`))) return operation
  }
  return null
}

/** Unmerged files and the conflict blocks still in each. */
const findConflicts = async ($: EngineInterface, root: string): Promise<ConflictFile[]> => {
  const unmerged = await git($, root, ['diff', '--name-only', '--diff-filter=U', '-z'])
  if (!unmerged.ok) return []
  const paths = [...new Set(unmerged.out.split('\0').filter(path => path !== ''))]
  return Promise.all(
    paths.map(async path => {
      const text = await $.fs.read(`${root}/${path}`).catch(() => undefined)
      return { path, hunks: typeof text === 'string' ? parseConflicts(text) : [] }
    }),
  )
}

/** Rescans and publishes (a notice given replaces the shown one, null clears it); says so in a notification (a toast without mods-hub) and the status line when conflicts appear or are all gone. */
const scan = async ($: EngineInterface, notice?: Notice | null): Promise<View> => {
  const top = await git($, undefined, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return update($, view, () => EMPTY_VIEW)
  const root = top.out.trim()
  const [files, operation] = await Promise.all([findConflicts($, root), operationOf($, root)])
  const before = await read($, view)
  const next = await update($, view, (latest: View) => ({
    repo: root,
    operation,
    files: files.map(file => ({ path: file.path, hunks: file.hunks.length })),
    notice: notice === undefined ? latest.notice : notice,
  }))
  const hadConflicts = before.repo === root && before.files.length > 0
  if (files.length > 0) {
    $.ui.status(`conflicts: ${files.length} file${files.length === 1 ? '' : 's'} · /conflicts`)
    if (!hadConflicts) {
      await hubPublish($, {
        topic: 'x.conflict-helper.found',
        data: { files: files.length, hunks: files.reduce((sum, file) => sum + file.hunks.length, 0), operation, paths: files.slice(0, MAX_PUBLISHED_PATHS).map(file => file.path) },
      })
      await hubNotify($, { level: 'warning', title: `${PLUGIN}: ${files.length} conflicted file${files.length === 1 ? '' : 's'}. Run /conflicts to resolve.` })
    }
  } else {
    $.ui.status(undefined)
    if (hadConflicts) await hubNotify($, { level: 'info', title: `${PLUGIN}: all conflicts resolved` })
  }
  return next
}

/** Checks out one side of a conflicted file and stages it. */
const takeSide = async ($: EngineInterface, path: string, side: 'ours' | 'theirs'): Promise<void> => {
  const { repo } = await read($, view)
  if (repo === null) return
  const checkout = await git($, repo, ['checkout', `--${side}`, '--', path])
  const staged = checkout.ok ? await git($, repo, ['add', '--', path]) : checkout
  await scan(
    $,
    staged.ok
      ? { text: `Took ${side} for ${path} and staged it.`, tone: 'success' }
      : { text: `${PLUGIN}: could not take ${side} for ${path}: ${staged.err}`, tone: 'error' },
  )
}

/** Hands Claude the conflict blocks of `paths` (all files when empty) with both sides spelled out. */
const askClaude = async ($: EngineInterface, paths: readonly string[]): Promise<void> => {
  const { repo, operation } = await read($, view)
  if (repo === null) return
  const all = await findConflicts($, repo)
  const chosen = paths.length === 0 ? all : all.filter(file => paths.includes(file.path))
  if (chosen.length === 0) {
    await scan($, { text: 'Those conflicts are already resolved.', tone: 'info' })
    return
  }
  await $.prompt.submit({ text: resolveInstruction(chosen, operation), asUser: true })
  const names = chosen.map(file => file.path).join(', ')
  const notice: Notice = { text: `Asked Claude to resolve ${names}.`, tone: 'info' }
  await update($, view, (latest: View) => ({ ...latest, notice }))
}

const sideHint = (operation: string | null): string =>
  operation === 'rebase'
    ? 'During a rebase, ours is the branch you are rebasing onto and theirs is your commit being replayed.'
    : 'Ours is your current branch (HEAD); theirs is the incoming change.'

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
  await hubHello($, { version: await ownVersion($), publishes: ['x.conflict-helper.found'], consumes: [] })
}

export const register: Register = (on, options) => {
  const isGuarding = options.guard !== false

  on('session.start', async ($, e, next) => {
    await registerCommand($, { name: 'conflicts', description: 'conflict-helper: list merge conflicts and resolve them' })
    afterStart($, 'conflict-helper', () => greetHub($))
    return next(e)
  })

  on('command.run', { command: 'conflicts' }, async $ => {
    const current = await scan($, null)
    if (current.repo === null) return { text: `${PLUGIN}: not in a git repository.` }
    if (current.files.length === 0) return { text: `${PLUGIN}: no merge conflicts.` }
    await $.ui.open({ id: PANE, title: 'Conflicts', focus: true })
    const hunks = current.files.reduce((sum, file) => sum + file.hunks, 0)
    return { text: `${PLUGIN}: ${current.files.length} file${current.files.length === 1 ? '' : 's'}, ${hunks} conflict block${hunks === 1 ? '' : 's'}.` }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    if (GIT_STATE_CHANGE.test(e.command)) await scan($).catch(() => undefined)
    return result
  })

  on('tool.call', { tool: WRITING_TOOLS }, async ($, e, next) => {
    const input = e as { file_path?: unknown; content?: unknown; old_string?: unknown; new_string?: unknown; new_source?: unknown }
    const written = typeof input.content === 'string' ? input.content : typeof input.new_string === 'string' ? input.new_string : input.new_source
    const replaced = typeof input.old_string === 'string' ? input.old_string : ''
    if (isGuarding && typeof written === 'string' && markerCount(written) > markerCount(replaced)) {
      return {
        deny:
          `${PLUGIN}: this write leaves git conflict markers (<<<<<<<, |||||||, >>>>>>>) in the file. ` +
          'Resolve each block into final code and remove every marker line.',
      }
    }
    const result = await next(e)
    const { files } = await read($, view)
    if (files.length > 0) await scan($).catch(() => undefined)
    return result
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const { files } = await read($, view)
    if (files.length === 0) return composed
    const list = files.map(file => file.path).join(', ')
    const section = {
      id: SECTION_ID,
      scope: 'session' as const,
      text:
        `Git merge conflicts are in progress in: ${list}. Never write a file that still contains conflict markers ` +
        '(<<<<<<<, =======, >>>>>>>): resolve every block in it into final code first, and say which side you kept when they contradict.',
    }
    return { sections: [...composed.sections, section] }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const current = await read($, view)
    if (current.repo === null) return <Text dimColor>Not in a git repository.</Text>
    const hunks = current.files.reduce((sum, file) => sum + file.hunks, 0)
    const pathWidth = Math.max(12, e.props.bodyColumns - 44)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>
            {current.operation === null ? 'Merge conflicts' : `${current.operation[0]?.toUpperCase()}${current.operation.slice(1)} conflicts`}
            {current.files.length > 0 ? ` · ${current.files.length} file${current.files.length === 1 ? '' : 's'}, ${hunks} block${hunks === 1 ? '' : 's'}` : ''}
          </Text>
          <Text dimColor>{sideHint(current.operation)}</Text>
        </Box>
        {current.notice !== null && (
          <Box key="notice">
            <Text color={NOTICE_COLOR[current.notice.tone]}>{current.notice.text}</Text>
          </Box>
        )}
        {current.files.length === 0 ? (
          <Box key="clean">
            <Text color="success">✓ No conflicts left. Review, then continue the {current.operation ?? 'merge'}.</Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            {current.files.map(file => (
              <Box key={`row:${file.path}`} flexDirection="row" gap={1}>
                <Box flexGrow={1}>
                  <Text wrap="truncate-start">{file.path.length > pathWidth ? `…${file.path.slice(-(pathWidth - 1))}` : file.path}</Text>
                </Box>
                <Text color={file.hunks > 0 ? 'warning' : 'success'}>
                  {file.hunks > 0 ? `${file.hunks} block${file.hunks === 1 ? '' : 's'}` : 'no markers'}
                </Text>
                <Button key={`ask:${file.path}`} label="Ask Claude" variant="primary" onPress={() => askClaude($, [file.path])} />
                <Button key={`ours:${file.path}`} label="Ours" onPress={() => takeSide($, file.path, 'ours')} />
                <Button key={`theirs:${file.path}`} label="Theirs" onPress={() => takeSide($, file.path, 'theirs')} />
              </Box>
            ))}
          </Box>
        )}
        <Box flexDirection="row" gap={1}>
          {current.files.length > 1 && <Button key="ask-all" label="Ask Claude to resolve all" hotkey="a" onPress={() => askClaude($, [])} />}
          <Button key="rescan" label="Rescan" hotkey="r" onPress={() => scan($, { text: 'Rescanned.', tone: 'info' })} />
          <Button key="close" label="Close" hotkey="q" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
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
