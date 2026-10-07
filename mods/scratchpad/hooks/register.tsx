import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput } from 'claude-code'

import type { ScratchpadNote } from '../types'

const PANE = 'scratchpad'
/** The hub's shared panel, and this mod's tab in it (order 280: among the later tabs, after Tasks). */
const HUB_PANE = 'claude-mods'
const TAB = { id: 'notes', title: 'Notes', order: 280, command: 'notes' } as const
const KEY_PREFIX = 'notes:'
const MAX_NOTES = 200
const MAX_NOTE_CHARS = 4_000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const board = atom({ plugin: 'scratchpad', key: 'board' } as const, null)
const draft = atom({ plugin: 'scratchpad', key: 'draft' } as const, '')

const isNote = (value: unknown): value is ScratchpadNote =>
  typeof value === 'object' &&
  value !== null &&
  'id' in value &&
  typeof value.id === 'string' &&
  'text' in value &&
  typeof value.text === 'string' &&
  'createdAt' in value &&
  typeof value.createdAt === 'number'

const asNotes = (value: unknown): ScratchpadNote[] => (Array.isArray(value) ? value.filter(isNote) : [])

const projectName = (root: string): string => root.split(/[\\/]/).filter(Boolean).at(-1) ?? root

const countText = (n: number): string => `${n} note${n === 1 ? '' : 's'}`

const stamp = (ms: number): string => {
  const date = new Date(ms)

  return `${date.getDate()} ${MONTHS[date.getMonth()] ?? ''} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** Reads a project's notes from the store into the board the pane draws. */
async function loadBoard($: EngineInterface, project: string): Promise<ScratchpadNote[]> {
  const notes = asNotes(await $.store.get(KEY_PREFIX + project))
  await update($, board, () => ({ project, notes }))

  return notes
}

/** Applies a change to the stored list (re-read first: another session may have written it) and shows it. */
async function changeNotes(
  $: EngineInterface,
  project: string,
  change: (notes: ScratchpadNote[]) => ScratchpadNote[],
): Promise<ScratchpadNote[]> {
  const key = KEY_PREFIX + project
  const notes = change(asNotes(await $.store.get(key))).slice(0, MAX_NOTES)

  if (notes.length === 0) await $.store.delete(key)
  else await $.store.set(key, notes)
  await update($, board, () => ({ project, notes }))

  return notes
}

async function addNote($: EngineInterface, project: string, text: string): Promise<ScratchpadNote[] | undefined> {
  const clean = text.trim().slice(0, MAX_NOTE_CHARS)
  if (clean === '') return undefined

  const note: ScratchpadNote = { id: crypto.randomUUID(), text: clean, createdAt: await $.clock.now() }

  return changeNotes($, project, notes => [note, ...notes])
}

/** Adds what the pane's field holds and empties the field. */
async function submitDraft($: EngineInterface, project: string, text: string): Promise<void> {
  await addNote($, project, text)
  await update($, draft, () => '')
}

async function sendToPrompt($: EngineInterface, text: string): Promise<void> {
  const filled = await $.prompt.fill({ text, mode: 'insert' })
  if (!filled.isFilled) $.ui.toast('The prompt box is not available right now')
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

/** With mods-hub installed: hello (this mod trades nothing on the bus), the Notes tab in its panel, and this project's notes loaded for it. */
async function greetHub($: EngineInterface): Promise<void> {
  if ((await hubMode($)) === undefined) return
  if (!(await hubHello($, { version: await ownVersion($), publishes: [], consumes: [] }, TAB))) return
  try {
    await loadBoard($, await $.session.root())
  } catch (error) {
    $.ui.log(`scratchpad: could not load the notes: ${String(error)}`, { to: 'debug' })
  }
}

/** `/notes`: the Notes tab of the hub's panel when the hub is installed, this mod's own pane otherwise. */
async function openPane($: EngineInterface): Promise<string> {
  const project = await $.session.root()
  const notes = await loadBoard($, project)
  if (!(await hubShowTab($, TAB.id))) await $.ui.open({ id: PANE, title: 'Notes', focus: true })

  return `${countText(notes.length)} for ${projectName(project)}.`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'notes', description: "Open this project's scratchpad notes in a pane" })
    await $.command.register({ name: 'note', description: "Add a note to this project's scratchpad", argumentHint: '<text>', immediate: true })
    await greetHub($)

    return next(e)
  })

  on('command.run', { command: 'notes' }, async $ => ({ text: await openPane($) }))

  on('command.run', { command: 'note' }, async ($, e) => {
    if (e.args.trim() === '') return { text: await openPane($) }

    const project = await $.session.root()
    const notes = (await addNote($, project, e.args)) ?? []

    return { text: `Noted. ${countText(notes.length)} for ${projectName(project)}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawNotes($, e, false))

  // The Notes tab: drawn beneath the hub's tab strip when it is the tab shown; any other tab passes through.
  on('ui.render', { component: 'Pane', requestId: HUB_PANE }, async ($, e, next) => {
    if (!(await hubTabIs($, TAB.id))) return next(e)
    const { Box } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {await next(e)}
        {await drawNotes($, e, true)}
      </Box>
    )
  })
}

/** The notes: this mod's own pane, or the Notes tab of the hub's panel (`isTab`: the field does not take the keyboard on its own, so the tab strip keeps its hotkeys). */
async function drawNotes($: EngineInterface, e: RenderInput<'Pane'>, isTab: boolean): Promise<RenderElement> {
  const { Box, Button, Text } = $.ui.resolve(e)
  const shown = await read($, board)

  if (shown === null) return <Text dimColor>Run /notes to load this project's notes.</Text>

  const { project, notes } = shown
  const typed = await read($, draft)
  const composer = () => {
    if (e.surface === 'mobile') return <Text dimColor>Add notes from the terminal or the desktop app.</Text>

    const { Input } = $.ui.resolve(e)

    return (
      <Input
        key="new"
        placeholder="Write a note, Enter to add"
        submitLabel="add"
        value={typed}
        {...(isTab ? {} : { autoFocus: true as const })}
        onInput={value => void update($, draft, () => value)}
        onSubmit={value => void submitDraft($, project, value)}
      />
    )
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={1}>
        <Text bold>{projectName(project)}</Text>
        <Text dimColor>{countText(notes.length)}</Text>
      </Box>
      {composer()}
      {notes.length === 0 && <Text dimColor>{'No notes yet. Type one above, or run /note <text> from the prompt.'}</Text>}
      {notes.map(note => (
        <Box key={note.id} flexDirection="column">
          <Text wrap="wrap">{note.text}</Text>
          <Box gap={1}>
            <Text dimColor>{stamp(note.createdAt)}</Text>
            <Button key={`send:${note.id}`} label="To prompt" dimColor onPress={() => void sendToPrompt($, note.text)} />
            <Button
              key={`delete:${note.id}`}
              label="Delete"
              dimColor
              onPress={() => void changeNotes($, project, list => list.filter(one => one.id !== note.id))}
            />
          </Box>
        </Box>
      ))}
    </Box>
  )
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
