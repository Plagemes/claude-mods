export type TodoPaneStatus = 'pending' | 'in_progress' | 'completed'

/** One item of Claude's task list, from TodoWrite or the Task tools. */
export type TodoPaneItem = { id: string; content: string; activeForm: string; status: TodoPaneStatus }

declare module 'claude-code' {
  interface PluginState {
    'todo-pane': {
      items: TodoPaneItem[]
      /** True when the pane leaves completed items out. */
      isDoneHidden: boolean
    }
  }
}
