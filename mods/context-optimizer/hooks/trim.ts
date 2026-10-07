/**
 * Trimming noisy tool results: output-trimmer's head + tail + error lines, generalised to any tool's text
 * (and to one-line blobs such as minified JSON, which have no lines to keep). Pure: no `$`, no I/O.
 */

/** Lines worth keeping from the part that is cut. */
const NOTEWORTHY = /error|fail|warn|exception|traceback|panic|fatal|denied|not found/i
const MAX_NOTEWORTHY = 40
const MAX_LINE_CHARS = 400
/** Of a trimmed result, the share kept from its start; the rest comes from its end. */
const HEAD_SHARE = 0.4
/** The usual rule of thumb for English text and code. */
export const CHARS_PER_TOKEN = 4

/** Tools whose results are never trimmed: Claude needs them whole (file contents, its own todo list, a subagent's answer). */
export const NEVER_TRIMMED: ReadonlySet<string> = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'Agent', 'Task', 'AskUserQuestion', 'ExitPlanMode'])

export const tokensOf = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN)

const count = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

const clip = (line: string): string => (line.length <= MAX_LINE_CHARS ? line : `${line.slice(0, MAX_LINE_CHARS)}… [+${count(line.length - MAX_LINE_CHARS)} chars]`)

/** The tool patterns of the `trimTools` setting: names, `*` as a wildcard (`mcp__*`). */
export function toolPatterns(setting: string): RegExp[] {
  return setting
    .split(',')
    .map(part => part.trim())
    .filter(part => part !== '')
    .map(part => new RegExp(`^${part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`))
}

export const isTrimmable = (tool: string, patterns: readonly RegExp[]): boolean => !NEVER_TRIMMED.has(tool) && patterns.some(pattern => pattern.test(tool))

export type TrimOptions = { maxChars: number; tool: string }

/**
 * `text` cut to about `maxChars`: its first and last lines and, from the middle, the distinct lines that mention
 * an error, numbered; or, for text with few lines, its head and tail characters. Undefined when it fits.
 */
export function trimText(text: string, { maxChars, tool }: TrimOptions): string | undefined {
  if (maxChars <= 0 || text.length <= maxChars) return undefined
  const lines = text.split('\n')
  const headBudget = Math.floor(maxChars * HEAD_SHARE)
  const tailBudget = maxChars - headBudget
  const note = (what: string): string => `[context-optimizer: ${what} of this ${tool} result cut to save context. Ask for a narrower query if you need them.]`

  if (lines.length < 20) {
    const cut = text.length - headBudget - tailBudget
    return `${text.slice(0, headBudget)}\n${note(`${count(cut)} characters`)}\n${text.slice(text.length - tailBudget)}`
  }

  let head = 0
  for (let used = 0; head < lines.length && used + (lines[head]?.length ?? 0) <= headBudget; head += 1) used += (lines[head]?.length ?? 0) + 1
  let tail = lines.length
  for (let used = 0; tail > head && used + (lines[tail - 1]?.length ?? 0) <= tailBudget; tail -= 1) used += (lines[tail - 1]?.length ?? 0) + 1
  head = Math.max(head, 1)
  tail = Math.min(tail, lines.length - 1)
  if (tail <= head) return undefined

  const seen = new Set<string>()
  const noteworthy: string[] = []
  for (let index = head; index < tail && noteworthy.length < MAX_NOTEWORTHY; index += 1) {
    const line = (lines[index] ?? '').trim()
    if (!NOTEWORTHY.test(line) || seen.has(line)) continue
    seen.add(line)
    noteworthy.push(`${index + 1}: ${clip(line)}`)
  }
  const trimmed = [
    ...lines.slice(0, head).map(clip),
    note(`lines ${count(head + 1)}-${count(tail)} (${count(tail - head)} lines)${noteworthy.length === 0 ? '' : `; the ${noteworthy.length} that mention errors follow, numbered`}`),
    ...noteworthy,
    ...lines.slice(tail).map(clip),
  ].join('\n')
  return trimmed.length < text.length ? trimmed : undefined
}

/** The text of a tool_result's content (a string, or its text blocks joined); undefined when it holds media. */
export function resultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const texts = content.map(block => (typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string' ? (block.text as string) : undefined))
  return texts.every(text => text !== undefined) ? texts.join('\n') : undefined
}
