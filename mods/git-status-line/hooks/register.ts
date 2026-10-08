import type { EngineInterface, Register, Timer } from 'claude-code'

import { describeState, parseStatus, type GitState } from './format'

// Anything that can change the working tree, the index or HEAD.
const GIT_AFFECTING_TOOLS = /^(?:Bash|Edit|Write|MultiEdit|NotebookEdit)$/
const GIT_TIMEOUT_MS = 5000

type Memo = {
  timer?: Timer
  shown?: string
  /** mods-hub is installed: git events on its bus are watched, and the branch is shared as a fact. */
  isHubbed: boolean
  /** The clock when the hub's git events were last looked at. */
  hubSeenAt: number
}

type Settings = { debounceMs: number; showUntracked: boolean }

async function gitState($: EngineInterface, showUntracked: boolean): Promise<GitState | undefined> {
  const argv = ['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch', ...(showUntracked ? [] : ['--untracked-files=no'])]
  try {
    const { exitCode, stdout } = await $.process.run(argv, { timeoutMs: GIT_TIMEOUT_MS })
    return exitCode === 0 ? parseStatus(stdout) : undefined
  } catch {
    return undefined
  }
}

/** The fact `git-status-line.branch` on the hub's blackboard: where the repository stands, for any mod that wants it. */
async function shareBranch($: EngineInterface, state: GitState | undefined): Promise<void> {
  try {
    await $.mods.share({
      name: 'branch',
      value: state === undefined ? null : { branch: state.branch, ahead: state.ahead, behind: state.behind, dirty: state.dirty, isDetached: state.isDetached },
    })
  } catch {
    // No hub: the status line is all there is.
  }
}

async function refresh($: EngineInterface, memo: Memo, settings: Settings): Promise<void> {
  const state = await gitState($, settings.showUntracked)
  const text = state === undefined ? undefined : describeState(state)
  if (text === memo.shown) return
  memo.shown = text
  $.ui.status(text)
  if (memo.isHubbed) await shareBranch($, state)
}

/** Runs one refresh `delayMs` after the last request; a newer request replaces the pending one. */
function scheduleRefresh($: EngineInterface, memo: Memo, settings: Settings, delayMs: number): void {
  memo.timer?.cancel()
  memo.timer = $.clock.after(delayMs, () => {
    void refresh($, memo, settings)
  })
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

/** With mods-hub installed: hello (this mod reads `git.commit` and `git.push`), then watch the bus. */
async function greetHub($: EngineInterface, memo: Memo): Promise<void> {
  if ((await hubMode($)) === undefined) return
  memo.isHubbed = await hubHello($, { version: await ownVersion($), publishes: [], consumes: ['git.commit', 'git.push'] })
  memo.hubSeenAt = await $.clock.now()
}

/**
 * A commit or push made by another mod (commit-composer runs git itself, so no tool call of Claude's shows it)
 * changes the branch line: refresh at once when the hub has seen one since the last look.
 */
async function refreshOnGitEvents($: EngineInterface, memo: Memo, settings: Settings): Promise<void> {
  if (!memo.isHubbed) return
  const since = memo.hubSeenAt
  memo.hubSeenAt = await $.clock.now()
  try {
    if ((await $.mods.recent({ prefix: 'git.', since })).length > 0) scheduleRefresh($, memo, settings, 0)
  } catch {
    // The hub went away: nothing to watch.
  }
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    debounceMs: Math.max(0, Number(options.debounceMs ?? 600)),
    showUntracked: options.showUntracked !== false,
  }
  const memo: Memo = { isHubbed: false, hubSeenAt: 0 }

  on('session.start', async ($, e, next) => {
    // The hello first, so the first refresh knows whether to share the branch; both wait until session.start has
    // returned (afterStart), keeping git out of the start-up chain.
    afterStart($, 'git-status-line', async () => {
      await greetHub($, memo)
      scheduleRefresh($, memo, settings, 0)
    })
    return next(e)
  })

  on('tool.call', { tool: GIT_AFFECTING_TOOLS }, async ($, e, next) => {
    await refreshOnGitEvents($, memo, settings)
    const result = await next(e)
    scheduleRefresh($, memo, settings, settings.debounceMs)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    await refreshOnGitEvents($, memo, settings)
    return next(e)
  })
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
