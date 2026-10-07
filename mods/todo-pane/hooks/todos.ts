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
