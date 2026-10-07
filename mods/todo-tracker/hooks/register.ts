import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TodoTrackerItem } from '../types'
import { lineAt } from './shared/line-index'

const tracker = atom({ plugin: 'todo-tracker', key: 'tracker' } as const, { turn: 0, items: [] })

const MARKER = /\b(TODO|FIXME|HACK|XXX)\b/
const MAX_ITEMS = 200
const MAX_TEXT_CHARS = 100
/** How many of a turn's markers go into the hub event (its payload is capped). */
const MAX_PUBLISHED = 20

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

  return content === undefined || index === -1 ? null : lineAt(content, index)
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
  await hubHello($, { version: await ownVersion($), publishes: ['x.todo-tracker.added'], consumes: [] })
}

/**
 * The turn's markers as a notification through mods-hub when it is installed (a toast otherwise), and as
 * `x.todo-tracker.added` with the first few of them for whoever listens.
 */
async function report($: EngineInterface, turn: number, added: readonly TodoTrackerItem[]): Promise<void> {
  await hubNotify($, {
    level: 'info',
    title: `${added.length} marker${added.length === 1 ? '' : 's'} added this turn (${summary(added)}). /todos-added lists them`,
  })
  await hubPublish($, {
    topic: 'x.todo-tracker.added',
    data: { turn, count: added.length, items: added.slice(0, MAX_PUBLISHED).map(({ file, line, marker, text }) => ({ file, line, marker, text })) },
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await greetHub($)
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
        await report($, turn, added)
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
