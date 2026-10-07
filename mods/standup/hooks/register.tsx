import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { StandupView } from '../types'
import { defaultDays, fallbackSections, formatSections, parseLog, parseSections, sinceLabel } from './standup'
import type { Commit, Style } from './standup'

const NAME = 'standup'
const PANE = 'standup'
const GIT_TIMEOUT_MS = 15_000
const MODEL_TIMEOUT_MS = 60_000
const MODEL_MAX_TOKENS = 700
const MAX_COMMITS = 80
const MAX_DAYS = 30
const DAY_MS = 86_400_000
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

type Settings = { model: string; style: Style; allBranches: boolean }
type Activity = {
  author: string
  commits: Commit[]
  branch: string
  dirtyFiles: number
  journal: string
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

async function gather($: EngineInterface, settings: Settings, days: number, now: number): Promise<Activity | { error: string }> {
  const root = (await git($, ['rev-parse', '--show-toplevel']))?.trim()
  if (root === undefined || root === '') return { error: 'not inside a git repository.' }
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
  return { author: author !== '' ? author : 'all authors', commits: parseLog(log ?? ''), branch, dirtyFiles: changed.length, journal }
}

const promptFor = (activity: Activity, label: string, days: number): string =>
  [
    `Period: since ${label} (${plural(days, 'day', 'days')}), author ${activity.author}`,
    `Branch: ${activity.branch} · ${plural(activity.dirtyFiles, 'file', 'files')} with uncommitted changes`,
    '',
    'Commits (newest first):',
    activity.commits.length === 0 ? '(none)' : activity.commits.map(c => `${c.date}  ${c.subject}`).join('\n'),
    ...(activity.journal !== '' ? ['', 'Journal notes:', activity.journal] : []),
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
  if ('error' in activity) return set({ status: 'error', text: `${NAME}: ${activity.error}`, detail: '', days })
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
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'standup',
      description: 'Summarise what you did since your last workday, from git history, ready to paste',
      argumentHint: '[days]',
    })
    return next(e)
  })

  on('command.run', { command: 'standup' }, async ($, e) => {
    const arg = e.args.trim()
    const days = arg === '' ? defaultDays(await $.clock.now()) : Number(arg)
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
      return { text: `${NAME}: days must be a whole number from 1 to ${MAX_DAYS}, e.g. /standup 3.` }
    }
    await $.ui.open({ id: PANE, title: 'Standup', rows: 18 })
    const view = await generate($, settings, days)
    if (view.status === 'error') return { text: view.text }
    if (view.status === 'empty') return { text: `${NAME}: ${view.text}` }
    return { text: `${NAME}: ${view.detail}. Copy it from the Standup pane.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const view = await read($, viewAtom)
    if (view === null) return <Text dimColor>Run /standup to write one.</Text>
    const copy = async (surface: typeof e.surface) => {
      const copied = await $.ui.copy({ text: view.text, surface })
      $.ui.toast(copied.isCopied ? `${NAME}: copied, ready to paste` : `${NAME}: could not copy (${copied.reason})`)
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
