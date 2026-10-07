import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DataMapView } from '../types'
import { SYSTEM_PROMPT, buildPrompt, classifyGrepOutput, countHits, documentOf, evidenceOf, extractTable, fallbackTable, gitGrepArgs, grepArgs } from './signals'
import type { Hit } from './signals'

type Settings = { model: string; output: string }
/** What the last scan found, kept for saving the document. */
type Memory = { isBusy: boolean; root: string; hits: Hit[] }
type Surface = Parameters<EngineInterface['ui']['copy']>[0]['surface']

const PANE = 'data-map'
const DEFAULT_MODEL = 'sonnet'
const DEFAULT_OUTPUT = 'docs/data-map.md'
const SCAN_TIMEOUT_MS = 60_000
const MODEL_TIMEOUT_MS = 120_000
const MAX_TOKENS = 4_000
const EMPTY_COUNTS = { hits: 0, files: 0, items: 0, stores: 0, thirdParties: 0 }
const EMPTY: DataMapView = { phase: 'idle', project: '', markdown: '', isFallback: false, counts: EMPTY_COUNTS, savedTo: null, message: '' }

const view = atom({ plugin: 'data-map', key: 'view' } as const, EMPTY)

async function projectRoot($: EngineInterface): Promise<{ root: string; isGit: boolean }> {
  try {
    const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { timeoutMs: 10_000 })
    if (top.exitCode === 0 && top.stdout.trim() !== '') return { root: top.stdout.trim(), isGit: true }
  } catch {
    // No git: grep the session's folder instead.
  }
  return { root: await $.session.cwd(), isGit: false }
}

/** Lines that mention personal data, stores or third parties: git grep in a repository, grep -r elsewhere. Exit 1 is "no match". */
async function search($: EngineInterface, root: string, isGit: boolean): Promise<string> {
  const argv = isGit ? ['git', ...gitGrepArgs()] : grepArgs()
  const ran = await $.process.run(argv, { cwd: root, timeoutMs: SCAN_TIMEOUT_MS })
  if (ran.exitCode > 1) throw new Error(ran.stderr.trim().split('\n')[0] || `${argv[0]} failed`)
  return ran.stdout
}

async function organise($: EngineInterface, settings: Settings, project: string, hits: readonly Hit[]): Promise<{ markdown: string; isFallback: boolean }> {
  const reply = await $.model.complete({
    model: settings.model,
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(project, evidenceOf(hits)),
    maxTokens: MAX_TOKENS,
    timeoutMs: MODEL_TIMEOUT_MS,
  })
  const table = reply.isAnswered ? extractTable(reply.text) : undefined
  return table === undefined ? { markdown: fallbackTable(hits), isFallback: true } : { markdown: table, isFallback: false }
}

async function scan($: EngineInterface, settings: Settings, memory: Memory): Promise<void> {
  try {
    const { root, isGit } = await projectRoot($)
    const project = root.slice(root.lastIndexOf('/') + 1) || root
    memory.root = root
    await update($, view, (): DataMapView => ({ ...EMPTY, phase: 'scanning', project }))
    let hits: Hit[]
    try {
      hits = classifyGrepOutput(await search($, root, isGit))
    } catch (error) {
      await update($, view, (current): DataMapView => ({ ...current, phase: 'error', message: `The search failed: ${error instanceof Error ? error.message : String(error)}` }))
      return
    }
    memory.hits = hits
    const counts = countHits(hits)
    if (counts.items === 0) {
      const message = 'No personal-data fields found: nothing named email, name, phone, address, birth date, IP, location, cookies, payment or ID in the code.'
      await update($, view, (current): DataMapView => ({ ...current, phase: 'done', counts, message }))
      return
    }
    await update($, view, (current): DataMapView => ({ ...current, phase: 'organising', counts }))
    const { markdown, isFallback } = await organise($, settings, project, hits)
    await update($, view, (current): DataMapView => ({ ...current, phase: 'done', markdown, isFallback, counts, message: '' }))
    $.ui.toast(`Data map ready: ${counts.items} kinds of personal data, ${counts.thirdParties} third parties (/data-map)`)
  } finally {
    memory.isBusy = false
  }
}

async function startScan($: EngineInterface, settings: Settings, memory: Memory): Promise<string> {
  if (memory.isBusy) return 'Already scanning; the Data map pane fills in when done.'
  memory.isBusy = true
  await update($, view, (current): DataMapView => ({ ...current, phase: 'scanning', savedTo: null }))
  await $.ui.open({ id: PANE, title: 'Data map' }).catch(() => undefined)
  $.clock.after(0, () => void scan($, settings, memory))
  return 'Scanning the code for personal data…'
}

async function save($: EngineInterface, settings: Settings, memory: Memory): Promise<void> {
  const current = await read($, view)
  if (current.markdown === '') return
  const date = new Date(await $.clock.now()).toISOString().slice(0, 10)
  const path = `${memory.root}/${settings.output}`
  try {
    await $.fs.write(path, documentOf(current.project, date, current.markdown, memory.hits, current.isFallback))
    await update($, view, (latest): DataMapView => ({ ...latest, savedTo: settings.output }))
    $.ui.toast(`Saved ${settings.output}`)
  } catch (error) {
    $.ui.toast(`Could not save ${settings.output}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function copyTable($: EngineInterface, surface: Surface): Promise<void> {
  const { markdown } = await read($, view)
  const copied = await $.ui.copy({ text: markdown, surface })
  $.ui.toast(copied.isCopied ? 'Copied the table.' : `Could not copy (${copied.reason}).`)
}

async function pressRescan($: EngineInterface, settings: Settings, memory: Memory): Promise<void> {
  const said = await startScan($, settings, memory)
  if (said.startsWith('Already')) $.ui.toast(said)
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    model: typeof options.model === 'string' && options.model.trim() !== '' ? options.model.trim() : DEFAULT_MODEL,
    output: typeof options.output === 'string' && options.output.trim() !== '' ? options.output.trim().replace(/^\.?\/+/, '') : DEFAULT_OUTPUT,
  }
  const memory: Memory = { isBusy: false, root: '', hits: [] }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'data-map', description: 'Where the code collects, stores and sends personal data (a GDPR head start)' })
    return next(e)
  })

  on('command.run', { command: 'data-map' }, async $ => ({ text: await startScan($, settings, memory) }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const current = await read($, view)
    const close = <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
    const { counts } = current

    if (current.phase === 'idle' || current.phase === 'scanning' || current.phase === 'organising') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold color="suggestion">
            {current.phase === 'idle' ? 'No data map yet' : current.phase === 'scanning' ? '⧗ Scanning the code…' : '⧗ Organising what was found…'}
          </Text>
          <Text dimColor>
            {current.phase === 'organising'
              ? `${counts.hits} matches in ${counts.files} files; ${settings.model} is turning them into a table.`
              : 'Looks for personal data fields, where they are stored, and which third parties receive them.'}
          </Text>
          {close}
        </Box>
      )
    }
    if (current.phase === 'error' || current.markdown === '') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold color={current.phase === 'error' ? 'error' : 'success'}>
            {current.phase === 'error' ? '✗' : '✓'} {current.message}
          </Text>
          <Box key="actions" flexDirection="row" gap={1}>
            <Button key="rescan" label="Rescan" hotkey="r" onPress={() => void pressRescan($, settings, memory)} />
            {close}
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box key="header" flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" gap={2}>
            <Text bold>🗺 Personal data map · {current.project}</Text>
            {current.savedTo !== null && <Text color="success">✓ {current.savedTo}</Text>}
          </Box>
          <Text dimColor wrap="truncate-end">
            {counts.items} kinds of personal data · {counts.stores} stores · {counts.thirdParties} third parties · {counts.hits} matches in {counts.files} files
          </Text>
          {current.isFallback && <Text color="warning">The model did not answer: this table comes from the keyword scan alone.</Text>}
        </Box>
        <Markdown key="table" text={current.markdown} />
        <Text dimColor>A head start for a GDPR record of processing, not legal advice: check every row.</Text>
        <Box key="actions" flexDirection="row" gap={1}>
          <Button key="save" label={`Save to ${settings.output}`} hotkey="s" variant="primary" onPress={() => void save($, settings, memory)} />
          <Button key="copy" label="Copy" hotkey="c" onPress={press => void copyTable($, press.surface)} />
          <Button key="rescan" label="Rescan" hotkey="r" onPress={() => void pressRescan($, settings, memory)} />
          {close}
        </Box>
      </Box>
    )
  })
}
