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
  await hubHello($, { version: await ownVersion($), publishes: ['lint.result'], consumes: [] })
}

/** The documented surface that changed with no doc edit, as a `lint.result` on the hub's bus (nothing happens without the hub). */
async function publishChanges($: EngineInterface, changes: readonly SurfaceChange[]): Promise<void> {
  const files = [...new Set(changes.map(change => change.file))]
  await hubPublish($, { topic: 'lint.result', data: { tool: 'readme-sync', errors: 0, warnings: changes.length, files } })
}

/** At the end of a main turn: surface changed and no doc was edited → the band asks for docs. */
async function settleTurn($: EngineInterface, tracker: Tracker): Promise<void> {
  const { changes, docsTouched } = tracker
  tracker.changes = []
  tracker.docsTouched = false
  if (docsTouched || changes.length === 0 || !(await hasDocs($))) return
  await update($, pendingAtom, pending => mergeChanges(pending, changes))
  await publishChanges($, changes)
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    apiPaths: String(options.apiPaths ?? DEFAULT_API_PATHS)
      .split(',')
      .map(prefix => prefix.trim().replace(/^\.\//, ''))
      .filter(Boolean),
  }
  const tracker: Tracker = { changes: [], docsTouched: false }

  on('session.start', async ($, e, next) => {
    await greetHub($)
    return next(e)
  })

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
    // Other plugins' bands draw beneath this one rather than being replaced by it.
    const below = await next(e)

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
        {below}
      </Box>
    )
  })
}

// #region @vendored shared/hub-client.ts sha256:d76b7319c8a3: edit the source, then run `node scripts/sync-shared.mjs`.
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

/** Routes a notification through the hub (channels, silent, night, presence), or shows a toast when there is no hub. */
async function hubNotify($: EngineInterface, input: Parameters<HubMods['notify']>[0]): Promise<void> {
  try {
    await $.mods.notify(input)
  } catch {
    $.ui.toast(input.body === undefined || input.body === '' ? input.title : `${input.title} — ${input.body}`)
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

/** Whether the shared panel shows tab `id` now; read while drawing, it subscribes the drawing. */
async function hubTabIs($: EngineInterface, id: string): Promise<boolean> {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
  return value === id
}
// #endregion @vendored shared/hub-client.ts
