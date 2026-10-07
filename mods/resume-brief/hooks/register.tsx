import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import type { Brief } from '../types'

const DEFAULT_MAX_AGE_DAYS = 14
const DAY_MS = 86_400_000
const PROMPTS_KEPT = 3
const FILES_KEPT = 8
const FILES_SHOWN = 3
const TODOS_KEPT = 8
const LINE_CHARS = 160
const GIT_TIMEOUT_MS = 3_000
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const briefAtom = atom({ plugin: 'resume-brief', key: 'brief' } as const, null)
const isHiddenAtom = atom({ plugin: 'resume-brief', key: 'isHidden' } as const, false)

/** What this load caches between saves: the branch, read once per turn off the hot path. */
type Saver = { branch: string; isInteractive: boolean }

const storeKey = (root: string): string => `brief:${root.replace(/[\\/]+$/, '')}`
const clip = (text: string): string => (text.length > LINE_CHARS ? `${text.slice(0, LINE_CHARS - 1)}…` : text)
const firstLine = (text: string): string => clip(text.trim().split('\n')[0]?.trim() ?? '')
const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

function relativeTo(root: string, path: string): string {
  const prefix = `${root.replace(/[\\/]+$/, '')}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

function isBrief(value: unknown): value is Brief {
  if (typeof value !== 'object' || value === null) return false
  const brief = value as Record<string, unknown>
  return typeof brief.sessionId === 'string' && typeof brief.savedAt === 'number' && Array.isArray(brief.prompts)
}

/** The brief the transcript supports, or undefined for a session with no request yet. */
function briefOf(messages: readonly SessionMessage[], root: string): Omit<Brief, 'sessionId' | 'savedAt' | 'branch'> | undefined {
  const prompts: string[] = []
  const files: string[] = []
  let todos: string[] = []
  let lastAnswer = ''
  for (const message of messages) {
    const text = message.text.trim()
    if (message.role === 'user' && text && !message.toolResults?.length && !text.startsWith('<')) prompts.push(firstLine(text))
    if (message.role === 'assistant' && text) lastAnswer = firstLine(text)
    for (const use of message.toolUses) {
      const path = use.input.file_path ?? use.input.notebook_path
      if (EDIT_TOOLS.has(use.tool) && typeof path === 'string' && use.isError !== true) {
        const relative = relativeTo(root, path)
        const earlier = files.indexOf(relative)
        if (earlier >= 0) files.splice(earlier, 1)
        files.push(relative)
      }
      if (use.tool === 'TodoWrite' && Array.isArray(use.input.todos)) {
        todos = use.input.todos
          .filter((todo): todo is { content: string; status: string } => typeof todo?.content === 'string')
          .filter(todo => todo.status !== 'completed')
          .map(todo => clip(todo.content))
      }
    }
  }
  if (prompts.length === 0) return undefined

  return { prompts: prompts.slice(-PROMPTS_KEPT), files: files.slice(-FILES_KEPT), todos: todos.slice(0, TODOS_KEPT), lastAnswer }
}

function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 2) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 36) return `${hours} h ago`
  return `${Math.round(hours / 24)} days ago`
}

function filesLine(files: readonly string[]): string {
  const shown = files.slice(-FILES_SHOWN).reverse().map(baseName).join(', ')
  return files.length > FILES_SHOWN ? `${shown} +${files.length - FILES_SHOWN}` : shown
}

function continuePrompt(brief: Brief, now: number): string {
  const lines = [`Continue where we left off. In the last session (${brief.branch ? `on branch ${brief.branch}, ` : ''}${ago(now - brief.savedAt)}):`]
  lines.push(`- My last requests: ${brief.prompts.map(prompt => `"${prompt}"`).join('; ')}`)
  if (brief.files.length > 0) lines.push(`- Files you edited: ${brief.files.join(', ')}`)
  if (brief.todos.length > 0) lines.push(`- Todos still open: ${brief.todos.join('; ')}`)
  if (brief.lastAnswer) lines.push(`- Where you stopped: ${brief.lastAnswer}`)
  lines.push('Check the current state of those files first, then pick up the unfinished work.')

  return lines.join('\n')
}

async function branchOf($: EngineInterface): Promise<string> {
  try {
    const out = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS })
    const branch = out.stdout.trim()
    return out.exitCode === 0 && branch !== 'HEAD' ? branch : ''
  } catch {
    return ''
  }
}

/** Saves where this session stands, keeping the previous brief when there is nothing to say yet. */
async function saveBrief($: EngineInterface, saver: Saver, sessionId: string): Promise<void> {
  const root = await $.session.root()
  const facts = briefOf(await $.session.messages(), root)
  if (facts === undefined) return
  const brief: Brief = { sessionId, savedAt: await $.clock.now(), branch: saver.branch, ...facts }
  await $.store.set(storeKey(root), brief)
}

async function saveAfterTurn($: EngineInterface, saver: Saver): Promise<void> {
  try {
    saver.branch = await branchOf($)
    await saveBrief($, saver, await $.session.id())
  } catch {
    // A brief that cannot be saved now is saved after the next turn or at exit.
  }
}

/** The stored brief of the previous session in this project, when it is recent enough to show. */
async function previousBrief($: EngineInterface, maxAgeMs: number): Promise<Brief | undefined> {
  const stored = await $.store.get(storeKey(await $.session.root()))
  if (!isBrief(stored)) return undefined
  const isOwn = stored.sessionId === (await $.session.id())
  const isFresh = (await $.clock.now()) - stored.savedAt <= maxAgeMs

  return !isOwn && isFresh ? stored : undefined
}

async function showBrief($: EngineInterface, maxAgeMs: number): Promise<Brief | undefined> {
  const brief = await previousBrief($, maxAgeMs)
  await update($, briefAtom, () => brief ?? null)
  await update($, isHiddenAtom, () => brief === undefined)

  return brief
}

async function continueWork($: EngineInterface): Promise<void> {
  const brief = await read($, briefAtom)
  await update($, isHiddenAtom, () => true)
  if (brief !== null) await $.prompt.submit({ text: continuePrompt(brief, await $.clock.now()), asUser: true })
}

async function hide($: EngineInterface): Promise<void> {
  if (!(await read($, isHiddenAtom))) await update($, isHiddenAtom, () => true)
}

async function briefCommand($: EngineInterface, maxAgeMs: number): Promise<string> {
  const brief = await showBrief($, maxAgeMs)
  if (brief === undefined) return 'No earlier session to resume in this project.'
  return `↩ Shown above the prompt. Press Continue to pick up “${brief.prompts.at(-1) ?? ''}”.`
}

export const register: Register = (on, options) => {
  const days = typeof options.maxAgeDays === 'number' ? options.maxAgeDays : DEFAULT_MAX_AGE_DAYS
  const maxAgeMs = Math.max(0, days) * DAY_MS
  const saver: Saver = { branch: '', isInteractive: true }

  on('session.start', async ($, e, next) => {
    saver.isInteractive = e.isInteractive
    await $.command.register({ name: 'resume-brief', description: 'Show what you were working on in the last session' })
    if (e.isInteractive) await showBrief($, maxAgeMs)

    return next(e)
  })

  on('command.run', { command: 'resume-brief' }, async $ => ({ text: await briefCommand($, maxAgeMs) }))

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer') await hide($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && saver.isInteractive) $.clock.after(0, () => void saveAfterTurn($, saver))

    return result
  })

  on('session.end', async ($, e, next) => {
    try {
      if (saver.isInteractive) await saveBrief($, saver, e.sessionId)
    } catch {
      // Exiting stays fast; the brief saved after the last turn stands.
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const brief = await read($, briefAtom)
    if (e.props.hasSurvey || brief === null || (await read($, isHiddenAtom))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    // Other plugins' bands draw beneath this one rather than being replaced by it.
    const below = await next(e)
    const when = ago((await $.clock.now()) - brief.savedAt)
    const facts = [
      brief.files.length > 0 ? `Edited ${filesLine(brief.files)}` : '',
      brief.todos.length > 0 ? `${brief.todos.length} open todo${brief.todos.length === 1 ? '' : 's'}` : '',
    ].filter(Boolean)

    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        <Text wrap="truncate-end">
          <Text bold>↩ Last session</Text>
          <Text dimColor>
            {' '}
            · {when}
            {brief.branch ? ` · ${brief.branch}` : ''}
          </Text>
        </Text>
        <Text wrap="truncate-end">
          You asked: “{brief.prompts.at(-1) ?? ''}”
        </Text>
        {facts.length > 0 && (
          <Text dimColor wrap="truncate-end">
            {facts.join(' · ')}
          </Text>
        )}
        <Box flexDirection="row" gap={1}>
          <Button key="continue" label="Continue" hotkey="c" variant="primary" onPress={() => continueWork($)} />
          <Button key="dismiss" label="Dismiss" hotkey="x" role="dismiss" onPress={() => hide($)} />
        </Box>
        {below}
      </Box>
    )
  })
}
