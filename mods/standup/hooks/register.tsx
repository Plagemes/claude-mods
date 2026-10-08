import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { StandupView } from '../types'
import { defaultDays, fallbackSections, formatSections, neighboursOf, parseLog, parseSections, sinceLabel, unseenCommits } from './standup'
import type { Commit, Neighbours, Style } from './standup'

const PANE = 'standup'
const GIT_TIMEOUT_MS = 15_000
const MODEL_TIMEOUT_MS = 60_000
const MODEL_MAX_TOKENS = 700
const MAX_COMMITS = 80
const MAX_DAYS = 30
const DAY_MS = 86_400_000
/** mods-hub's heartbeat file: one entry per live session, with its last global events. */
const HUB_SESSIONS = '.claude/claude-mods/hub/sessions.json'
const JOURNAL_DIR = '.claude/journal'
const JOURNAL_FILE = /^(\d{4}-\d{2}-\d{2}).*\.md$/
const JOURNAL_CHARS = 2_500
const JOURNAL_TOTAL = 6_000
const STYLES: readonly Style[] = ['plain', 'markdown', 'slack']

const SYSTEM = [
  'You write daily standup updates for a software engineer from their real git activity and notes.',
  'Be concrete and brief: 2-5 bullets per section, each under 15 words, grouped by theme rather than one per commit,',
  'in plain words a teammate understands (no hashes, no conventional-commit prefixes). Never invent work.',
  'Today continues the unfinished work the activity suggests. When nothing suggests a blocker, answer None.',
].join(' ')

const viewAtom = atom({ plugin: 'standup', key: 'view' } as const, null)

type Settings = { model: string; style: Style; allBranches: boolean; isHubbed: boolean }
type Activity = {
  author: string
  commits: Commit[]
  branch: string
  dirtyFiles: number
  journal: string
  /** Other sessions of this project and their commits, from the hub; none without it. */
  neighbours: Neighbours
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

const isoDay = (ms: number): string => {
  const date = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

async function git($: EngineInterface, args: readonly string[], cwd?: string): Promise<string | undefined> {
  try {
    const run = await $.process.run(['git', ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS })
    return run.exitCode === 0 ? run.stdout : undefined
  } catch {
    return undefined
  }
}

async function readJournal($: EngineInterface, root: string, since: string): Promise<string> {
  try {
    const entries = await $.fs.list(`${root}/${JOURNAL_DIR}`)
    const days = entries
      .filter(entry => entry.kind === 'file' && (JOURNAL_FILE.exec(entry.name)?.[1] ?? '') >= since)
      .map(entry => entry.name)
      .sort()
    let journal = ''
    for (const name of days) {
      if (journal.length >= JOURNAL_TOTAL) break
      const text = await $.fs.read(`${root}/${JOURNAL_DIR}/${name}`)
      journal += `### ${name}\n${text.trim().slice(0, JOURNAL_CHARS)}\n\n`
    }
    return journal.slice(0, JOURNAL_TOTAL).trim()
  } catch {
    return '' // No journal: git history alone.
  }
}

/** The other Claude sessions on this project, from the hub's sessions.json (their commits may be on branches this log does not reach); nothing without the hub. */
async function readNeighbours($: EngineInterface, root: string, sinceMs: number): Promise<Neighbours> {
  const none: Neighbours = { commits: [], sessions: 0, turns: 0, usd: 0 }
  try {
    const home = await $.env.get('HOME')
    if (home === undefined || home === '') return none
    const raw: unknown = JSON.parse(await $.fs.read(`${home}/${HUB_SESSIONS}`))
    return neighboursOf(raw, root, await $.session.id(), sinceMs, isoDay)
  } catch {
    return none
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

/** With mods-hub installed: hello (this mod reads `git.commit` and the other sessions' heartbeats in sessions.json). */
async function greetHub($: EngineInterface, settings: Settings): Promise<void> {
  if ((await hubMode($)) === undefined) return
  settings.isHubbed = await hubHello($, { version: await ownVersion($), publishes: [], consumes: ['git.commit', 'session.ended'] })
}

async function gather($: EngineInterface, settings: Settings, days: number, now: number): Promise<Activity | { error: string }> {
  const root = (await git($, ['rev-parse', '--show-toplevel']))?.trim()
  if (root === undefined || root === '') return { error: 'Not inside a git repository.' }
  const email = (await git($, ['config', 'user.email'], root))?.trim() ?? ''
  const author = email !== '' ? email : (await git($, ['config', 'user.name'], root))?.trim() ?? ''
  const log = await git(
    $,
    [
      'log',
      ...(settings.allBranches ? ['--all'] : []),
      '--no-merges',
      `--since=${days} days ago midnight`,
      '--date=short',
      '--format=%ad%x09%h%x09%s',
      `--max-count=${MAX_COMMITS}`,
      ...(author !== '' ? ['--fixed-strings', `--author=${author}`] : []),
    ],
    root,
  )
  const status = (await git($, ['status', '--porcelain=v1', '--branch'], root)) ?? ''
  const [head = '', ...changed] = status.split('\n').filter(line => line.trim() !== '')
  const branch = /^## (?:No commits yet on )?([^.\s]+)/.exec(head)?.[1] ?? 'the current branch'
  const journal = await readJournal($, root, isoDay(now - days * DAY_MS))
  const neighbours = settings.isHubbed ? await readNeighbours($, root, now - days * DAY_MS) : { commits: [], sessions: 0, turns: 0, usd: 0 }
  const listed = parseLog(log ?? '')
  const extra = unseenCommits(listed, neighbours.commits)
  // The log is newest first; commits other sessions made slot in by their day.
  const commits = extra.length === 0 ? listed : [...listed, ...extra].sort((a, b) => b.date.localeCompare(a.date))
  return { author: author !== '' ? author : 'all authors', commits, branch, dirtyFiles: changed.length, journal, neighbours }
}

const promptFor = (activity: Activity, label: string, days: number): string =>
  [
    `Period: since ${label} (${plural(days, 'day', 'days')}), author ${activity.author}`,
    `Branch: ${activity.branch} · ${plural(activity.dirtyFiles, 'file', 'files')} with uncommitted changes`,
    '',
    'Commits (newest first):',
    activity.commits.length === 0 ? '(none)' : activity.commits.map(c => `${c.date}  ${c.subject}`).join('\n'),
    ...(activity.journal !== '' ? ['', 'Journal notes:', activity.journal] : []),
    ...(activity.neighbours.sessions > 0
      ? ['', `Other Claude sessions on this project right now: ${activity.neighbours.sessions} (${activity.neighbours.turns} turns, $${activity.neighbours.usd.toFixed(2)} so far).`]
      : []),
    '',
    'Answer with exactly these three headings, each followed by "- " bullets, and nothing else:',
    'YESTERDAY:',
    'TODAY:',
    'BLOCKERS:',
  ].join('\n')

async function generate($: EngineInterface, settings: Settings, days: number): Promise<StandupView> {
  const now = await $.clock.now()
  const label = sinceLabel(now, days)
  const set = async (view: StandupView): Promise<StandupView> => {
    await update($, viewAtom, () => view)
    return view
  }
  await set({ status: 'working', text: '', detail: `Reading your git history since ${label}…`, days })
  const activity = await gather($, settings, days, now)
  if ('error' in activity) return set({ status: 'error', text: activity.error, detail: '', days })
  if (activity.commits.length === 0 && activity.journal === '' && activity.dirtyFiles === 0) {
    return set({
      status: 'empty',
      text: `Nothing to report: no commits by ${activity.author} and no journal notes since ${label}.`,
      detail: 'Try a longer window, e.g. /standup 7.',
      days,
    })
  }
  const answer = await $.model
    .complete({ model: settings.model, system: SYSTEM, prompt: promptFor(activity, label, days), maxTokens: MODEL_MAX_TOKENS, timeoutMs: MODEL_TIMEOUT_MS })
    .catch(() => undefined)
  const sections = answer?.isAnswered === true ? parseSections(answer.text) : undefined
  const why =
    answer === undefined ? 'the model was not available'
      : !answer.isAnswered ? `the model answered ${answer.reason}`
        : 'the reply was not in standup shape'
  const source = sections === undefined ? `listed from git (${why})` : `written by ${settings.model}`
  const found = `${plural(activity.commits.length, 'commit', 'commits')}${activity.journal !== '' ? ' + journal' : ''} since ${label}`
  return set({
    status: 'ready',
    text: formatSections(sections ?? fallbackSections(activity.commits, activity.branch, activity.dirtyFiles), settings.style),
    detail: `${found} · ${source}`,
    days,
  })
}

export const register: Register = (on, options) => {
  const style = String(options.style ?? 'plain')
  const settings: Settings = {
    model: String(options.model ?? '').trim() || 'haiku',
    style: STYLES.find(known => known === style) ?? 'plain',
    allBranches: options.allBranches !== false,
    isHubbed: false,
  }

  on('session.start', async ($, e, next) => {
    await registerCommand($, {
      name: 'standup',
      description: 'Summarise what you did since your last workday, from git history, ready to paste',
      argumentHint: '[days]',
    })
    afterStart($, 'standup', () => greetHub($, settings))
    return next(e)
  })

  on('command.run', { command: 'standup' }, async ($, e) => {
    const arg = e.args.trim()
    const days = arg === '' ? defaultDays(await $.clock.now()) : Number(arg)
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
      return { text: `Days must be a whole number from 1 to ${MAX_DAYS}, e.g. /standup 3.` }
    }
    await $.ui.open({ id: PANE, title: 'Standup', rows: 18 })
    const view = await generate($, settings, days)
    if (view.status === 'error' || view.status === 'empty') return { text: view.text }
    return { text: `${view.detail}. Copy it from the Standup pane.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const view = await read($, viewAtom)
    if (view === null) return <Text dimColor>Run /standup to write one.</Text>
    const copy = async (surface: typeof e.surface) => {
      const copied = await $.ui.copy({ text: view.text, surface })
      $.ui.toast(copied.isCopied ? 'Copied, ready to paste' : `Could not copy (${copied.reason})`)
    }
    const lines = view.text.split('\n')

    return (
      <Box flexDirection="column" gap={1}>
        {view.status === 'working' && <Text color="suggestion">Writing your standup…</Text>}
        {view.status === 'ready' ? (
          <Box flexDirection="column">
            {lines.map(line =>
              line === '' ? <Text> </Text> : /^[-•]\s/.test(line) ? <Text>{`  ${line}`}</Text> : <Text bold>{line}</Text>,
            )}
          </Box>
        ) : (
          view.status === 'error' ? <Text color="error">{view.text}</Text> : view.text !== '' && <Text>{view.text}</Text>
        )}
        {view.detail !== '' && <Text dimColor wrap="truncate-end">{view.detail}</Text>}
        <Box gap={1}>
          {view.status === 'ready' && (
            <Button key="copy" label="Copy" hotkey="c" variant="primary" onPress={press => void copy(press.surface)} />
          )}
          {view.status !== 'working' && (
            <Button key="regenerate" label="Regenerate" hotkey="r" onPress={() => void generate($, settings, view.days)} />
          )}
          <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
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
