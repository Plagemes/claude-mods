import { atom, read, update } from 'claude-code'
import type { CommandRunResult, EngineInterface, Register } from 'claude-code'

import type { ReplayRecords, ReplayStep, ReplayView } from '../types'
import {
  EXPORT_CAPS,
  FILTERS,
  ICONS,
  PANE_CAPS,
  applyFilter,
  buildTimeline,
  clockTime,
  entryOf,
  exportMarkdown,
  metaOf,
  promptKey,
  relative,
  scrubber,
  stamp,
} from './timeline'

type Dollar = EngineInterface
/** The full steps of the last build, by id: the pane's state keeps only the step on screen. */
type Cache = { steps: Map<string, ReplayStep> }

const PANE = 'session-replay'
const PANE_TITLE = 'Replay'
const COMMAND = 'replay'
const ARGUMENT_HINT = '[export | <step number>]'
const EXPORT_DIR = '.claude/replays'
const KEPT_TOOL_RECORDS = 3_000
const KEPT_PROMPT_RECORDS = 500
const LISTED_STEPS = 30
const SCRUBBER_MARGIN = 2
const TOOL_COLOR = 'suggestion'

const entriesState = atom({ plugin: 'session-replay', key: 'entries' } as const, [])
const currentState = atom({ plugin: 'session-replay', key: 'current' } as const, null)
const recordsState = atom({ plugin: 'session-replay', key: 'records' } as const, { tools: {}, prompts: [] })
const viewState = atom({ plugin: 'session-replay', key: 'view' } as const, { position: 0, filter: 'all', isFollowing: true })
const noticeState = atom({ plugin: 'session-replay', key: 'notice' } as const, null)

const describe = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^[\w-]+: \$\.[\w.]+: /, '')

const colorOf = (step: Pick<ReplayStep, 'kind' | 'isError'>): string =>
  step.isError === true ? 'error' : step.kind === 'prompt' ? 'claude' : step.kind === 'answer' ? 'text' : step.kind === 'edit' ? 'success' : TOOL_COLOR

// ── Building and moving through the timeline ─────────────────────────────────

async function stepsOf($: Dollar, caps: typeof PANE_CAPS): Promise<ReplayStep[]> {
  const [messages, records, root] = await Promise.all([$.session.messages(), read($, recordsState), $.session.root()])
  return buildTimeline(messages, records, root, caps)
}

/** Shows the step at `view.position` of the filtered timeline, its content from the cache. */
async function show($: Dollar, cache: Cache, view: ReplayView): Promise<void> {
  const entries = applyFilter(await read($, entriesState), view.filter)
  const last = Math.max(0, entries.length - 1)
  const position = view.isFollowing ? last : Math.min(Math.max(0, view.position), last)
  const entry = entries[position]
  await update($, viewState, () => ({ ...view, position }))
  await update($, currentState, () => (entry === undefined ? null : cache.steps.get(entry.id) ?? null))
}

/** Rebuilds the timeline from the transcript, keeping the step on screen (or the newest, when following). */
async function rebuild($: Dollar, cache: Cache): Promise<ReplayStep[]> {
  const steps = await stepsOf($, PANE_CAPS)
  const view = await read($, viewState)
  const shownId = (await read($, currentState))?.id
  cache.steps = new Map(steps.map(step => [step.id, step]))
  const entries = steps.map(entryOf)
  await update($, entriesState, () => entries)
  const found = applyFilter(entries, view.filter).findIndex(entry => entry.id === shownId)
  await show($, cache, view.isFollowing || found < 0 ? view : { ...view, position: found })

  return steps
}

async function scrollToTop($: Dollar): Promise<void> {
  try {
    await $.ui.scroll({ in: PANE, to: 'start' })
  } catch {
    // A pane that is not mounted yet has nothing to scroll.
  }
}

type Move = 'first' | 'previous' | 'next' | 'last'

async function move($: Dollar, cache: Cache, to: Move): Promise<void> {
  const view = await read($, viewState)
  const count = applyFilter(await read($, entriesState), view.filter).length
  const position = to === 'first' ? 0 : to === 'last' ? count - 1 : view.position + (to === 'next' ? 1 : -1)
  const clamped = Math.min(Math.max(0, position), Math.max(0, count - 1))
  if (cache.steps.size === 0 && count > 0) await rebuild($, cache)
  await show($, cache, { ...view, position: clamped, isFollowing: clamped === count - 1 })
  await scrollToTop($)
}

async function setFilter($: Dollar, cache: Cache, filter: string): Promise<void> {
  const view = await read($, viewState)
  const shownId = (await read($, currentState))?.id
  const entries = applyFilter(await read($, entriesState), filter)
  const kept = entries.findIndex(entry => entry.id === shownId)
  await show($, cache, { filter, position: kept < 0 ? 0 : kept, isFollowing: kept < 0 ? false : view.isFollowing })
}

async function exportReplay($: Dollar): Promise<string> {
  const steps = await stepsOf($, EXPORT_CAPS)
  if (steps.length === 0) return '✗ Nothing to export yet: the session has no prompts.'
  const now = await $.clock.now()
  const root = (await $.session.root()).replace(/[\\/]+$/, '')
  const path = `${root}/${EXPORT_DIR}/${stamp(now)}.md`
  await $.fs.write(path, exportMarkdown(steps, `Session replay, ${new Date(now).toDateString()} ${clockTime(now)}`))

  return `✓ Exported ${steps.length} steps to ${relative(path, root)}`
}

async function exportFromPane($: Dollar): Promise<void> {
  let notice: string
  try {
    notice = await exportReplay($)
  } catch (error) {
    notice = `✗ Could not export: ${describe(error)}`
  }
  await update($, noticeState, () => notice)
}

function listText(steps: readonly ReplayStep[]): string {
  if (steps.length === 0) return '▶ Nothing to replay yet: send a prompt first.'
  const shown = steps.slice(-LISTED_STEPS)
  const lines = shown.map((step, index) => {
    const number = steps.length - shown.length + index + 1
    const time = step.at === undefined ? '' : ` ${clockTime(step.at)}`
    return `${String(number).padStart(4)}${time} ${ICONS[step.kind]} ${step.title}${step.isError === true ? ' ✗' : ''}`
  })
  const more = steps.length > shown.length ? [`     …and ${steps.length - shown.length} earlier steps. /replay export writes them all.`] : []

  return [`▶ Session replay: ${steps.length} steps (the pane could not be shown here).`, ...more, ...lines].join('\n')
}

async function openReplay($: Dollar, cache: Cache, args: string): Promise<CommandRunResult> {
  const request = args.trim().toLowerCase()
  if (request === 'export') {
    try {
      return { text: await exportReplay($) }
    } catch (error) {
      return { text: `✗ Could not export: ${describe(error)}` }
    }
  }
  const number = Number(request)
  if (request !== '' && (!Number.isInteger(number) || number < 1)) return { text: `✗ Usage: /${COMMAND} ${ARGUMENT_HINT}` }

  await update($, noticeState, () => null)
  await update($, viewState, view => (request === '' ? view : { position: number - 1, filter: 'all', isFollowing: false }))
  const steps = await rebuild($, cache)
  const opened = await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true, closeOnEscape: true })
  if (!opened.isPlaced) return { text: listText(steps) }

  return { text: `▶ Replaying ${steps.length} steps.` }
}

/** Keeps the newest records within their caps. */
function trimRecords(records: ReplayRecords): ReplayRecords {
  const tools = Object.entries(records.tools)
  return {
    prompts: records.prompts.slice(-KEPT_PROMPT_RECORDS),
    tools: tools.length <= KEPT_TOOL_RECORDS ? records.tools : Object.fromEntries(tools.sort(([, a], [, b]) => a.at - b.at).slice(-KEPT_TOOL_RECORDS)),
  }
}

async function isPaneOpen($: Dollar): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(pane => pane.id === PANE)
  } catch {
    return false
  }
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export const register: Register = on => {
  const cache: Cache = { steps: new Map() }

  on('session.start', async ($, e, next) => {
    await registerCommand($, { name: 'replay', description: 'Step through this session (prompts, tool calls, edits) like a video timeline', argumentHint: ARGUMENT_HINT })

    return next(e)
  })

  on('command.run', { command: 'replay' }, async ($, e) => openReplay($, cache, e.args))

  on('prompt.submit', async ($, e, next) => {
    const at = await $.clock.now()
    await update($, recordsState, records => trimRecords({ ...records, prompts: [...records.prompts, { text: promptKey(e.text), at }] }))

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const at = await $.clock.now()
    const ran = await next(e)
    const durationMs = (await $.clock.now()) - at
    const isError = ran.deny !== undefined || ran.isError === true
    await update($, recordsState, records => trimRecords({ ...records, tools: { ...records.tools, [e.tool_use_id]: { at, durationMs, isError } } }))

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      $.clock.after(0, () => void (async () => {
        if (await isPaneOpen($)) await rebuild($, cache)
      })().catch(error => $.ui.log(`could not refresh the replay: ${describe(error)}`, { to: 'debug' })))
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Code, Markdown, Text } = $.ui.resolve(e)
    const [all, current, view, notice] = await Promise.all([read($, entriesState), read($, currentState), read($, viewState), read($, noticeState)])
    const entries = applyFilter(all, view.filter)
    const total = entries.length
    const position = Math.min(view.position, Math.max(0, total - 1))
    const absolute = current === null ? -1 : all.findIndex(entry => entry.id === current.id)
    const bar = scrubber(position, total, e.props.bodyColumns - SCRUBBER_MARGIN)

    const picker = e.surface === 'mobile' ? null : (() => {
      const { Select } = $.ui.resolve(e)
      return (
        <Select
          key="filter"
          label="Show"
          options={FILTERS.map(filter => ({ value: filter.value, label: filter.label }))}
          value={view.filter}
          onSelect={filter => setFilter($, cache, filter)}
        />
      )
    })()

    const header = (
      <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={2}>
        <Text bold color="claude">▶ Session replay</Text>
        <Text>
          {total === 0 ? 'no steps' : `Step ${position + 1} / ${total}`}
          {view.filter === 'all' || absolute < 0 ? '' : ` · #${absolute + 1} of ${all.length}`}
          {view.isFollowing && total > 0 ? ' · live' : ''}
        </Text>
      </Box>
    )

    const controls = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Button key="first" label="⏮ First" plain hotkey="f" onPress={() => move($, cache, 'first')} />
        <Button key="previous" label="◀ Prev" plain hotkey="p" onPress={() => move($, cache, 'previous')} />
        <Button key="next" label="Next ▶" plain hotkey="n" variant="primary" onPress={() => move($, cache, 'next')} />
        <Button key="last" label="Last ⏭" plain hotkey="l" onPress={() => move($, cache, 'last')} />
        {picker}
        <Button key="export" label="Export" plain hotkey="x" onPress={() => exportFromPane($)} />
        <Button key="refresh" label="Refresh" plain hotkey="r" onPress={() => rebuild($, cache)} />
        <Button key="close" label="Close" plain hotkey="q" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
      </Box>
    )

    const timeline = total === 0 ? null : (
      <Text wrap="truncate-end">
        <Text color="claude">{bar.played}</Text>
        <Text color="claude" bold>{bar.head}</Text>
        <Text dimColor>{bar.rest}</Text>
      </Text>
    )

    const body = current === null
      ? (
        <Text dimColor wrap="wrap">
          {all.length === 0 ? 'Nothing to replay yet: send a prompt first.' : 'No step matches this filter.'}
        </Text>
      )
      : (
        <Box key={`step:${current.id}`} flexDirection="column">
          <Text color={colorOf(current)} wrap="truncate-end">
            {ICONS[current.kind]} {metaOf(current)}
          </Text>
          <Text bold wrap="wrap">{current.title}</Text>
          {current.body === '' ? null
            : current.format === 'markdown' ? <Markdown text={current.body} />
            : current.format === 'diff'
              ? <Code source={current.body} format="diff" {...(current.path === undefined ? {} : { path: current.path })} />
              : <Code source={current.body} {...(current.language === undefined ? {} : { language: current.language })} {...(current.path === undefined ? {} : { path: current.path })} />}
          {current.output === undefined || current.output === '' ? null : (
            <Box flexDirection="column" marginTop={1}>
              <Text color={current.isError === true ? 'error' : 'inactive'}>{current.isError === true ? '✗ Error' : 'Output'}</Text>
              <Code source={current.output} wrap="truncate-end" />
            </Box>
          )}
        </Box>
      )

    return (
      <Box flexDirection="column">
        {header}
        {timeline}
        {controls}
        {notice === null ? null : <Text color={notice.startsWith('✗') ? 'error' : 'success'} wrap="wrap">{notice}</Text>}
        <Box flexDirection="column" marginTop={1}>{body}</Box>
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
