import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { describeChange, diffSurface, isCodePath, isDocPath, mergeChanges, summarize, surfaceOf } from './detect'
import type { Surface, SurfaceChange } from './detect'

const NAME = 'readme-sync'
const DEFAULT_API_PATHS = 'src/,lib/'
const LINES_SHOWN = 3
const PROMPT_ITEMS = 25
const DOCS_ENTRY = /^(readme(\.[a-z]+)?|docs?|documentation)$/i

/** Removals break readers first, then additions; signature changes last. */
const PRIORITY = { removed: 0, added: 1, changed: 2 } as const

const pendingAtom = atom({ plugin: 'readme-sync', key: 'pending' } as const, [])

type Settings = { apiPaths: string[] }
/** What the running turn did so far: surface changes, and whether any doc was edited. */
type Tracker = { changes: SurfaceChange[]; docsTouched: boolean }

const relativeTo = (root: string, path: string): string | undefined =>
  path.startsWith(`${root}/`) ? path.slice(root.length + 1) : undefined

const updatePrompt = (changes: readonly SurfaceChange[]): string => {
  const items = changes.slice(0, PROMPT_ITEMS).map(change => `- ${change.change} ${describeChange(change).slice(2)}`)
  const more = changes.length > PROMPT_ITEMS ? [`- …and ${changes.length - PROMPT_ITEMS} more`] : []
  return [
    'These changes touched documented surface, but no docs were updated:',
    ...items,
    ...more,
    '',
    'Please update the README and any docs that describe them (usage examples, CLI options, environment variables) so they match the code. Change only documentation.',
  ].join('\n')
}

async function surfaceOnDisk($: EngineInterface, path: string, file: string, watchExports: boolean): Promise<Surface> {
  try {
    if (!(await $.fs.exists(path))) return new Map()
    return surfaceOf(file, await $.fs.read(path), watchExports)
  } catch {
    return new Map()
  }
}

async function hasDocs($: EngineInterface): Promise<boolean> {
  try {
    const entries = await $.fs.list(await $.session.root())
    return entries.some(entry => DOCS_ENTRY.test(entry.name))
  } catch {
    return false
  }
}

/** At the end of a main turn: surface changed and no doc was edited → the band asks for docs. */
async function settleTurn($: EngineInterface, tracker: Tracker): Promise<void> {
  const { changes, docsTouched } = tracker
  tracker.changes = []
  tracker.docsTouched = false
  if (docsTouched || changes.length === 0 || !(await hasDocs($))) return
  await update($, pendingAtom, pending => mergeChanges(pending, changes))
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    apiPaths: String(options.apiPaths ?? DEFAULT_API_PATHS)
      .split(',')
      .map(prefix => prefix.trim().replace(/^\.\//, ''))
      .filter(Boolean),
  }
  const tracker: Tracker = { changes: [], docsTouched: false }

  on('turn.start', async ($, e, next) => {
    tracker.changes = []
    tracker.docsTouched = false
    return next(e)
  })

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const file = relativeTo(await $.session.root(), e.file_path)
    if (file === undefined || (!isDocPath(file) && !isCodePath(file))) return next(e)
    if (isDocPath(file)) {
      const ran = await next(e)
      if (ran.deny === undefined && ran.isError !== true) {
        tracker.docsTouched = true
        await update($, pendingAtom, () => [])
      }
      return ran
    }
    const watchExports = settings.apiPaths.some(prefix => file.startsWith(prefix))
    const before = await surfaceOnDisk($, e.file_path, file, watchExports)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const changes = diffSurface(file, before, await surfaceOnDisk($, e.file_path, file, watchExports))
    if (changes.length > 0) tracker.changes = mergeChanges(tracker.changes, changes)
    return ran
  }).catch(($, e, next) => next(e)) // after `next`, this replays its answer: the edit never runs twice

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await settleTurn($, tracker)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.isWorking || e.props.view.agentId !== undefined) return next(e)
    const pending = await read($, pendingAtom)
    if (pending.length === 0) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const shown = [...pending].sort((a, b) => PRIORITY[a.change] - PRIORITY[b.change]).slice(0, LINES_SHOWN)
    const askClaude = async () => {
      await update($, pendingAtom, () => [])
      await $.prompt.submit({ text: updatePrompt(pending), asUser: true })
    }

    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Text color="warning" bold>⚠ {NAME}</Text>
          <Text wrap="truncate-end">{`docs untouched after ${summarize(pending)} changed`}</Text>
        </Box>
        {shown.map(change => (
          <Text dimColor wrap="truncate-end">{`  ${describeChange(change)}`}</Text>
        ))}
        {pending.length > shown.length && <Text dimColor>{`  … ${pending.length - shown.length} more`}</Text>}
        <Box gap={1}>
          <Button key="update" label="Ask Claude to update docs" hotkey="u" variant="primary" onPress={() => void askClaude()} />
          <Button key="dismiss" label="Dismiss" hotkey="d" role="dismiss" onPress={() => void update($, pendingAtom, () => [])} />
        </Box>
      </Box>
    )
  })
}
