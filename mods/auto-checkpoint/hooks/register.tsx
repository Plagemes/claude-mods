import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AutoCheckpointEntry as Entry, AutoCheckpointNotice as Notice, AutoCheckpointView as View } from '../types'

type Repo = { root: string; index: string; head: string | undefined }
type GitResult = { ok: boolean; out: string; err: string }
type Saved = { kind: 'created' | 'unchanged'; entry: Entry } | { kind: 'failed'; why: string }
/** Whether snapshots are paused for this session (one timed out). */
type Health = { isPaused: boolean }

const PLUGIN = 'auto-checkpoint'
const PANE = 'checkpoints'
const REF_PREFIX = 'refs/claude-checkpoints/'
const INDEX_NAME = 'claude-checkpoint.index'
const PROMPT_LIMIT = 200
const GIT_TIMEOUT_MS = 20_000
/** How `$.process.run` reports a command that outran its timeout. */
const TIMED_OUT = /still running after/
const DEFAULT_KEEP = 20
const MAX_KEEP = 200
const EDITING_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit|Bash)$/
/** Bash commands that only read: no checkpoint is needed before them. */
const READ_ONLY_BASH = /^\s*(?:ls|cat|head|tail|less|grep|rg|pwd|echo|which|wc|stat|file|tree|du|df|git\s+(?:status|log|diff|show|blame|rev-parse))\b[^;&|>`$]*$/
const IDENTITY = {
  GIT_AUTHOR_NAME: PLUGIN,
  GIT_AUTHOR_EMAIL: 'auto-checkpoint@localhost',
  GIT_COMMITTER_NAME: PLUGIN,
  GIT_COMMITTER_EMAIL: 'auto-checkpoint@localhost',
}
const NOTICE_COLOR: Record<Notice['tone'], string> = { info: 'suggestion', success: 'success', error: 'error' }
/** How much of the prompt goes on the bus with a saved checkpoint. */
const BUS_PROMPT_LIMIT = 80
const EMPTY_VIEW: View = { repo: null, items: [], confirming: null, notice: null }

const view = atom({ plugin: 'auto-checkpoint', key: 'view' } as const, EMPTY_VIEW)

const storeKey = (root: string): string => `checkpoints:${root}`

const git = async ($: EngineInterface, cwd: string | undefined, args: readonly string[], env?: Record<string, string>): Promise<GitResult> => {
  try {
    const run = await $.process.run(['git', ...args], { cwd, env, timeoutMs: GIT_TIMEOUT_MS })
    return { ok: run.exitCode === 0, out: run.stdout.trim(), err: run.stderr.trim() }
  } catch (error) {
    return { ok: false, out: '', err: String(error) }
  }
}

/** The repository the session works in, or undefined outside one. */
const repoAt = async ($: EngineInterface): Promise<Repo | undefined> => {
  const top = await git($, undefined, ['rev-parse', '--show-toplevel'])
  if (!top.ok || top.out === '') return undefined
  const [index, head] = await Promise.all([
    git($, top.out, ['rev-parse', '--git-path', INDEX_NAME]),
    git($, top.out, ['rev-parse', '--verify', '-q', 'HEAD']),
  ])
  return index.ok ? { root: top.out, index: index.out, head: head.ok ? head.out : undefined } : undefined
}

const loadEntries = async ($: EngineInterface, root: string): Promise<Entry[]> => {
  const stored = await $.store.get(storeKey(root))
  return Array.isArray(stored) ? (stored as Entry[]) : []
}

const publish = async ($: EngineInterface, root: string | null, items: readonly Entry[]): Promise<void> => {
  await update($, view, (current: View) => ({ ...current, repo: root, items: [...items] }))
}

/**
 * Writes the work tree (tracked and untracked, minus ignored files) to a tree object
 * through a private index, so the real index, HEAD and the files stay untouched.
 */
const snapshotTree = async ($: EngineInterface, repo: Repo): Promise<GitResult> => {
  const env = { GIT_INDEX_FILE: repo.index }
  const seeded = await git($, repo.root, repo.head === undefined ? ['read-tree', '--empty'] : ['read-tree', '--reset', 'HEAD'], env)
  if (!seeded.ok) return seeded
  const added = await git($, repo.root, ['add', '-A', '--', '.'], env)
  return added.ok ? git($, repo.root, ['write-tree'], env) : added
}

/** Records the work tree as checkpoint n+1, unless it equals the newest one; prunes past `keep`. */
const saveCheckpoint = async ($: EngineInterface, repo: Repo, prompt: string, keep: number): Promise<Saved> => {
  const tree = await snapshotTree($, repo)
  if (!tree.ok) return { kind: 'failed', why: tree.err }
  const entries = await loadEntries($, repo.root)
  const newest = entries.at(-1)
  if (newest?.tree === tree.out) return { kind: 'unchanged', entry: newest }

  const n = (newest?.n ?? 0) + 1
  const label = prompt.replace(/\s+/g, ' ').trim().slice(0, PROMPT_LIMIT)
  const parents = repo.head === undefined ? [] : ['-p', repo.head]
  const commit = await git($, repo.root, ['commit-tree', tree.out, ...parents, '-m', `checkpoint #${n}: ${label}`], IDENTITY)
  if (!commit.ok) return { kind: 'failed', why: commit.err }
  const ref = await git($, repo.root, ['update-ref', `${REF_PREFIX}${n}`, commit.out])
  if (!ref.ok) return { kind: 'failed', why: ref.err }

  const entry: Entry = { n, sha: commit.out, tree: tree.out, at: await $.clock.now(), prompt: label }
  const all = [...entries, entry]
  const kept = all.slice(-keep)
  for (const old of all.slice(0, all.length - kept.length)) {
    await git($, repo.root, ['update-ref', '-d', `${REF_PREFIX}${old.n}`])
  }
  await $.store.set(storeKey(repo.root), kept)
  await publish($, repo.root, kept)
  await hubPublish($, {
    topic: 'x.auto-checkpoint.saved',
    data: { n, sha: commit.out, repo: repo.root.split(/[\\/]/).pop() ?? repo.root, prompt: label.slice(0, BUS_PROMPT_LIMIT) },
  })
  return { kind: 'created', entry }
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

/** With mods-hub installed: hello (this mod publishes `x.auto-checkpoint.saved`). */
async function greetHub($: EngineInterface): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: ['x.auto-checkpoint.saved'], consumes: [] })
}

/** A notice through the hub; without it the status line already says it, so nothing else is shown. */
async function hubWarn($: EngineInterface, input: Parameters<typeof hubNotify>[1]): Promise<void> {
  try {
    await $.mods.notify(input)
  } catch {
    // No hub.
  }
}

/** Before the first edit of a turn: checkpoint quietly, never failing the tool call. */
const checkpointTurn = async ($: EngineInterface, prompt: string, keep: number, health: Health): Promise<void> => {
  try {
    const repo = await repoAt($)
    if (repo === undefined) return
    const saved = await saveCheckpoint($, repo, prompt, keep)
    if (saved.kind === 'created') $.ui.status(`checkpoint #${saved.entry.n} saved · /checkpoints`)
    if (saved.kind === 'failed') {
      $.ui.log(`${PLUGIN}: snapshot failed: ${saved.why}`, { to: 'debug' })
      // A snapshot that outran its timeout would make every later turn wait as long again: stop for this session.
      if (TIMED_OUT.test(saved.why)) {
        health.isPaused = true
        const paused = `a snapshot took over ${GIT_TIMEOUT_MS / 1000}s in this repository`
        $.ui.status(`checkpoints paused: ${paused}`)
        await hubWarn($, { level: 'warning', title: 'Checkpoints paused', body: `${paused}, so no more are taken this session.` })
      }
    }
  } catch (error) {
    $.ui.log(`${PLUGIN}: snapshot failed: ${String(error)}`, { to: 'debug' })
  }
}

/** Saves the current state, then moves the work tree to checkpoint `n`; the index and HEAD stay. */
const rollbackTo = async ($: EngineInterface, n: number, keep: number): Promise<Notice> => {
  const failed = (text: string): Notice => ({ text: `${PLUGIN}: ${text}`, tone: 'error' })
  const repo = await repoAt($)
  if (repo === undefined) return failed('not in a git repository.')
  const target = (await loadEntries($, repo.root)).find(entry => entry.n === n)
  if (target === undefined) return failed(`there is no checkpoint #${n}.`)

  const saved = await saveCheckpoint($, repo, `before rollback to #${n}`, keep)
  if (saved.kind === 'failed') return failed(`could not save the current state first (${saved.why}); nothing was changed.`)
  if (saved.entry.tree === target.tree) return { text: `The work tree already matches #${n}.`, tone: 'info' }

  const moved = await git($, repo.root, ['read-tree', '-m', '-u', saved.entry.tree, target.tree], { GIT_INDEX_FILE: repo.index })
  if (!moved.ok) return failed(`rollback to #${n} failed: ${moved.err}`)
  return { text: `Rolled back to #${n}. The state before is saved as #${saved.entry.n}.`, tone: 'success' }
}

/** Loads the list for the pane, in the repository the session is in now. */
const refreshView = async ($: EngineInterface): Promise<Repo | undefined> => {
  const repo = await repoAt($)
  await publish($, repo?.root ?? null, repo === undefined ? [] : await loadEntries($, repo.root))
  return repo
}

const ago = (now: number, at: number): string => {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

export const register: Register = (on, options) => {
  const keep = Math.min(MAX_KEEP, Math.max(1, Math.round(typeof options.keep === 'number' ? options.keep : DEFAULT_KEEP)))
  let turn: { id: string; prompt: string; snapshot?: Promise<void> } | undefined
  let lastPrompt = ''
  const health: Health = { isPaused: false }

  on('session.start', async ($, e, next) => {
    await greetHub($)
    await $.command.register({ name: 'checkpoints', description: 'auto-checkpoint: list work-tree checkpoints and roll back' })
    await $.command.register({ name: 'rollback', description: 'auto-checkpoint: roll the work tree back to a checkpoint', argumentHint: '<n>' })
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.text.trim() !== '') lastPrompt = e.text.trim()
    turn = { id: e.turnId, prompt: lastPrompt }
    return next(e)
  })

  on('tool.call', { tool: EDITING_TOOLS }, async ($, e, next) => {
    const isReadOnly = e.tool === 'Bash' && READ_ONLY_BASH.test(e.command)
    if (turn !== undefined && !isReadOnly && !health.isPaused) {
      turn.snapshot ??= checkpointTurn($, turn.prompt, keep, health)
      await turn.snapshot
    }
    return next(e)
  })

  on('command.run', { command: 'checkpoints' }, async $ => {
    const repo = await refreshView($)
    if (repo === undefined) return { text: 'Not in a git repository, so there are no checkpoints.' }
    await update($, view, (current: View) => ({ ...current, confirming: null, notice: null }))
    await $.ui.open({ id: PANE, title: 'Checkpoints' })
    return { text: 'Checkpoints pane opened.' }
  })

  on('command.run', { command: 'rollback' }, async ($, e) => {
    const n = Number(e.args.trim().replace(/^#/, ''))
    const repo = await refreshView($)
    if (repo === undefined) return { text: 'Not in a git repository.' }
    const { items } = await read($, view)
    if (!Number.isInteger(n) || !items.some(entry => entry.n === n)) {
      const known = items.map(entry => `#${entry.n}`).join(', ') || 'none yet'
      return { text: `Usage /rollback <n>. Checkpoints: ${known}.` }
    }
    await update($, view, (current: View) => ({ ...current, confirming: n, notice: null }))
    await $.ui.open({ id: PANE, title: 'Checkpoints', focus: true })
    return { text: `Confirm the rollback to #${n} in the Checkpoints pane.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const current = await read($, view)
    const now = await $.clock.now()
    const promptWidth = Math.max(10, e.props.bodyColumns - 26)

    const setView = (change: Partial<View>) => update($, view, (latest: View) => ({ ...latest, ...change }))
    const confirm = async (n: number) => {
      await setView({ confirming: null, notice: { text: `Rolling back to #${n}...`, tone: 'info' } })
      await setView({ notice: await rollbackTo($, n, keep) })
    }

    if (current.repo === null) {
      return <Text dimColor>Not in a git repository: no checkpoints here.</Text>
    }
    const items = [...current.items].reverse()
    const repoName = current.repo.split(/[\\/]/).pop() ?? current.repo

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold>{repoName}</Text>
          <Text dimColor>
            {items.length} checkpoint{items.length === 1 ? '' : 's'} · newest first · keeps {keep}
          </Text>
        </Box>
        {current.notice !== null && (
          <Box key="notice">
            <Text color={NOTICE_COLOR[current.notice.tone]}>{current.notice.text}</Text>
          </Box>
        )}
        {items.length === 0 && <Text dimColor>No checkpoints yet. One is taken before the first edit of each turn.</Text>}
        {items.map(entry =>
          current.confirming === entry.n ? (
            <Box key={`confirm-${entry.n}`} flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
              <Text>
                Roll the work tree back to #{entry.n}? The current state is saved as a new checkpoint first; the index
                and branch are not touched.
              </Text>
              <Box flexDirection="row" gap={1}>
                <Button key="confirm" label={`Roll back to #${entry.n}`} variant="primary" autoFocus onPress={() => confirm(entry.n)} />
                <Button key="cancel" label="Cancel" onPress={() => setView({ confirming: null })} />
              </Box>
            </Box>
          ) : (
            <Box key={`row-${entry.n}`} flexDirection="row" gap={1}>
              <Text bold>{`#${entry.n}`.padEnd(4)}</Text>
              <Text dimColor>{ago(now, entry.at).padEnd(8)}</Text>
              <Box flexGrow={1}>
                <Text wrap="truncate-end">{entry.prompt === '' ? '(no prompt)' : entry.prompt.slice(0, promptWidth)}</Text>
              </Box>
              <Button key={`rollback-${entry.n}`} label="Roll back" dimColor onPress={() => setView({ confirming: entry.n, notice: null })} />
            </Box>
          ),
        )}
        <Text dimColor>Kept under {REF_PREFIX}* · the index and branch are never touched</Text>
      </Box>
    )
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
