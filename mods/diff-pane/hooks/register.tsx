import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput, Timer } from 'claude-code'

import type { DiffPaneFile as File, DiffPaneView as View } from '../types'
import { EMPTY_TREE, barCells, cutDiff, parseTracked, parseUntracked, shortPath, untrackedEntry } from './parse'

type Git = { ok: boolean; out: string; err: string }

const PLUGIN = 'diff-pane'
const PANE = 'changes'
/**
 * The hub's shared panel, and this mod's tab in it: the Changes tab (files-touched has its own Files tab beside it:
 * a tab id belongs to one mod). Order 250: after the platform's fixed tabs.
 */
const HUB_PANE = 'claude-mods'
const TAB = { id: 'changes', title: 'Changes', order: 250, command: 'changes' } as const
const REFRESH_DELAY_MS = 400
const GIT_TIMEOUT_MS = 20_000
const UNTRACKED_LIMIT = 100
const UNTRACKED_COUNTED = 40
const UNTRACKED_MAX_BYTES = 256 * 1024
const MAX_BAR = 20
const NARROW_COLUMNS = 56
const EDITING_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit|Bash)$/
const STATUS_COLOR: Record<File['status'], string> = { M: 'warning', A: 'success', '?': 'success', D: 'error', T: 'suggestion' }
const EMPTY_VIEW: View = { repo: null, files: [], selected: null, diff: null, updatedAt: 0, error: null }

const view = atom({ plugin: 'diff-pane', key: 'view' } as const, EMPTY_VIEW)

/** What this load knows about the hub: it is installed, and when its git events were last looked at. */
type Hub = { isHubbed: boolean; seenAt: number }

const git = async ($: EngineInterface, cwd: string | undefined, args: readonly string[]): Promise<Git> => {
  try {
    const run = await $.process.run(['git', ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS })
    return { ok: run.exitCode === 0, out: run.stdout, err: run.stderr.trim() }
  } catch (error) {
    return { ok: false, out: '', err: String(error) }
  }
}

/** HEAD, or the empty tree on a branch with no commit yet. */
const baseOf = async ($: EngineInterface, root: string): Promise<string> =>
  (await git($, root, ['rev-parse', '--verify', '-q', 'HEAD'])).ok ? 'HEAD' : EMPTY_TREE

const readUntracked = async ($: EngineInterface, root: string, path: string): Promise<File> => {
  const stat = await $.fs.stat(`${root}/${path}`).catch(() => undefined)
  if (stat?.kind !== 'file' || stat.size > UNTRACKED_MAX_BYTES) return untrackedEntry(path, undefined)
  const text = await $.fs.read(`${root}/${path}`).catch(() => undefined)
  return untrackedEntry(path, typeof text === 'string' ? text : undefined)
}

/** Every file that differs from HEAD, untracked ones included, with line counts. */
const scan = async ($: EngineInterface, root: string): Promise<{ files: File[]; error: string | null }> => {
  const base = await baseOf($, root)
  const [numstat, nameStatus, others] = await Promise.all([
    git($, root, ['diff', base, '--numstat', '-z', '--no-renames']),
    git($, root, ['diff', base, '--name-status', '-z', '--no-renames']),
    git($, root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ])
  if (!numstat.ok) return { files: [], error: `git diff failed: ${numstat.err}` }
  // Line counts for the first few untracked files only: each one is a read.
  const untracked = await Promise.all(
    parseUntracked(others.out)
      .slice(0, UNTRACKED_LIMIT)
      .map((path, index) => (index < UNTRACKED_COUNTED ? readUntracked($, root, path) : untrackedEntry(path, undefined))),
  )
  const files = [...parseTracked(numstat.out, nameStatus.out), ...untracked].sort((a, b) => a.path.localeCompare(b.path))
  return { files, error: null }
}

/** The unified diff of one file against HEAD, from its first hunk on. */
const diffOf = async ($: EngineInterface, root: string, file: File): Promise<string> => {
  const run =
    file.status === '?'
      ? await git($, root, ['diff', '--no-index', '--no-color', '--', '/dev/null', file.path])
      : await git($, root, ['diff', await baseOf($, root), '--no-color', '--no-ext-diff', '--', file.path])
  const firstHunk = run.out.indexOf('@@')
  return firstHunk === -1 ? '' : cutDiff(run.out.slice(firstHunk)).text
}

const showDiff = async ($: EngineInterface, path: string | null): Promise<void> => {
  const current = await read($, view)
  const file = current.files.find(entry => entry.path === path)
  if (current.repo === null || file === undefined) {
    await update($, view, (latest: View) => ({ ...latest, selected: null, diff: null }))
    return
  }
  await update($, view, (latest: View) => ({ ...latest, selected: file.path, diff: null }))
  const diff = file.isBinary ? '' : await diffOf($, current.repo, file)
  await update($, view, (latest: View) => (latest.selected === file.path ? { ...latest, diff } : latest))
}

/** Rescans the repository the session is in, keeping the open diff if its file still changed. */
const refresh = async ($: EngineInterface): Promise<void> => {
  const top = await git($, undefined, ['rev-parse', '--show-toplevel'])
  if (!top.ok) {
    await update($, view, () => EMPTY_VIEW)
    return
  }
  const root = top.out.trim()
  const { files, error } = await scan($, root)
  const updatedAt = await $.clock.now()
  const { selected } = await update($, view, (latest: View) => {
    const isKept = latest.repo === root && files.some(file => file.path === latest.selected)
    return { repo: root, files, error, updatedAt, selected: isKept ? latest.selected : null, diff: isKept ? latest.diff : null }
  })
  if (selected !== null) await showDiff($, selected)
}

/** Whether this view is on screen: its own pane is open, or the hub's panel is open on the Changes tab. */
const isViewOpen = async ($: EngineInterface, hub: Hub): Promise<boolean> => {
  const panes = await $.ui.panes()
  return panes.some(pane => pane.id === PANE) || (hub.isHubbed && panes.some(pane => pane.id === HUB_PANE) && (await hubTabIs($, TAB.id)))
}

const refreshIfOpen = async ($: EngineInterface, hub: Hub): Promise<void> => {
  try {
    if (await isViewOpen($, hub)) await refresh($)
  } catch (error) {
    $.ui.log(`${PLUGIN}: refresh failed: ${String(error)}`, { to: 'debug' })
  }
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

/** With mods-hub installed: hello, the Changes tab in its panel, and a first scan so the tab has something to draw. */
async function greetHub($: EngineInterface, hub: Hub): Promise<void> {
  if ((await hubMode($)) === undefined) return
  hub.isHubbed = await hubHello($, { version: await ownVersion($), publishes: [], consumes: ['git.commit'] }, TAB)
  hub.seenAt = await $.clock.now()
  try {
    await refresh($)
  } catch (error) {
    $.ui.log(`${PLUGIN}: first scan failed: ${String(error)}`, { to: 'debug' })
  }
}

/** A commit another mod made (through git, not a tool call of Claude's) moves HEAD under the list: rescan when the hub has seen one. */
async function refreshOnCommit($: EngineInterface, hub: Hub): Promise<void> {
  if (!hub.isHubbed) return
  const since = hub.seenAt
  hub.seenAt = await $.clock.now()
  try {
    if ((await $.mods.recent({ topic: 'git.commit', since })).length > 0) await refreshIfOpen($, hub)
  } catch {
    // The hub went away: nothing to watch.
  }
}

const copyPath = async ($: EngineInterface, path: string, surface: Parameters<EngineInterface['ui']['copy']>[0]['surface']) => {
  const copied = await $.ui.copy({ text: path, surface })
  $.ui.toast(copied.isCopied ? `Copied ${path}` : `${PLUGIN}: could not copy (${copied.reason})`)
}

/** The changes view: this mod's own pane, or its section of the Changes tab in the hub's panel (`isTab`). */
async function drawChanges($: EngineInterface, e: RenderInput<'Pane'>, isTab: boolean): Promise<RenderElement> {
  const { Box, Button, Code, Text } = $.ui.resolve(e)
  const current = await read($, view)
  if (current.repo === null) {
    return isTab ? (
      <Box key="changes-empty" flexDirection="row" gap={1}>
        <Text dimColor>No git repository here, or not scanned yet.</Text>
        <Button key="refresh" label="Refresh" plain dimColor onPress={() => refresh($)} />
      </Box>
    ) : (
      <Text dimColor>Not in a git repository.</Text>
    )
  }

  const columns = e.props.bodyColumns
  const isNarrow = columns < NARROW_COLUMNS
  const barWidth = isNarrow ? 0 : Math.min(MAX_BAR, Math.floor(columns / 6))
  const countsWidth = 13
  const pathWidth = Math.max(10, columns - 2 - countsWidth - (barWidth > 0 ? barWidth + 1 : 0) - 14)
  const largest = Math.max(0, ...current.files.map(file => file.adds + file.dels))
  const adds = current.files.reduce((sum, file) => sum + file.adds, 0)
  const dels = current.files.reduce((sum, file) => sum + file.dels, 0)
  const repoName = current.repo.split(/[\\/]/).pop() ?? current.repo

  const bar = (plusCount: number, minusCount: number, cells: number) => {
    const { plus, minus } = barCells(plusCount, minusCount, largest, cells)
    return (
      <Text>
        <Text color="success">{'+'.repeat(plus)}</Text>
        <Text color="error">{'-'.repeat(minus)}</Text>
        {' '.repeat(Math.max(0, cells - plus - minus))}
      </Text>
    )
  }
  const counts = (file: File) =>
    file.isBinary ? 'binary' : file.status === '?' && file.adds === 0 ? 'new' : `+${file.adds} −${file.dels}`

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text bold>{repoName}</Text>
        <Text dimColor>vs HEAD · updates after each edit</Text>
        <Button key="refresh" label="Refresh" plain dimColor onPress={() => refresh($)} />
      </Box>
      {current.error !== null && (
        <Box key="error">
          <Text color="error">{current.error}</Text>
        </Box>
      )}
      {current.files.length === 0 && current.error === null && (
        <Box key="clean">
          <Text color="success">✓ Nothing changed since HEAD</Text>
        </Box>
      )}
      {current.files.map(file => {
        const isSelected = file.path === current.selected
        return (
          <Box key={`row:${file.path}`} flexDirection="row" gap={1}>
            <Text color={STATUS_COLOR[file.status]} bold>
              {file.status}
            </Text>
            <Box flexGrow={1}>
              <Text bold={isSelected} wrap="truncate-start">
                {shortPath(file.path, pathWidth)}
              </Text>
            </Box>
            <Text dimColor>{counts(file).padStart(countsWidth - 2)}</Text>
            {barWidth > 0 && bar(file.adds, file.dels, barWidth)}
            <Button key={`copy:${file.path}`} label="Copy" plain dimColor onPress={press => copyPath($, file.path, press.surface)} />
            <Button
              key={`diff:${file.path}`}
              label={isSelected ? 'Hide' : 'Diff'}
              plain
              dimColor={!isSelected}
              onPress={() => showDiff($, isSelected ? null : file.path)}
            />
          </Box>
        )
      })}
      {current.files.length > 0 && (
        <Box key="totals" flexDirection="row" gap={1}>
          <Text bold>
            {current.files.length} file{current.files.length === 1 ? '' : 's'} changed
          </Text>
          <Text>
            <Text color="success">+{adds}</Text> <Text color="error">−{dels}</Text>
          </Text>
        </Box>
      )}
      {current.selected !== null && (
        <Box key="diff" flexDirection="column" marginTop={1}>
          <Text bold>{current.selected}</Text>
          {current.diff === null ? (
            <Text dimColor>Loading the diff…</Text>
          ) : current.diff === '' ? (
            <Text dimColor>No text changes to show (binary file or mode change).</Text>
          ) : (
            <Code format="diff" source={current.diff} path={current.selected} />
          )}
        </Box>
      )}
    </Box>
  )
}

export const register: Register = on => {
  let pending: Timer | undefined
  const hub: Hub = { isHubbed: false, seenAt: 0 }

  on('session.start', async ($, e, next) => {
    await registerCommand($, { name: 'changes', description: 'diff-pane: live list of changed files with +/- counts' })
    afterStart($, 'diff-pane', () => greetHub($, hub))
    return next(e)
  })

  // `/changes`: the Changes tab of the hub's panel when the hub is installed, this mod's own pane otherwise.
  on('command.run', { command: 'changes' }, async $ => {
    await refresh($)
    const { repo } = await read($, view)
    if (repo === null) return { text: `${PLUGIN}: not in a git repository.` }
    if (await hubShowTab($, TAB.id)) return { text: 'Changes tab opened.' }
    await $.ui.open({ id: PANE, title: 'Changes' })
    return { text: 'Changes pane opened.' }
  })

  on('tool.call', { tool: EDITING_TOOLS }, async ($, e, next) => {
    const result = await next(e)
    // Several edits in a row refresh once, shortly after the last.
    pending?.cancel()
    pending = $.clock.after(REFRESH_DELAY_MS, () => {
      pending = undefined
      void refreshIfOpen($, hub)
    })
    return result
  })

  on('turn.complete', async ($, e, next) => {
    await refreshOnCommit($, hub)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawChanges($, e, false))

  // The Changes tab: drawn beneath the hub's tab strip when it is the tab shown; any other tab passes through.
  on('ui.render', { component: 'Pane', requestId: HUB_PANE }, async ($, e, next) => {
    if (!(await hubTabIs($, TAB.id))) return next(e)
    const { Box } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {await next(e)}
        {await drawChanges($, e, true)}
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
