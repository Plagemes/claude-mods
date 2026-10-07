import type { SessionMessage, ToolUseSummary } from 'claude-code'

import type { ReplayEntry, ReplayKind, ReplayRecords, ReplayStep } from '../types'

/** The cap on one step's content and output as the pane keeps them; an export keeps more. */
export type Caps = { body: number; output: number }
export const PANE_CAPS: Caps = { body: 8_000, output: 4_000 }
export const EXPORT_CAPS: Caps = { body: 40_000, output: 20_000 }

export const FILTERS = [
  { value: 'all', label: 'Everything' },
  { value: 'prompts', label: 'Prompts' },
  { value: 'answers', label: 'Answers' },
  { value: 'tools', label: 'Tool calls' },
  { value: 'commands', label: 'Commands' },
  { value: 'edits', label: 'Edits' },
  { value: 'errors', label: 'Errors' },
] as const

export const ICONS: Record<ReplayKind, string> = {
  prompt: '💬',
  answer: '✦',
  command: '$',
  edit: '✎',
  read: '📖',
  search: '🔍',
  agent: '🤝',
  web: '🌐',
  todo: '☑',
  tool: '⚙',
}

export const KIND_NAMES: Record<ReplayKind, string> = {
  prompt: 'Prompt',
  answer: 'Answer',
  command: 'Command',
  edit: 'Edit',
  read: 'Read',
  search: 'Search',
  agent: 'Subagent',
  web: 'Web',
  todo: 'Todos',
  tool: 'Tool',
}

const TITLE_CHARS = 100
const KEPT_PROMPT_CHARS = 200

const firstLine = (text: string): string => {
  const line = (text.trim().split('\n')[0] ?? '').replace(/\s+/g, ' ')
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** `text` cut to `max` characters: its head and tail, with how much was left out between. */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value
  const head = value.slice(0, Math.floor(max * 0.6))
  const tail = value.slice(value.length - Math.floor(max * 0.35))
  return `${head}\n… ${value.length - head.length - tail.length} characters left out …\n${tail}`
}

/** The key a prompt's text is matched to its recorded time by. */
export const promptKey = (value: string): string => value.trim().slice(0, KEPT_PROMPT_CHARS)

/** `path` relative to `root` when inside it. */
export function relative(path: string, root: string): string {
  const prefix = `${root.replace(/[\\/]+$/, '')}/`
  return root !== '' && path.startsWith(prefix) ? path.slice(prefix.length) : path
}

const lines = (value: string): string[] => (value === '' ? [] : value.split('\n'))

/** A unified-diff hunk turning `before` into `after`; the file's own line numbers are unknown, so it starts at 1. */
export function diffOf(before: string, after: string): string {
  const removed = lines(before)
  const added = lines(after)
  return [`@@ -1,${removed.length} +1,${added.length} @@`, ...removed.map(line => `-${line}`), ...added.map(line => `+${line}`)].join('\n')
}

function toolStep(use: ToolUseSummary, root: string, caps: Caps): ReplayStep {
  const input = use.input
  const path = text(input.file_path) || text(input.notebook_path) || text(input.path)
  const shown = path === '' ? '' : relative(path, root)
  const base = { id: use.tool_use_id, ...(use.text === undefined ? {} : { output: clip(use.text, caps.output) }), ...(use.isError === true ? { isError: true } : {}) }
  switch (use.tool) {
    case 'Bash':
      return { ...base, kind: 'command', title: `$ ${firstLine(text(input.command))}`, body: clip(text(input.command), caps.body), format: 'code', language: 'bash' }
    case 'Edit':
      return { ...base, kind: 'edit', title: `Edit ${shown}`, body: clip(diffOf(text(input.old_string), text(input.new_string)), caps.body), format: 'diff', path }
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? input.edits : []
      const hunks = edits.map(edit => diffOf(text((edit as Record<string, unknown>)?.old_string), text((edit as Record<string, unknown>)?.new_string)))
      return { ...base, kind: 'edit', title: `Edit ${shown} (${edits.length} changes)`, body: clip(hunks.join('\n'), caps.body), format: 'diff', path }
    }
    case 'Write':
      return { ...base, kind: 'edit', title: `Write ${shown}`, body: clip(text(input.content), caps.body), format: 'code', path }
    case 'NotebookEdit':
      return { ...base, kind: 'edit', title: `Edit notebook ${shown}`, body: clip(text(input.new_source), caps.body), format: 'code', language: 'python', path }
    case 'Read': {
      const range = typeof input.offset === 'number' ? ` from line ${input.offset}` : ''
      return { ...base, kind: 'read', title: `Read ${shown}${range}`, body: '', format: 'code', path }
    }
    case 'Grep':
    case 'Glob':
      return { ...base, kind: 'search', title: `${use.tool} ${firstLine(text(input.pattern))}${shown === '' ? '' : ` in ${shown}`}`, body: '', format: 'code' }
    case 'Agent':
    case 'Task':
      return { ...base, kind: 'agent', title: `Subagent: ${firstLine(text(input.description) || text(input.subagent_type))}`, body: clip(text(input.prompt), caps.body), format: 'markdown' }
    case 'WebFetch':
      return { ...base, kind: 'web', title: `Fetch ${firstLine(text(input.url))}`, body: clip(text(input.prompt), caps.body), format: 'markdown' }
    case 'WebSearch':
      return { ...base, kind: 'web', title: `Search the web: ${firstLine(text(input.query))}`, body: '', format: 'markdown' }
    case 'TodoWrite': {
      const todos = (Array.isArray(input.todos) ? input.todos : []).map(todo => todo as Record<string, unknown>)
      const done = todos.filter(todo => todo.status === 'completed').length
      const list = todos.map(todo => `- [${todo.status === 'completed' ? 'x' : ' '}] ${text(todo.content)}${todo.status === 'in_progress' ? ' *(in progress)*' : ''}`)
      return { ...base, kind: 'todo', title: `Todos: ${done}/${todos.length} done`, body: list.join('\n'), format: 'markdown' }
    }
    default:
      return { ...base, kind: 'tool', title: use.tool, body: clip(JSON.stringify(input, null, 2), caps.body), format: 'code', language: 'json' }
  }
}

/** A user message the person typed: text, no tool results, not a reminder or command wrapper the engine wrote. */
const isTypedPrompt = (message: SessionMessage): boolean =>
  message.role === 'user' && message.text.trim() !== '' && (message.toolResults?.length ?? 0) === 0 && !message.text.trimStart().startsWith('<')

/**
 * The session as steps: each prompt, each answer's text and each tool call
 * with its input and outcome, stamped with the times and durations this mod
 * recorded (a prompt by its text, in order; a tool call by its id).
 */
export function buildTimeline(messages: readonly SessionMessage[], records: ReplayRecords, root: string, caps: Caps = PANE_CAPS): ReplayStep[] {
  const steps: ReplayStep[] = []
  const prompts = records.prompts.map(prompt => ({ ...prompt, isUsed: false }))
  messages.forEach((message, index) => {
    if (isTypedPrompt(message)) {
      const key = promptKey(message.text)
      const recorded = prompts.find(prompt => !prompt.isUsed && prompt.text === key)
      if (recorded !== undefined) recorded.isUsed = true
      steps.push({
        id: `prompt:${index}`,
        kind: 'prompt',
        title: firstLine(message.text),
        body: clip(message.text.trim(), caps.body),
        format: 'markdown',
        ...(recorded === undefined ? {} : { at: recorded.at }),
      })
    }
    if (message.role !== 'assistant') return
    if (message.text.trim() !== '') {
      steps.push({ id: `answer:${index}`, kind: 'answer', title: firstLine(message.text), body: clip(message.text.trim(), caps.body), format: 'markdown' })
    }
    for (const use of message.toolUses) {
      const step = toolStep(use, root, caps)
      const record = records.tools[use.tool_use_id]
      const durationMs = record?.durationMs ?? use.durationMs
      steps.push({
        ...step,
        ...(record === undefined ? {} : { at: record.at }),
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(record?.isError === true ? { isError: true } : {}),
      })
    }
  })

  return steps
}

/** The steps (or entries) a filter keeps, in timeline order. */
export function applyFilter<T extends Pick<ReplayStep, 'kind' | 'isError'>>(steps: readonly T[], filter: string): T[] {
  switch (filter) {
    case 'prompts':
      return steps.filter(step => step.kind === 'prompt')
    case 'answers':
      return steps.filter(step => step.kind === 'answer')
    case 'tools':
      return steps.filter(step => step.kind !== 'prompt' && step.kind !== 'answer')
    case 'commands':
      return steps.filter(step => step.kind === 'command')
    case 'edits':
      return steps.filter(step => step.kind === 'edit')
    case 'errors':
      return steps.filter(step => step.isError === true)
    default:
      return [...steps]
  }
}

/** A step without its content, for the scrubber and the filter. */
export const entryOf = (step: ReplayStep): ReplayEntry => ({
  id: step.id,
  kind: step.kind,
  title: step.title,
  ...(step.at === undefined ? {} : { at: step.at }),
  ...(step.isError === true ? { isError: true } : {}),
})

const pad = (value: number): string => String(value).padStart(2, '0')

/** `14:03:21`, local time. */
export function clockTime(ms: number): string {
  const date = new Date(ms)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** `2026-10-07-140321`, local time: an export's file name. */
export function stamp(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** `850 ms`, `2.3 s`, `4 min 05 s`. */
export function duration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)} min ${pad(Math.round((ms % 60_000) / 1_000))} s`
}

/** A scrubber `width` cells wide: played part, the playhead, what is left. */
export function scrubber(position: number, total: number, width: number): { played: string; head: string; rest: string } {
  const cells = Math.max(3, width)
  const at = total <= 1 ? 0 : Math.round((position / (total - 1)) * (cells - 1))
  return { played: '━'.repeat(at), head: '●', rest: '─'.repeat(cells - at - 1) }
}

/** A Markdown code fence longer than any run of backticks in `value`. */
function fenced(value: string, language = ''): string {
  const longest = Math.max(2, ...[...value.matchAll(/`+/g)].map(match => match[0].length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}${language}\n${value}\n${fence}`
}

/** The steps' meta line: when, how long, failed or not. */
export function metaOf(step: ReplayStep): string {
  return [
    KIND_NAMES[step.kind],
    step.at === undefined ? '' : clockTime(step.at),
    step.durationMs === undefined ? '' : duration(step.durationMs),
    step.isError === true ? '✗ failed' : '',
  ].filter(part => part !== '').join(' · ')
}

/** The whole timeline as a Markdown document. */
export function exportMarkdown(steps: readonly ReplayStep[], title: string): string {
  const count = (kind: ReplayKind) => steps.filter(step => step.kind === kind).length
  const tools = steps.filter(step => step.kind !== 'prompt' && step.kind !== 'answer').length
  const sections = steps.map((step, index) => {
    const body = step.body === ''
      ? ''
      : step.format === 'markdown'
        ? step.body
        : fenced(step.body, step.format === 'diff' ? 'diff' : step.language ?? '')
    const output = step.output === undefined || step.output === '' ? '' : `${step.isError === true ? 'Error' : 'Output'}:\n\n${fenced(step.output)}`
    return [`## ${index + 1}. ${ICONS[step.kind]} ${step.title}`, `*${metaOf(step)}*`, body, output].filter(part => part !== '').join('\n\n')
  })

  return [
    `# ${title}`,
    `${steps.length} steps · ${count('prompt')} prompts · ${tools} tool calls · ${count('edit')} edits`,
    ...sections,
  ].join('\n\n') + '\n'
}
