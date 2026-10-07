import type { EngineInterface, PluginOptions, Register, SessionMessage, Timer } from 'claude-code'

const MOD = 'session-journal'
const DEFAULT_DIRECTORY = '.claude/journal'
const IDLE_MS = 90_000
const GIT_TIMEOUT_MS = 3_000
const PROMPTS_LISTED = 8
const FILES_LISTED = 25
const PROMPT_CHARS = 120
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/** How many of each kind of bus event an entry lists. */
const EVENTS_LISTED = 10
const SHA_CHARS = 7

const SUMMARY_PROMPT = [
  'Write a short work-journal entry for this session so far, for the developer to read tomorrow.',
  'Reply in Markdown with exactly these two sections and nothing else (no preamble, no code fence):',
  '### Work done',
  '3 to 6 concrete bullets: what was built, fixed or decided (name features, bugs and files where useful).',
  '### Open questions',
  'Bullets for unresolved issues, follow-ups or risks; write "- None" if there are none.',
].join('\n')

type Settings = { directory: string; summarizeWhenIdle: boolean; includeClear: boolean }
type Summary = { text: string; turns: number }
/** What this load knows about the conversation in progress. */
type Journal = {
  isInteractive: boolean
  branch: string | undefined
  summary: Summary | undefined
  journaledTurns: number
  idle: Timer | undefined
}
type Facts = { prompts: string[]; files: string[]; commands: number; todos: string[] }
/** What other mods reported on the hub's bus this session (all empty without the hub). */
type Reported = { commits: string[]; decisions: string[]; lessons: string[]; tests: string | undefined; usd: number | undefined }

const NOTHING_REPORTED: Reported = { commits: [], decisions: [], lessons: [], tests: undefined, usd: undefined }

function readSettings(options: PluginOptions): Settings {
  const raw = typeof options.directory === 'string' ? options.directory.trim() : ''

  return {
    directory: raw.replace(/^\.\/+/, '').replace(/\/+$/, '') || DEFAULT_DIRECTORY,
    summarizeWhenIdle: options.summarizeWhenIdle !== false,
    includeClear: options.includeClear === true,
  }
}

const two = (n: number): string => String(n).padStart(2, '0')
const dayOf = (at: Date): string => `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

function relativeTo(root: string, path: string): string {
  const prefix = `${root.replace(/[\\/]+$/, '')}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/** What the transcript itself proves: the person's requests, files edited, commands run, todos left open. */
function factsOf(messages: readonly SessionMessage[], root: string): Facts {
  const prompts: string[] = []
  const files = new Set<string>()
  let commands = 0
  let todos: string[] = []
  for (const message of messages) {
    const text = message.text.trim()
    if (message.role === 'user' && text && !message.toolResults?.length && !text.startsWith('<')) {
      const line = text.split('\n')[0] ?? ''
      prompts.push(line.length > PROMPT_CHARS ? `${line.slice(0, PROMPT_CHARS - 1)}…` : line)
    }
    for (const use of message.toolUses) {
      const path = use.input.file_path ?? use.input.notebook_path
      if (EDIT_TOOLS.has(use.tool) && typeof path === 'string' && use.isError !== true) files.add(relativeTo(root, path))
      if (use.tool === 'Bash') commands += 1
      if (use.tool === 'TodoWrite' && Array.isArray(use.input.todos)) {
        todos = use.input.todos
          .filter((todo): todo is { content: string; status: string } => typeof todo?.content === 'string')
          .filter(todo => todo.status !== 'completed')
          .map(todo => todo.content)
      }
    }
  }
  return { prompts, files: [...files], commands, todos }
}

function bullets(items: readonly string[], limit: number, format: (item: string) => string): string {
  const shown = items.slice(0, limit).map(item => `- ${format(item)}`)
  if (items.length > limit) shown.push(`- … and ${items.length - limit} more`)
  return shown.join('\n')
}

/** The summary's sections, outer code fence and preamble removed. */
function cleanSummary(text: string): string {
  const unfenced = text.trim().replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/, '$1').trim()
  const start = unfenced.search(/^#{2,4} /m)
  return (start > 0 ? unfenced.slice(start) : unfenced).trim()
}

type EntryInput = {
  at: Date
  project: string
  branch: string | undefined
  facts: Facts
  turns: number
  summary: Summary | undefined
  sessionId: string
  ending: string
  reported: Reported
}

function entryOf(input: EntryInput): string {
  const { facts, summary, reported } = input
  const where = input.branch ? `${input.project} · ${input.branch}` : input.project
  const parts = [`## ${two(input.at.getHours())}:${two(input.at.getMinutes())} · ${where}`]
  if (summary) {
    const stale = input.turns - summary.turns
    parts.push(stale > 0 ? `${summary.text}\n\n_Summary written before the last ${stale} prompt(s)._` : summary.text)
  }
  if (facts.files.length > 0) parts.push(`### Files changed\n${bullets(facts.files, FILES_LISTED, file => `\`${file}\``)}`)
  if (facts.prompts.length > 0) parts.push(`### Requests\n${bullets(facts.prompts, PROMPTS_LISTED, prompt => prompt)}`)
  if (facts.todos.length > 0) parts.push(`### Open todos\n${bullets(facts.todos, PROMPTS_LISTED, todo => `[ ] ${todo}`)}`)
  if (reported.commits.length > 0) parts.push(`### Commits\n${bullets(reported.commits, EVENTS_LISTED, commit => commit)}`)
  if (reported.decisions.length > 0) parts.push(`### Decisions\n${bullets(reported.decisions, EVENTS_LISTED, decision => decision)}`)
  if (reported.lessons.length > 0) parts.push(`### Lessons\n${bullets(reported.lessons, EVENTS_LISTED, lesson => lesson)}`)
  if (reported.tests !== undefined) parts.push(`### Last test run\n${reported.tests}`)
  const prompts = plural(input.turns, 'prompt')
  const cost = reported.usd === undefined ? '' : ` · $${reported.usd.toFixed(2)}`
  parts.push(`_${prompts} · ${plural(facts.commands, 'command')}${cost} · session ${input.sessionId.slice(0, 8)} · ${input.ending}_`)

  return `${parts.join('\n\n')}\n`
}

async function branchOf($: EngineInterface): Promise<string | undefined> {
  try {
    const out = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS })
    const branch = out.stdout.trim()
    return out.exitCode === 0 && branch && branch !== 'HEAD' ? branch : undefined
  } catch {
    return undefined
  }
}

/** Forks the conversation for a summary; undefined with the reason when there is none. */
async function summarize($: EngineInterface, turns: number): Promise<{ summary?: Summary; failure?: string }> {
  try {
    const reply = await $.model.fork({ prompt: SUMMARY_PROMPT })
    if (reply.isAnswered && reply.text.trim()) return { summary: { text: cleanSummary(reply.text), turns } }
    return { failure: reply.isAnswered ? 'empty reply' : reply.reason }
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) }
  }
}

// ── mods-hub: what other mods reported, and the entry on the bus ────────────────────────────────────

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
  await hubHello($, {
    version: await ownVersion($),
    publishes: ['x.session-journal.entry'],
    consumes: ['git.commit', 'decision.recorded', 'lesson.learned', 'test.result', 'session.ended', 'cost.update'],
  })
}

/** The payloads of this session's events of one topic, oldest first; none without the hub. */
async function eventsOf($: EngineInterface, topic: string): Promise<Record<string, unknown>[]> {
  try {
    const events = await $.mods.recent({ topic, limit: EVENTS_LISTED * 2 })
    return events.map(event => event.data).filter((data): data is Record<string, unknown> => typeof data === 'object' && data !== null && !Array.isArray(data))
  } catch {
    return []
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const firstLine = (value: unknown): string => text(value).split('\n')[0] ?? ''

/** The last test run as one line: `✓ 12 passed (vitest)`. */
function testLine(data: Record<string, unknown>): string | undefined {
  const { outcome, passed, failed, runner } = data
  if (outcome !== 'passed' && outcome !== 'failed' && outcome !== 'error') return undefined
  const counts = [typeof failed === 'number' && failed > 0 ? `${failed} failed` : '', typeof passed === 'number' ? `${passed} passed` : ''].filter(Boolean)
  const verdict = outcome === 'passed' ? '✓' : '✗'
  const said = counts.length > 0 ? counts.join(' · ') : outcome === 'error' ? 'could not run' : outcome
  return `- ${verdict} ${said}${text(runner) ? ` (${text(runner)})` : ''}`
}

/**
 * What mods-hub's bus says about this session: commits (commit-composer), decisions (decision-log), lessons
 * (lessons-learned), the last test run, and the session's cost (the hub's `session.ended` when it already
 * ran, its last `cost.update` otherwise). One quick in-process read per topic, so it fits in `session.end`.
 */
async function reportedOf($: EngineInterface): Promise<Reported> {
  if ((await hubMode($)) === undefined) return NOTHING_REPORTED
  const commits = (await eventsOf($, 'git.commit')).map(commit => `\`${text(commit.sha).slice(0, SHA_CHARS)}\` ${firstLine(commit.message)}`)
  const decisions = (await eventsOf($, 'decision.recorded')).map(decision => (text(decision.path) ? `${text(decision.title)} (\`${text(decision.path)}\`)` : text(decision.title)))
  const lessons = (await eventsOf($, 'lesson.learned')).map(lesson => text(lesson.lesson)).filter(Boolean)
  const lastTest = (await eventsOf($, 'test.result')).at(-1)
  const ended = (await eventsOf($, 'session.ended')).at(-1)?.usd
  const cost = (await eventsOf($, 'cost.update')).at(-1)?.sessionUsd
  const usd = typeof ended === 'number' ? ended : typeof cost === 'number' ? cost : undefined
  return { commits, decisions, lessons, tests: lastTest === undefined ? undefined : testLine(lastTest), usd }
}

/** A written entry on the hub's bus, for every session (handoff, project-brain, standup can point to it). */
async function publishEntry($: EngineInterface, path: string, project: string, turns: number, ending: string): Promise<void> {
  await hubPublish($, { topic: 'x.session-journal.entry', data: { path, project, turns, ending }, scope: 'global' })
}

/** Appends the entry to today's file; resolves the file's path relative to the project root. */
async function writeEntry($: EngineInterface, journal: Journal, settings: Settings, sessionId: string, ending: string): Promise<string> {
  const root = await $.session.root()
  const at = new Date(await $.clock.now())
  const turns = await $.session.turns()
  const entry = entryOf({
    at,
    project: baseName(root),
    branch: journal.branch,
    facts: factsOf(await $.session.messages(), root),
    turns,
    summary: journal.summary,
    sessionId,
    ending,
    reported: await reportedOf($),
  })
  const relative = `${settings.directory}/${dayOf(at)}.md`
  const file = `${root.replace(/[\\/]+$/, '')}/${relative}`
  const existing = await $.fs.read(file).catch(() => '')
  const head = typeof existing === 'string' && existing.trim() ? `${existing.trimEnd()}\n\n` : `# Journal · ${dayOf(at)}\n\n`
  await $.fs.write(file, `${head}${entry}`)
  journal.journaledTurns = turns
  await publishEntry($, relative, baseName(root), turns, ending)

  return relative
}

async function rememberBranch($: EngineInterface, journal: Journal): Promise<void> {
  journal.branch = (await branchOf($)) ?? journal.branch
}

async function refreshSummary($: EngineInterface, journal: Journal): Promise<void> {
  const turns = await $.session.turns()
  if (turns === 0 || journal.summary?.turns === turns) return
  await rememberBranch($, journal)
  const { summary } = await summarize($, turns)
  if (summary) journal.summary = summary
}

async function journalNow($: EngineInterface, journal: Journal, settings: Settings): Promise<string> {
  const turns = await $.session.turns()
  if (turns === 0) return `${MOD}: nothing to journal yet.`
  journal.idle?.cancel()
  await rememberBranch($, journal)
  const { summary, failure } = await summarize($, turns)
  if (summary) journal.summary = summary
  try {
    const path = await writeEntry($, journal, settings, await $.session.id(), 'written with /journal')
    return failure ? `📓 ${MOD}: added an entry to ${path} (no summary: ${failure}).` : `📓 ${MOD}: added an entry to ${path}.`
  } catch (error) {
    return `${MOD}: could not write the journal: ${error instanceof Error ? error.message : String(error)}`
  }
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)
  const journal: Journal = { isInteractive: true, branch: undefined, summary: undefined, journaledTurns: 0, idle: undefined }

  on('session.start', async ($, e, next) => {
    journal.isInteractive = e.isInteractive
    await $.command.register({ name: 'journal', description: 'Write a journal entry for this session now' })
    $.clock.after(0, () => void rememberBranch($, journal))
    await greetHub($)

    return next(e)
  })

  on('command.run', { command: 'journal' }, async $ => ({ text: await journalNow($, journal, settings) }))

  on('prompt.submit', ($, e, next) => {
    journal.idle?.cancel()
    journal.idle = undefined

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (settings.summarizeWhenIdle && journal.isInteractive && e.agentId === undefined && e.reason !== 'aborted') {
      journal.idle?.cancel()
      journal.idle = $.clock.after(IDLE_MS, () => void refreshSummary($, journal))
    }

    return result
  })

  on('session.end', async ($, e, next) => {
    journal.idle?.cancel()
    const isWanted = journal.isInteractive && (e.reason !== 'clear' || settings.includeClear)
    try {
      if (isWanted && (await $.session.turns()) > journal.journaledTurns) {
        await writeEntry($, journal, settings, e.sessionId, `ended: ${e.reason}`)
      }
    } catch {
      // Exiting must stay fast and quiet; an entry that cannot be written is skipped.
    }
    if (e.reason === 'clear') {
      journal.summary = undefined
      journal.journaledTurns = 0
    }

    return next(e)
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
