import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput, RenderSurface } from 'claude-code'

import { groupByDirectory, isChanged, mentionOf, nameOf, shown, touchOf, withTouch } from './files'
import { hubTabBelow, paneFailure } from './shared/render-safe'

const PANE = 'files'
/**
 * The hub's shared panel, and this mod's Files tab in it. diff-pane owns the `changes` tab: a tab id belongs to one mod
 * (the hub refuses a second owner), so this list has a tab of its own, right after Changes (order 251).
 */
const HUB_PANE = 'claude-mods'
const TAB = { id: 'files', title: 'Files', order: 251, command: 'files' } as const
const COMMAND = 'files'
const COUNT_WIDTH = 7

const files = atom({ plugin: 'files-touched', key: 'files' } as const, [])
const isChangedOnly = atom({ plugin: 'files-touched', key: 'isChangedOnly' } as const, false)

let root = ''

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    root = e.cwd
    await registerCommand($, { name: COMMAND, description: 'Show every file read, edited or created this session' })
    afterStart($, 'files-touched', () => greetHub($))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, files, () => [])
    return next(e)
  })

  // `/files`: the Files tab of the hub's panel when the hub is installed, this mod's own pane otherwise.
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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawFiles($, e, false)).catch(async ($, e, next) =>
    next.error.kind === 're-entry'
      ? next(e)
      : paneFailure($.ui.resolve(e), { title: 'files-touched', failure: next.error, below: await next(e).catch(() => null), onRetry: () => $.ui.invalidate('ui.render') }),
  )

  // The Files tab: drawn beneath the hub's tab strip when it is the tab shown; any other tab passes through.
  on('ui.render', { component: 'Pane', requestId: HUB_PANE }, async ($, e, next) => {
    if (!(await hubTabIs($, TAB.id))) return next(e)
    const { Box } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {hubTabBelow(await next(e))}
        {await drawFiles($, e, true)}
      </Box>
    )
  }).catch(async ($, e, next) =>
    next.error.kind === 're-entry'
      ? next(e)
      : paneFailure($.ui.resolve(e), { title: 'files-touched', failure: next.error, below: await next(e).catch(() => null), onRetry: () => $.ui.invalidate('ui.render') }),
  )
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

/** With mods-hub installed: hello (this mod trades nothing on the bus) and its Files tab. */
async function greetHub($: EngineInterface): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: [] }, TAB)
}

/** The files view: this mod's own pane, or the Files tab in the hub's panel (`isTab`). */
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
