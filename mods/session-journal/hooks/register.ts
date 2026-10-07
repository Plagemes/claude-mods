import type { EngineInterface, PluginOptions, Register, SessionMessage, Timer } from 'claude-code'

const MOD = 'session-journal'
const DEFAULT_DIRECTORY = '.claude/journal'
const IDLE_MS = 90_000
const GIT_TIMEOUT_MS = 3_000
const PROMPTS_LISTED = 8
const FILES_LISTED = 25
const PROMPT_CHARS = 120
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

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
}

function entryOf(input: EntryInput): string {
  const { facts, summary } = input
  const where = input.branch ? `${input.project} · ${input.branch}` : input.project
  const parts = [`## ${two(input.at.getHours())}:${two(input.at.getMinutes())} · ${where}`]
  if (summary) {
    const stale = input.turns - summary.turns
    parts.push(stale > 0 ? `${summary.text}\n\n_Summary written before the last ${stale} prompt(s)._` : summary.text)
  }
  if (facts.files.length > 0) parts.push(`### Files changed\n${bullets(facts.files, FILES_LISTED, file => `\`${file}\``)}`)
  if (facts.prompts.length > 0) parts.push(`### Requests\n${bullets(facts.prompts, PROMPTS_LISTED, prompt => prompt)}`)
  if (facts.todos.length > 0) parts.push(`### Open todos\n${bullets(facts.todos, PROMPTS_LISTED, todo => `[ ] ${todo}`)}`)
  const prompts = plural(input.turns, 'prompt')
  parts.push(`_${prompts} · ${plural(facts.commands, 'command')} · session ${input.sessionId.slice(0, 8)} · ${input.ending}_`)

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
  })
  const relative = `${settings.directory}/${dayOf(at)}.md`
  const file = `${root.replace(/[\\/]+$/, '')}/${relative}`
  const existing = await $.fs.read(file).catch(() => '')
  const head = typeof existing === 'string' && existing.trim() ? `${existing.trimEnd()}\n\n` : `# Journal · ${dayOf(at)}\n\n`
  await $.fs.write(file, `${head}${entry}`)
  journal.journaledTurns = turns

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
