/** What kind of moment a step of the replay is. */
export type ReplayKind = 'prompt' | 'answer' | 'command' | 'edit' | 'read' | 'search' | 'agent' | 'web' | 'todo' | 'tool'

/** One step of the timeline: a prompt, an answer, or one tool call with its outcome. */
export type ReplayStep = {
  /** Stable across rebuilds: the tool_use_id, or the message's place for text. */
  id: string
  kind: ReplayKind
  /** One line: the prompt's opening, `$ npm test`, `Edit src/app.ts`. */
  title: string
  /** The content: Markdown for text, code for commands and files, a unified diff for edits. */
  body: string
  format: 'markdown' | 'code' | 'diff'
  /** A highlighter language for `code`, when the path does not say. */
  language?: string
  /** The file a code or diff body belongs to. */
  path?: string
  /** What the tool answered, as the model read it. */
  output?: string
  isError?: boolean
  /** When it happened (milliseconds since the epoch), when this session saw it. */
  at?: number
  durationMs?: number
}

/** A step as the scrubber, the counter and the filter need it: no content. */
export type ReplayEntry = Pick<ReplayStep, 'id' | 'kind' | 'title' | 'at' | 'isError'>

/** What the replay recorded itself: when each tool call ran and how long it took, and when prompts came. */
export type ReplayRecords = {
  tools: Record<string, { at: number; durationMs: number; isError: boolean }>
  prompts: { text: string; at: number }[]
}

/** Where the pane stands: the step shown (its place in the filtered list), the filter, and whether it follows the newest step. */
export type ReplayView = { position: number; filter: string; isFollowing: boolean }

declare module 'claude-code' {
  interface PluginState {
    'session-replay': {
      entries: ReplayEntry[]
      current: ReplayStep | null
      records: ReplayRecords
      view: ReplayView
      notice: string | null
    }
  }
}
