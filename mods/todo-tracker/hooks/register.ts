import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TodoTrackerItem } from '../types'

const tracker = atom({ plugin: 'todo-tracker', key: 'tracker' } as const, { turn: 0, items: [] })

const MARKER = /\b(TODO|FIXME|HACK|XXX)\b/
const MAX_ITEMS = 200
const MAX_TEXT_CHARS = 100

/** Text a tool call takes out of a file and puts in; `isFile` when `after` is the whole new file. */
type Change = { before: string; after: string; isFile: boolean }
type Candidate = { marker: string; text: string; offset: number }

/** Marker lines of `after` that `before` does not already hold (each line of `before` excuses one copy). */
const addedMarkerLines = (before: string, after: string): Candidate[] => {
  const known = new Map<string, number>()
  for (const line of before.split('\n')) {
    known.set(line.trim(), (known.get(line.trim()) ?? 0) + 1)
  }

  const added: Candidate[] = []
  after.split('\n').forEach((line, offset) => {
    const marker = MARKER.exec(line)?.[1]
    const text = line.trim()
    const copies = known.get(text) ?? 0

    if (marker === undefined) {
      return
    }
    if (copies > 0) {
      known.set(text, copies - 1)
      return
    }
    added.push({ marker, text: text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS - 1)}…` : text, offset })
  })

  return added
}

const relativeTo = (root: string, path: string): string => {
  const prefix = root.endsWith('/') ? root : `${root}/`

  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

const readText = async ($: EngineInterface, path: string): Promise<string | undefined> => {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

const rootOf = async ($: EngineInterface): Promise<string> => {
  try {
    return await $.session.root()
  } catch {
    return ''
  }
}

/** The changes a file-writing call is about to make that mention a marker; the old file is read before it is overwritten. */
const plannedChanges = async (
  $: EngineInterface,
  tool: string,
  input: Readonly<Record<string, unknown>>,
  path: string,
): Promise<Change[]> => {
  if (tool === 'Write') {
    const after = String(input.content ?? '')

    return MARKER.test(after) ? [{ before: (await readText($, path)) ?? '', after, isFile: true }] : []
  }

  const edits: readonly unknown[] = tool === 'MultiEdit' && Array.isArray(input.edits) ? input.edits : [input]

  return edits.flatMap(edit => {
    const fields: Record<string, unknown> = typeof edit === 'object' && edit !== null ? { ...edit } : {}
    const after = String(fields.new_string ?? '')

    return MARKER.test(after) ? [{ before: String(fields.old_string ?? ''), after, isFile: false }] : []
  })
}

/** The 1-based line a change starts at in the file as it now is; null when the text cannot be found. */
const startLine = (content: string | undefined, { after, isFile }: Change): number | null => {
  if (isFile) {
    return 1
  }

  const index = content?.indexOf(after) ?? -1

  return content === undefined || index === -1 ? null : content.slice(0, index).split('\n').length
}

const itemsOf = async (
  $: EngineInterface,
  path: string,
  changes: readonly Change[],
  turn: number,
): Promise<TodoTrackerItem[]> => {
  const file = relativeTo(await rootOf($), path)
  const content = changes.every(change => change.isFile) ? undefined : await readText($, path)

  return changes.flatMap(change => {
    const start = startLine(content, change)

    return addedMarkerLines(change.before, change.after).map(({ marker, text, offset }) => ({
      turn,
      file,
      line: start === null ? null : start + offset,
      marker,
      text,
    }))
  })
}

/** `existing` with `items` added; an item replaces an earlier one of the same turn, file and text (its line moved). */
const merged = (existing: readonly TodoTrackerItem[], items: readonly TodoTrackerItem[]): TodoTrackerItem[] => {
  const isReplaced = (old: TodoTrackerItem): boolean =>
    items.some(item => item.turn === old.turn && item.file === old.file && item.text === old.text)

  return [...existing.filter(old => !isReplaced(old)), ...items].slice(-MAX_ITEMS)
}

const listLine = ({ file, line, text }: TodoTrackerItem): string =>
  `  ${file}${line === null ? '' : `:${line}`}  ${text}`

const summary = (items: readonly TodoTrackerItem[]): string => {
  const counts = new Map<string, number>()
  for (const { marker } of items) {
    counts.set(marker, (counts.get(marker) ?? 0) + 1)
  }

  return [...counts].map(([marker, n]) => `${n} ${marker}`).join(', ')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'todos-added',
      description: 'List the TODO/FIXME/HACK/XXX markers Claude added in its last turn',
      argumentHint: '[all]',
    })

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await update($, tracker, state => ({ ...state, turn: state.turn + 1 }))

    return next(e)
  })

  on('tool.call', { tool: /^(?:Edit|Write|MultiEdit)$/ }, async ($, e, next) => {
    const path = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : undefined

    if (path === undefined) {
      return next(e)
    }

    const planned = await plannedChanges($, String(e.tool), e, path)
    const ran = await next(e)

    if (planned.length > 0 && ran.deny === undefined && ran.isError !== true) {
      const { turn } = await read($, tracker)
      const items = await itemsOf($, path, planned, turn)

      await update($, tracker, state => ({ ...state, items: merged(state.items, items) }))
    }

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const { turn, items } = await read($, tracker)
      const added = items.filter(item => item.turn === turn)

      if (added.length > 0) {
        $.ui.toast(
          `${added.length} marker${added.length === 1 ? '' : 's'} added this turn (${summary(added)}). /todos-added lists them`,
        )
      }
    }

    return next(e)
  })

  on('command.run', { command: 'todos-added' }, async ($, e) => {
    const { items } = await read($, tracker)
    const latest = Math.max(0, ...items.map(item => item.turn))
    const isAll = e.args.trim().toLowerCase() === 'all'
    const shown = isAll ? items : items.filter(item => item.turn === latest)

    if (shown.length === 0) {
      return { text: 'No TODO, FIXME, HACK or XXX markers have been added in this session.' }
    }

    const heading = isAll
      ? `Markers added this session (${shown.length}):`
      : `Markers added in the latest turn that added any (${shown.length}):`

    return { text: [heading, ...shown.map(listLine)].join('\n') }
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, tracker, () => ({ turn: 0, items: [] }))
    }

    return next(e)
  })
}
