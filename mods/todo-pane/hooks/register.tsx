import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { TodoPaneItem, TodoPaneStatus } from '../types'
import { fromTaskList, fromTodoWrite, progressOf, withCreated, withUpdated } from './todos'

const PANE = 'todos'
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

/** Stores the new list and, while the pane is open, puts the progress in its tab. */
async function keep($: EngineInterface, change: (list: TodoPaneItem[]) => TodoPaneItem[]): Promise<void> {
  const list = await update($, items, change)
  const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)

  if (isOpen) await $.ui.open({ id: PANE, title: titleOf(list) })
}

/** Opens the pane unasked at the start; the engine places it only on a wide terminal, else it is closed again. */
async function openIfWide($: EngineInterface): Promise<void> {
  const opened = await $.ui.open({ id: PANE, title: titleOf(await read($, items)) })

  if (!opened.isPlaced) await $.ui.close({ id: PANE })
}

export const register: Register = (on, options: PluginOptions) => {
  const autoOpen = options.autoOpen !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'todos', description: "Open a pane with Claude's task list and its progress", immediate: true })

    if (autoOpen && e.isInteractive) {
      try {
        await openIfWide($)
      } catch (error) {
        $.ui.log(`todo-pane: no pane at start: ${String(error)}`, { to: 'debug' })
      }
    }

    return next(e)
  })

  on('command.run', { command: 'todos' }, async $ => {
    const list = await read($, items)
    await $.ui.open({ id: PANE, title: titleOf(list) })
    const { done, total } = progressOf(list)

    return { text: total === 0 ? 'No task list yet.' : `${done} of ${total} done.` }
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)

    if (ran.deny === undefined && ran.isError !== true && e.agentId === undefined) {
      await keep($, () => fromTodoWrite(e.todos))
    }

    return ran
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)

    if (ran.deny === undefined && ran.isError !== true) {
      const { id, subject } = ran.result.task
      await keep($, list => withCreated(list, id, subject, e.activeForm))
    }

    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)

    if (ran.deny === undefined && ran.isError !== true && ran.result.success) {
      await keep($, list => withUpdated(list, e))
    }

    return ran
  })

  on('tool.call', { tool: 'TaskList' }, async ($, e, next) => {
    const ran = await next(e)

    if (ran.deny === undefined && ran.isError !== true) {
      const { tasks } = ran.result
      await keep($, list => fromTaskList(list, tasks))
    }

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
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
          <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}
