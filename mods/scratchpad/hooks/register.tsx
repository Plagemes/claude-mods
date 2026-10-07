import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ScratchpadNote } from '../types'

const NAME = 'scratchpad'
const PANE = 'scratchpad'
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
  if (!filled.isFilled) $.ui.toast(`${NAME}: the prompt box is not available right now`)
}

async function openPane($: EngineInterface): Promise<string> {
  const project = await $.session.root()
  const notes = await loadBoard($, project)
  await $.ui.open({ id: PANE, title: 'Notes', focus: true })

  return `${NAME}: ${countText(notes.length)} for ${projectName(project)}.`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'notes', description: "Open this project's scratchpad notes in a pane" })
    await $.command.register({ name: 'note', description: "Add a note to this project's scratchpad", argumentHint: '<text>', immediate: true })

    return next(e)
  })

  on('command.run', { command: 'notes' }, async $ => ({ text: await openPane($) }))

  on('command.run', { command: 'note' }, async ($, e) => {
    if (e.args.trim() === '') return { text: await openPane($) }

    const project = await $.session.root()
    const notes = (await addNote($, project, e.args)) ?? []

    return { text: `${NAME}: noted. ${countText(notes.length)} for ${projectName(project)}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
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
          autoFocus
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
  })
}
