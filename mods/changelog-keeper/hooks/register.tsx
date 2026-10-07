import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ChangelogView } from '../types'
import { countEntries, insertEntry, parseCommit, TEMPLATE, unreleasedOf } from './changelog'
import type { ParseOptions } from './changelog'

const NAME = 'changelog-keeper'
const PANE = 'changelog'
const GIT_TIMEOUT_MS = 10_000
/** A commit made this long before the Bash call started still counts as its own (clock skew). */
const COMMIT_GRACE_MS = 2_000
const COMMIT_COMMAND = /\bgit(?:\s+-[cC]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+commit\b/
const AMEND = /\bcommit\b[^;&|\n]*\s--amend\b/
/** How often, with mods-hub installed, the commits other mods published (`git.commit`) are looked at. */
const HUB_POLL_MS = 10_000
const MAX_PULLED = 20

const viewAtom = atom({ plugin: 'changelog-keeper', key: 'view' } as const, null)

type Settings = ParseOptions & { path: string; createIfMissing: boolean; includeHash: boolean }
type Commit = { short: string; subject: string; body: string; committedAt: number }
/** The commits this load already handled (short sha), and how far the hub's `git.commit` events were read. */
type Seen = { shas: Set<string>; since: number }

const isAbsolute = (path: string): boolean => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)

async function git($: EngineInterface, args: readonly string[], cwd?: string): Promise<string | undefined> {
  try {
    const run = await $.process.run(['git', ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS })
    return run.exitCode === 0 ? run.stdout : undefined
  } catch {
    return undefined
  }
}

async function changelogPath($: EngineInterface, settings: Settings): Promise<string | undefined> {
  if (isAbsolute(settings.path)) return settings.path
  const top = await git($, ['rev-parse', '--show-toplevel'])
  return top === undefined ? undefined : `${top.trim()}/${settings.path}`
}

async function readCommit($: EngineInterface, ref: string): Promise<Commit | undefined> {
  const out = await git($, ['log', '-1', '--format=%h%x00%ct%x00%s%x00%b', ref])
  if (out === undefined) return undefined
  const [short = '', seconds = '0', subject = '', body = ''] = out.split('\0')
  return { short: short.trim(), subject, body, committedAt: Number(seconds) * 1000 }
}

async function loadView($: EngineInterface, settings: Settings): Promise<ChangelogView> {
  const path = await changelogPath($, settings)
  if (path === undefined) return { path: settings.path, status: 'no-repo', unreleased: '', entries: 0 }
  if (!(await $.fs.exists(path))) return { path: settings.path, status: 'missing', unreleased: '', entries: 0 }
  const unreleased = unreleasedOf(await $.fs.read(path))
  if (unreleased === undefined) return { path: settings.path, status: 'no-unreleased', unreleased: '', entries: 0 }
  return { path: settings.path, status: 'ok', unreleased, entries: countEntries(unreleased) }
}

/** Writes the commit's entry; answers the note Claude reads, or undefined when nothing changed. */
async function recordCommit($: EngineInterface, settings: Settings, commit: Commit): Promise<string | undefined> {
  const entry = parseCommit(commit.subject, commit.body, settings)
  if (entry === undefined) return undefined
  const path = await changelogPath($, settings)
  if (path === undefined) return undefined
  const exists = await $.fs.exists(path)
  if (!exists && !settings.createIfMissing) return undefined
  const current = exists ? await $.fs.read(path) : TEMPLATE
  const inserted = insertEntry(current, entry, settings.includeHash && commit.short !== '' ? ` (${commit.short})` : '')
  if (!inserted.isChanged) return undefined
  await $.fs.write(path, inserted.markdown)
  const view = await loadView($, settings)
  await update($, viewAtom, () => view)
  await hubNotify($, { level: 'info', title: `${entry.section} · ${entry.text}`, topic: 'git.commit' })
  return `${NAME} added "- ${entry.text}" under ## [Unreleased] › ### ${entry.section} in ${settings.path}${exists ? '' : ' (new file)'}; the change is not committed yet.`
}

// ── mods-hub: commits made outside Claude's Bash tool ───────────────────────────────────────────────

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Says hello to mods-hub when it is installed; false without it. */
async function greetHub($: EngineInterface): Promise<boolean> {
  if ((await hubMode($)) === undefined) return false
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: ['git.commit'] })
  return true
}

/**
 * The commits other mods published since the last look (commit-composer commits from its pane with git
 * directly, which the Bash hook never sees), each recorded like a Bash commit. Commits already handled are skipped.
 */
async function pullCommits($: EngineInterface, settings: Settings, seen: Seen): Promise<void> {
  try {
    const events = await $.mods.recent({ topic: 'git.commit', since: seen.since, limit: MAX_PULLED })
    for (const event of events) {
      seen.since = Math.max(seen.since, event.at)
      const sha = (event.data as { sha?: unknown }).sha
      if (typeof sha !== 'string' || sha === '') continue
      const commit = await readCommit($, sha)
      if (commit === undefined || seen.shas.has(commit.short)) continue
      seen.shas.add(commit.short)
      await recordCommit($, settings, commit)
    }
  } catch (error) {
    $.ui.log(`${NAME}: could not read the hub's commits: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
  }
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    path: String(options.path ?? '').trim() || 'CHANGELOG.md',
    createIfMissing: options.createIfMissing !== false,
    includeHash: options.includeHash === true,
    includeChores: options.includeChores === true,
    untyped: options.untyped === 'skip' ? 'skip' : 'changed',
  }
  const seen: Seen = { shas: new Set(), since: 0 }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'changelog', description: "Show the Unreleased section of CHANGELOG.md" })
    if (await greetHub($)) {
      seen.since = await $.clock.now()
      $.clock.every(HUB_POLL_MS, () => void pullCommits($, settings, seen))
    }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // An amend rewrites a commit the changelog already has: its subject is no new change.
    if (!COMMIT_COMMAND.test(e.command) || AMEND.test(e.command)) return next(e)
    const startedAt = await $.clock.now()
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    try {
      const operation = ran.result.gitOperation?.commit
      if (operation?.kind === 'amended') return ran
      const commit = await readCommit($, operation?.sha ?? 'HEAD')
      // Without the engine's git record, only a HEAD made during this call is this call's commit.
      const isOwn = operation !== undefined || (commit !== undefined && commit.committedAt >= startedAt - COMMIT_GRACE_MS)
      if (commit === undefined || !isOwn) return ran
      seen.shas.add(commit.short)
      const note = await recordCommit($, settings, commit)
      return note === undefined ? ran : { ...ran, context: [...(ran.context ?? []), note] }
    } catch (error) {
      $.ui.log(`${NAME}: could not update the changelog: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
      return ran
    }
  }).catch(($, e, next) => next(e)) // never runs the command twice: after `next`, this replays its answer

  on('command.run', { command: 'changelog' }, async $ => {
    const view = await loadView($, settings)
    await update($, viewAtom, () => view)
    if (view.status === 'no-repo') return { text: 'Not inside a git repository.' }
    await $.ui.open({ id: PANE, title: 'Unreleased', rows: 18 })
    if (view.status === 'missing') return { text: `No ${view.path} yet; it starts with your next feat/fix commit.` }
    if (view.status === 'no-unreleased') return { text: `${view.path} has no ## [Unreleased] section yet.` }
    return { text: `${view.entries} unreleased ${view.entries === 1 ? 'entry' : 'entries'} in ${view.path}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const view = await read($, viewAtom)
    const copy = async (surface: typeof e.surface) => {
      if (view === null) return
      const copied = await $.ui.copy({ text: view.unreleased, surface })
      $.ui.toast(copied.isCopied ? 'Unreleased copied' : `Could not copy (${copied.reason})`)
    }
    const reload = async () => {
      const fresh = await loadView($, settings)
      await update($, viewAtom, () => fresh)
    }
    const empty =
      view === null ? 'Loading…'
        : view.status === 'missing' ? `No ${view.path} yet. It is created with your next feat: or fix: commit.`
          : view.status === 'no-unreleased' ? `${view.path} has no ## [Unreleased] section; one is added with the next entry.`
            : view.status === 'no-repo' ? 'Not inside a git repository.'
              : view.entries === 0 ? 'Nothing unreleased yet.' : undefined

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>{view === null ? 'Unreleased' : `Unreleased · ${view.entries} ${view.entries === 1 ? 'entry' : 'entries'}`}</Text>
          {view !== null && <Text dimColor>{`${view.path} · Keep a Changelog`}</Text>}
        </Box>
        {empty !== undefined ? <Text dimColor>{empty}</Text> : <Markdown key="unreleased" text={view?.unreleased ?? ''} />}
        <Box gap={1}>
          {view !== null && view.entries > 0 && (
            <Button key="copy" label="Copy" hotkey="c" variant="primary" onPress={press => void copy(press.surface)} />
          )}
          <Button key="reload" label="Reload" hotkey="r" onPress={() => void reload()} />
          <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
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
