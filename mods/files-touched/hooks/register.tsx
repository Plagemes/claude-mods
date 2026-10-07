import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput, RenderSurface } from 'claude-code'

import { groupByDirectory, isChanged, mentionOf, nameOf, shown, touchOf, withTouch } from './files'

const PANE = 'files'
/**
 * The hub's shared panel, and the Changes tab in it: diff-pane's changed-files list and this mod's files-read-and-edited
 * list share it (whichever of the two registers it first owns it; both draw into it). Order 250, after the fixed tabs.
 */
const HUB_PANE = 'claude-mods'
const TAB = { id: 'changes', title: 'Changes', order: 250, command: 'files' } as const
const COMMAND = 'files'
const COUNT_WIDTH = 7

const files = atom({ plugin: 'files-touched', key: 'files' } as const, [])
const isChangedOnly = atom({ plugin: 'files-touched', key: 'isChangedOnly' } as const, false)

let root = ''

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    root = e.cwd
    await $.command.register({ name: COMMAND, description: 'Show every file read, edited or created this session' })
    await greetHub($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, files, () => [])
    return next(e)
  })

  // `/files`: the Changes tab of the hub's panel when the hub is installed, this mod's own pane otherwise.
  on('command.run', { command: COMMAND }, async $ => {
    if (!(await hubShowTab($, TAB.id))) await $.ui.open({ id: PANE, title: 'Files' })
    return {}
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const touch = touchOf(e, ran)
    if (touch === undefined) return ran

    if (root === '') root = await $.session.cwd().catch(() => '')
    const at = await $.clock.now()
    await update($, files, list => {
      const existing = list.find(entry => entry.path === touch.path)
      const touched = withTouch(existing, touch.path, touch.kind, at)
      return existing === undefined ? [...list, touched] : list.map(entry => (entry === existing ? touched : entry))
    })
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawFiles($, e, false))

  // The Changes tab: drawn beneath the hub's tab strip when it is the tab shown; any other tab passes through.
  on('ui.render', { component: 'Pane', requestId: HUB_PANE }, async ($, e, next) => {
    if (!(await hubTabIs($, TAB.id))) return next(e)
    const { Box } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {await next(e)}
        {await drawFiles($, e, true)}
      </Box>
    )
  })
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

/** With mods-hub installed: hello (this mod trades nothing on the bus) and its half of the Changes tab. */
async function greetHub($: EngineInterface): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: [] }, TAB)
}

/** The files view: this mod's own pane, or its section of the Changes tab in the hub's panel (`isTab`). */
async function drawFiles($: EngineInterface, e: RenderInput<'Pane'>, isTab: boolean): Promise<RenderElement> {
  const { Box, Button, Text } = $.ui.resolve(e)
  const all = await read($, files)
  const changedOnly = await read($, isChangedOnly)
  const listed = changedOnly ? all.filter(isChanged) : all
  const count = (pick: (entry: (typeof all)[number]) => number) => all.filter(entry => pick(entry) > 0).length

  return (
    <Box flexDirection="column">
      {isTab && <Text bold>Files this session</Text>}
      <Box flexDirection="row" justifyContent="space-between" marginBottom={1} gap={1}>
        <Box flexDirection="row" gap={2}>
          <Text bold>
            {all.length} {all.length === 1 ? 'file' : 'files'}
          </Text>
          <Text dimColor>{count(entry => entry.reads)} read</Text>
          <Text color="warning">{count(entry => entry.edits)} edited</Text>
          <Text color="success">{count(entry => entry.creates)} created</Text>
        </Box>
        <Button
          key="filter"
          label={changedOnly ? 'Show all' : 'Changed only'}
          hotkey="e"
          onPress={() => void update($, isChangedOnly, value => !value)}
        />
      </Box>
      {listed.length === 0 && <Text dimColor>{changedOnly ? 'No files changed yet.' : 'No files touched yet.'}</Text>}
      {groupByDirectory(listed, root).map(group => (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="suggestion">
            {group.dir}
          </Text>
          {group.files.map(file => (
            <Box flexDirection="row" gap={1}>
              <Box flexGrow={1} flexShrink={1}>
                <Text wrap="truncate-middle">
                  {'  '}
                  {nameOf(file.path)}
                </Text>
              </Box>
              <Text color="success">{(file.creates > 0 ? 'new' : '').padStart(COUNT_WIDTH)}</Text>
              <Text color="warning">{(file.edits > 0 ? `${file.edits} edit` : '').padStart(COUNT_WIDTH)}</Text>
              <Text dimColor>{(file.reads > 0 ? `${file.reads} read` : '').padStart(COUNT_WIDTH)}</Text>
              <Button key={`copy:${file.path}`} label="copy" plain dimColor onPress={press => void copyPath($, file.path, press.surface)} />
              <Button key={`mention:${file.path}`} label="@" plain dimColor onPress={() => void mention($, file.path)} />
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  )
}

/** Puts the file's absolute path on the clipboard of the surface the press came from. */
const copyPath = async ($: EngineInterface, path: string, surface: RenderSurface): Promise<void> => {
  const copied = await $.ui.copy({ text: path, surface }).catch(() => undefined)
  if (copied?.isCopied === true) $.ui.toast(`Copied ${shown(path, root)}`)
  else $.ui.toast(`Could not copy the path${copied === undefined ? '' : ` (${copied.reason})`}`)
}

/** Inserts `@path` at the cursor in the prompt box. */
const mention = async ($: EngineInterface, path: string): Promise<void> => {
  const filled = await $.prompt.fill({ text: `${mentionOf(path, root)} `, mode: 'insert' }).catch(() => undefined)
  if (filled?.isFilled !== true) $.ui.toast('The prompt box is not available right now')
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
