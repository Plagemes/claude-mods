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

const viewAtom = atom({ plugin: 'changelog-keeper', key: 'view' } as const, null)

type Settings = ParseOptions & { path: string; createIfMissing: boolean; includeHash: boolean }
type Commit = { short: string; subject: string; body: string; committedAt: number }

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
  $.ui.toast(`${NAME}: ${entry.section} · ${entry.text}`)
  return `${NAME} added "- ${entry.text}" under ## [Unreleased] › ### ${entry.section} in ${settings.path}${exists ? '' : ' (new file)'}; the change is not committed yet.`
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    path: String(options.path ?? '').trim() || 'CHANGELOG.md',
    createIfMissing: options.createIfMissing !== false,
    includeHash: options.includeHash === true,
    includeChores: options.includeChores === true,
    untyped: options.untyped === 'skip' ? 'skip' : 'changed',
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'changelog', description: "Show the Unreleased section of CHANGELOG.md" })
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!COMMIT_COMMAND.test(e.command)) return next(e)
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
    if (view.status === 'no-repo') return { text: `${NAME}: not inside a git repository.` }
    await $.ui.open({ id: PANE, title: 'Unreleased', rows: 18 })
    if (view.status === 'missing') return { text: `${NAME}: no ${view.path} yet; it starts with your next feat/fix commit.` }
    if (view.status === 'no-unreleased') return { text: `${NAME}: ${view.path} has no ## [Unreleased] section yet.` }
    return { text: `${NAME}: ${view.entries} unreleased ${view.entries === 1 ? 'entry' : 'entries'} in ${view.path}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const view = await read($, viewAtom)
    const copy = async (surface: typeof e.surface) => {
      if (view === null) return
      const copied = await $.ui.copy({ text: view.unreleased, surface })
      $.ui.toast(copied.isCopied ? `${NAME}: Unreleased copied` : `${NAME}: could not copy (${copied.reason})`)
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
