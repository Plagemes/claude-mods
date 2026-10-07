import type { TodoPaneItem, TodoPaneStatus } from '../types'

type Draft = { content: string; status: TodoPaneStatus; activeForm?: string }

/** The list TodoWrite sends, whole: it replaces the one before. */
export const fromTodoWrite = (todos: readonly Draft[]): TodoPaneItem[] =>
  todos.map((todo, i) => ({ id: `todo-${i + 1}`, content: todo.content, activeForm: todo.activeForm ?? todo.content, status: todo.status }))

/** A task TaskCreate made, added at the end. */
export const withCreated = (items: readonly TodoPaneItem[], id: string, subject: string, activeForm?: string): TodoPaneItem[] => [
  ...items.filter(item => item.id !== id),
  { id, content: subject, activeForm: activeForm ?? subject, status: 'pending' },
]

export type TaskChange = { taskId: string; subject?: string; activeForm?: string; status?: TodoPaneStatus | 'deleted' }

/** TaskUpdate's change to one task; `deleted` removes it. */
export const withUpdated = (items: readonly TodoPaneItem[], change: TaskChange): TodoPaneItem[] => {
  const { taskId, subject, activeForm, status } = change
  if (status === 'deleted') return items.filter(item => item.id !== taskId)

  const nextStatus: TodoPaneStatus | undefined = status

  return items.map(item =>
    item.id === taskId
      ? { ...item, content: subject ?? item.content, activeForm: activeForm ?? subject ?? item.activeForm, status: nextStatus ?? item.status }
      : item,
  )
}

/** TaskList's answer is the whole list; the progress phrasing known so far is kept. */
export const fromTaskList = (
  items: readonly TodoPaneItem[],
  tasks: readonly { id: string; subject: string; status: TodoPaneStatus }[],
): TodoPaneItem[] =>
  tasks.map(task => ({
    id: task.id,
    content: task.subject,
    activeForm: items.find(item => item.id === task.id)?.activeForm ?? task.subject,
    status: task.status,
  }))

export const progressOf = (items: readonly TodoPaneItem[]): { done: number; total: number } => ({
  done: items.filter(item => item.status === 'completed').length,
  total: items.length,
})

/** What the bus is told about a list that changed: `task.started` for an item that turned in progress, `task.finished` for one that was completed or removed while open. */
export type TaskEvent =
  | { topic: 'task.started'; data: { id: string; title: string } }
  | { topic: 'task.finished'; data: { id: string; title: string; outcome: 'ok' | 'cancelled' } }

const TITLE_LIMIT = 200

/** TodoWrite numbers items by position, so a rewritten list moves them: those are known by their text, task-tool items by their id. */
const keyOf = (item: TodoPaneItem): string => (item.id.startsWith('todo-') ? `text:${item.content}` : `id:${item.id}`)

export const taskEvents = (before: readonly TodoPaneItem[], after: readonly TodoPaneItem[]): TaskEvent[] => {
  const was = new Map(before.map(item => [keyOf(item), item]))
  const now = new Set(after.map(keyOf))
  const events: TaskEvent[] = []

  for (const item of after) {
    const old = was.get(keyOf(item))
    const title = (item.status === 'in_progress' ? item.activeForm : item.content).slice(0, TITLE_LIMIT)
    // An item the mod has not seen before only announces that it started; a completed one it never saw open is not news.
    if (item.status === 'in_progress' && old?.status !== 'in_progress') events.push({ topic: 'task.started', data: { id: item.id, title } })
    else if (item.status === 'completed' && old !== undefined && old.status !== 'completed') events.push({ topic: 'task.finished', data: { id: item.id, title, outcome: 'ok' } })
  }
  for (const old of before) {
    if (!now.has(keyOf(old)) && old.status === 'in_progress') {
      events.push({ topic: 'task.finished', data: { id: old.id, title: old.content.slice(0, TITLE_LIMIT), outcome: 'cancelled' } })
    }
  }
  return events
}
