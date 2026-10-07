import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PromptHistoryEntry, PromptHistoryView } from '../types'
import { MAX_TEXT_CHARS, asEntries, search, withEntry } from './history'

const NAME = 'prompt-history'
const PANE = 'prompt-history'
const STORE_KEY = 'prompts'
const MAX_RESULTS = 30
/** The prompts a person typed, at the terminal or through Remote Control. */
const PERSON_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge'])
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const view = atom({ plugin: 'prompt-history', key: 'view' } as const, null)

/** The stored list, read once per module and kept in step with what this module writes. */
type Cache = { entries: PromptHistoryEntry[] | undefined }

const projectName = (root: string): string => root.split(/[\\/]/).filter(Boolean).at(-1) ?? root

const stamp = (ms: number): string => {
  const date = new Date(ms)

  return `${date.getDate()} ${MONTHS[date.getMonth()] ?? ''} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

const firstLine = (text: string): string => {
  const [line = ''] = text.trim().split('\n')

  return line === text.trim() ? line : `${line} …`
}

async function entriesOf($: EngineInterface, cache: Cache): Promise<PromptHistoryEntry[]> {
  cache.entries ??= asEntries(await $.store.get(STORE_KEY))

  return cache.entries
}

/** Adds a prompt to the front of the stored history, re-reading it first: other sessions write it too. */
async function remember($: EngineInterface, cache: Cache, text: string): Promise<void> {
  const entry: PromptHistoryEntry = {
    text: text.slice(0, MAX_TEXT_CHARS),
    at: await $.clock.now(),
    project: await $.session.root(),
    ...(text.length > MAX_TEXT_CHARS ? { isCut: true as const } : {}),
  }
  const entries = withEntry(asEntries(await $.store.get(STORE_KEY)), entry)

  await $.store.set(STORE_KEY, entries)
  cache.entries = entries
}

/** Runs the search and puts its newest matches in the view the pane draws. */
async function show(
  $: EngineInterface,
  cache: Cache,
  query: string,
  scope: PromptHistoryView['scope'],
  project: string,
): Promise<PromptHistoryView> {
  const entries = await entriesOf($, cache)
  const matches = search(entries, query, scope === 'project' ? project : undefined)
  const shown = { query, scope, project, results: matches.slice(0, MAX_RESULTS), matched: matches.length, total: entries.length }
  await update($, view, () => shown)

  return shown
}

/** The search again with the current view's other settings; used by the pane's field and toggle. */
async function refine($: EngineInterface, cache: Cache, change: Partial<Pick<PromptHistoryView, 'query' | 'scope'>>): Promise<void> {
  const current = await read($, view)
  const project = current?.project ?? (await $.session.root())

  await show($, cache, change.query ?? current?.query ?? '', change.scope ?? current?.scope ?? 'all', project)
}

/** Puts an old prompt in the prompt box for editing or sending, and hands the keyboard back. */
async function reuse($: EngineInterface, text: string): Promise<void> {
  const filled = await $.prompt.fill({ text })

  if (filled.isFilled) await $.ui.close({ id: PANE })
  else $.ui.toast(`${NAME}: the prompt box is not available right now`)
}

export const register: Register = on => {
  const cache: Cache = { entries: undefined }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'history',
      description: 'Search every prompt you have sent, across sessions and projects, and reuse one',
      argumentHint: '[search words | clear]',
    })

    return next(e)
  })

  on('command.run', { command: 'history' }, async ($, e) => {
    const query = e.args.trim()

    if (query.toLowerCase() === 'clear') {
      await $.store.delete(STORE_KEY)
      cache.entries = []
      await update($, view, shown => (shown === null ? null : { ...shown, results: [], matched: 0, total: 0 }))
      return { text: `${NAME}: history cleared.` }
    }

    const shown = await show($, cache, query, 'all', await $.session.root())
    await $.ui.open({ id: PANE, title: 'History', focus: true })

    return {
      text: query === '' ? `${NAME}: ${shown.total} prompts kept.` : `${NAME}: ${shown.matched} of ${shown.total} prompts match "${query}".`,
    }
  })

  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)

    if (entered.drop === undefined && PERSON_ORIGINS.has(e.origin.kind) && entered.text.trim() !== '') {
      try {
        await remember($, cache, entered.text)
      } catch (error) {
        $.ui.log(`${NAME}: could not keep this prompt: ${String(error)}`, { to: 'debug' })
      }
    }

    return entered
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const shown = await read($, view)

    if (shown === null) return <Text dimColor>Run /history to search your prompts.</Text>

    const { query, scope, project, results, matched, total } = shown
    const field = () => {
      if (e.surface === 'mobile') return query === '' ? null : <Text dimColor>{`Search: ${query}`}</Text>

      const { Input } = $.ui.resolve(e)

      return (
        <Input
          key="search"
          placeholder="Search prompts"
          submitLabel="search"
          value={query}
          autoFocus
          onInput={value => void refine($, cache, { query: value })}
          onSubmit={value => void refine($, cache, { query: value })}
        />
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {field()}
        <Box gap={1}>
          <Text dimColor>
            {`${matched} of ${total} prompts${scope === 'project' ? ` in ${projectName(project)}` : ''}${matched > results.length ? ` · newest ${results.length} shown` : ''}`}
          </Text>
          <Button
            key="scope"
            label={scope === 'project' ? 'All projects' : 'This project'}
            dimColor
            onPress={() => void refine($, cache, { scope: scope === 'project' ? 'all' : 'project' })}
          />
        </Box>
        {total === 0 && <Text dimColor>Nothing kept yet: every prompt you send from now on is.</Text>}
        {total > 0 && matched === 0 && <Text dimColor>No prompt holds every word of that search.</Text>}
        {results.map(entry => (
          <Box key={`entry:${entry.at}`} flexDirection="column">
            <Text wrap="truncate-end">{firstLine(entry.text)}</Text>
            <Box gap={1}>
              <Text dimColor>{`${projectName(entry.project)} · ${stamp(entry.at)}${entry.isCut ? ' · cut' : ''}`}</Text>
              <Button key={`use:${entry.at}`} label="Use" onPress={() => void reuse($, entry.text)} />
            </Box>
          </Box>
        ))}
      </Box>
    )
  })
}
