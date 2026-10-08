import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, RenderElement, RenderInput } from 'claude-code'

import type { TodoPaneItem, TodoPaneStatus } from '../types'
import { fromTaskList, fromTodoWrite, progressOf, taskEvents, withCreated, withUpdated } from './todos'

const PANE = 'todos'
/** The hub's shared panel, and this mod's tab in it (order 260: after the platform's fixed tabs and the Changes tab). */
const HUB_PANE = 'claude-mods'
const TAB = { id: 'tasks', title: 'Tasks', order: 260, command: 'todos' } as const
const BAR_MAX_CELLS = 30
/** Room the progress bar leaves for its `12/12 done` label. */
const BAR_LABEL_CELLS = 12
const GLYPH: Record<TodoPaneStatus, string> = { pending: '☐', in_progress: '◐', completed: '☑' }
const GLYPH_COLOR: Record<TodoPaneStatus, string> = { pending: 'inactive', in_progress: 'warning', completed: 'success' }

const items = atom({ plugin: 'todo-pane', key: 'items' } as const, [])
const isDoneHidden = atom({ plugin: 'todo-pane', key: 'isDoneHidden' } as const, false)

const titleOf = (list: readonly TodoPaneItem[]): string => {
  const { done, total } = progressOf(list)

  return total === 0 ? 'Todos' : `Todos ${done}/${total}`
}

/** What this load knows about the hub. */
type Hub = { isHubbed: boolean }

/** Stores the new list and, while the pane is open, puts the progress in its tab; with the hub, in its Tasks tab too, and the changes on its bus. */
async function keep($: EngineInterface, hub: Hub, change: (list: TodoPaneItem[]) => TodoPaneItem[]): Promise<void> {
  const before = await read($, items)
  const list = await update($, items, change)
  const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)

  if (isOpen) await $.ui.open({ id: PANE, title: titleOf(list) })
  if (!hub.isHubbed) return
  for (const event of taskEvents(before, list)) await hubPublish($, event)
  await retitleTab($, list)
}

/** The Tasks tab's title carries the progress too (`Tasks 3/8`), as the own pane's tab does. */
async function retitleTab($: EngineInterface, list: readonly TodoPaneItem[]): Promise<void> {
  const { done, total } = progressOf(list)
  try {
    await $.mods.registerTab({ ...TAB, title: total === 0 ? TAB.title : `${TAB.title} ${done}/${total}` })
  } catch {
    // The hub went away: the own pane's title is all there is.
  }
}

/** Opens the pane unasked at the start; the engine places it only on a wide terminal, else it is closed again. */
async function openIfWide($: EngineInterface): Promise<void> {
  const opened = await $.ui.open({ id: PANE, title: titleOf(await read($, items)) })

  if (!opened.isPlaced) await $.ui.close({ id: PANE })
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

/** With mods-hub installed: hello (this mod publishes `task.started` and `task.finished`) and the Tasks tab in its panel. */
async function greetHub($: EngineInterface, hub: Hub): Promise<void> {
  if ((await hubMode($)) === undefined) return
  hub.isHubbed = await hubHello($, { version: await ownVersion($), publishes: ['task.started', 'task.finished'], consumes: [] }, TAB)
}

export const register: Register = (on, options: PluginOptions) => {
  const autoOpen = options.autoOpen !== false
  const hub: Hub = { isHubbed: false }

  on('session.start', async ($, e, next) => {
    await registerCommand($, { name: 'todos', description: "Open a pane with Claude's task list and its progress", immediate: true })
    // The hub hello and the pane wait until session.start has returned (afterStart). With the hub the list lives in
    // its Tasks tab, which the person opens: no pane of its own pops up unasked, so the pane waits for the hello's answer.
    afterStart($, 'todo-pane', async () => {
      await greetHub($, hub)
      if (!autoOpen || !e.isInteractive || hub.isHubbed) return
      try {
        await openIfWide($)
      } catch (error) {
        $.ui.log(`todo-pane: no pane at start: ${String(error)}`, { to: 'debug' })
      }
    })

    return next(e)
  })

  on('command.run', { command: 'todos' }, async $ => {
    const list = await read($, items)
    if (!(await hubShowTab($, TAB.id))) await $.ui.open({ id: PANE, title: titleOf(list) })
    const { done, total } = progressOf(list)

    return { text: total === 0 ? 'No task list yet.' : `${done} of ${total} done.` }
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)

    if (ran.deny === undefined && ran.isError !== true && e.agentId === undefined) {
      await keep($, hub, () => fromTodoWrite(e.todos))
    }

    return ran
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)

    if (ran.deny === undefined && ran.isError !== true) {
      const { id, subject } = ran.result.task
      await keep($, hub, list => withCreated(list, id, subject, e.activeForm))
    }

    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)

    if (ran.deny === undefined && ran.isError !== true && ran.result.success) {
      await keep($, hub, list => withUpdated(list, e))
    }

    return ran
  })

  on('tool.call', { tool: 'TaskList' }, async ($, e, next) => {
    const ran = await next(e)

    if (ran.deny === undefined && ran.isError !== true) {
      const { tasks } = ran.result
      await keep($, hub, list => fromTaskList(list, tasks))
    }

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawTodos($, e, false))

  // The Tasks tab: drawn beneath the hub's tab strip when it is the tab shown; any other tab passes through.
  on('ui.render', { component: 'Pane', requestId: HUB_PANE }, async ($, e, next) => {
    if (!(await hubTabIs($, TAB.id))) return next(e)
    const { Box } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {await next(e)}
        {await drawTodos($, e, true)}
      </Box>
    )
  })
}

/** The task list: this mod's own pane, or the Tasks tab of the hub's panel (`isTab`, no Close button). */
async function drawTodos($: EngineInterface, e: RenderInput<'Pane'>, isTab: boolean): Promise<RenderElement> {
  const { Box, Button, Text } = $.ui.resolve(e)
  const list = await read($, items)
  const hideDone = await read($, isDoneHidden)
  const { done, total } = progressOf(list)

  if (total === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No task list yet.</Text>
        <Text dimColor>When Claude plans a multi-step task, its todos show up here.</Text>
      </Box>
    )
  }

  const cells = Math.max(4, Math.min(BAR_MAX_CELLS, e.props.bodyColumns - BAR_LABEL_CELLS))
  const filled = Math.round((done / total) * cells)
  const shown = hideDone ? list.filter(item => item.status !== 'completed') : list

  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Box>
          <Text color="success">{'█'.repeat(filled)}</Text>
          <Text dimColor>{'░'.repeat(cells - filled)}</Text>
        </Box>
        <Text bold>{`${done}/${total} done`}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {shown.map(item => (
          <Box key={item.id} gap={1}>
            <Text color={GLYPH_COLOR[item.status]}>{GLYPH[item.status]}</Text>
            {item.status === 'in_progress' ? (
              <Text bold>{item.activeForm}</Text>
            ) : (
              <Text dimColor={item.status === 'completed'} strikethrough={item.status === 'completed'}>
                {item.content}
              </Text>
            )}
          </Box>
        ))}
        {hideDone && done > 0 && <Text dimColor>{`${done} done item${done === 1 ? '' : 's'} hidden`}</Text>}
      </Box>
      <Box gap={1} marginTop={1}>
        <Button
          key="toggle-done"
          label={hideDone ? 'Show done' : 'Hide done'}
          hotkey="h"
          onPress={() => void update($, isDoneHidden, hidden => !hidden)}
        />
        {isTab ? null : <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />}
      </Box>
    </Box>
  )
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
