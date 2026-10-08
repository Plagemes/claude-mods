import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { ExplainChange, ExplainFile, ExplainLevel, Explanation } from '../types'
import { cutDiff, unifiedDiff } from './diff'
import { SYSTEM, explainPrompt, noteMarkdown, parseExplanation } from './explain'

const PANE = 'explain-diff'
const PANE_TITLE = 'Explain diff'
const PANE_ROWS = 30
const STORE_PREFIX = 'change:'
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const
/** Files larger than this are listed with no diff. */
const MAX_FILE_BYTES = 512 * 1024
const MAX_FILES = 40
/** Diff lines kept per file, for the pane and the store. */
const MAX_DIFF_LINES = 600
const PANE_DIFF_LINES = 300
const MAX_TOKENS = 4_096
const MODEL_TIMEOUT_MS = 120_000
const REQUEST_SHOWN = 120

const changeAtom = atom({ plugin: 'explain-diff', key: 'change' } as const, null)
const explanationAtom = atom({ plugin: 'explain-diff', key: 'explanation' } as const, null)
const shownAtom = atom({ plugin: 'explain-diff', key: 'shown' } as const, [])

type Settings = { level: ExplainLevel; model: string }

/** A file as it was before the turn first touched it. */
type Before = { kind: 'text'; text: string } | { kind: 'missing' } | { kind: 'large' }

/** The main-loop turn under way: its request and the files it touched, as they were. */
type Tracking = { turnId: string; request: string; before: Map<string, Before> }

type Session = { root: string | undefined; tracking: Tracking | undefined }

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const oneLine = (text: string, width: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > width ? `${line.slice(0, width - 1)}…` : line
}
const levelOf = (value: unknown): ExplainLevel | undefined => (value === 'beginner' || value === 'expert' ? value : undefined)

async function rootOf($: EngineInterface, session: Session): Promise<string> {
  if (session.root === undefined) session.root = (await $.session.root().catch(() => '')).replace(/[\\/]+$/, '')
  return session.root
}

async function readFile($: EngineInterface, path: string): Promise<Before> {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat === undefined) return { kind: 'missing' }
  if (stat.kind !== 'file' || stat.size > MAX_FILE_BYTES) return { kind: 'large' }
  const text = await $.fs.read(path).catch(() => undefined)
  return typeof text === 'string' ? { kind: 'text', text } : { kind: 'large' }
}

/** One touched file as an entry of the change; undefined when it ended as it began. */
async function fileOf($: EngineInterface, root: string, path: string, before: Before): Promise<ExplainFile | undefined> {
  const after = await readFile($, path)
  const relative = root !== '' && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
  if (before.kind === 'missing' && after.kind === 'missing') return undefined
  const status: ExplainFile['status'] = before.kind === 'missing' ? 'added' : after.kind === 'missing' ? 'deleted' : 'modified'
  if (before.kind === 'large' || after.kind === 'large') return { path: relative, status, added: 0, removed: 0, diff: '' }
  const diff = unifiedDiff(before.kind === 'text' ? before.text : '', after.kind === 'text' ? after.text : '')
  if (diff.text === '') return undefined
  return { path: relative, status, added: diff.added, removed: diff.removed, diff: cutDiff(diff.text, MAX_DIFF_LINES).text }
}

/** Files the change of a finished turn, unless it changed nothing in the end. */
async function recordTurn($: EngineInterface, session: Session, tracking: Tracking, answer: string): Promise<void> {
  const root = await rootOf($, session)
  const files: ExplainFile[] = []
  for (const [path, before] of [...tracking.before].slice(0, MAX_FILES)) {
    const file = await fileOf($, root, path, before)
    if (file !== undefined) files.push(file)
  }
  if (files.length === 0) return
  const change: ExplainChange = { id: tracking.turnId, request: tracking.request, answer, endedAt: await $.clock.now(), files }
  await update($, changeAtom, () => change)
  await update($, shownAtom, () => [])
  try {
    await $.store.set(`${STORE_PREFIX}${root}`, change)
  } catch (error) {
    $.ui.log(`explain-diff: could not save the change: ${messageOf(error)}`, { to: 'debug' })
  }
}

async function restore($: EngineInterface, session: Session): Promise<void> {
  const stored = (await $.store.get(`${STORE_PREFIX}${await rootOf($, session)}`).catch(() => undefined)) as ExplainChange | undefined
  if (stored !== undefined && typeof stored === 'object' && stored !== null && Array.isArray(stored.files)) await update($, changeAtom, () => stored)
}

/** Writes the explanation of the current change at `level`, unless a newer request replaced it meanwhile. */
async function explain($: EngineInterface, settings: Settings, level: ExplainLevel): Promise<void> {
  const change = await read($, changeAtom)
  if (change === null) return
  const working: Explanation = { requestId: crypto.randomUUID(), changeId: change.id, level, status: 'working', summary: '', notes: {}, error: '' }
  await update($, explanationAtom, () => working)

  let done: Explanation
  try {
    const reply = await $.model.complete({ model: settings.model, system: SYSTEM, prompt: explainPrompt(change, level), maxTokens: MAX_TOKENS, timeoutMs: MODEL_TIMEOUT_MS })
    if (reply.isAnswered) {
      const parsed = parseExplanation(reply.text, change.files.map(file => file.path))
      done = { ...working, status: 'ready', ...parsed }
    } else {
      const why = reply.reason === 'api-error' ? `the model request failed (${reply.status ?? 'no response'})` : reply.reason === 'aborted' ? 'it took too long' : 'the model gave no answer'
      done = { ...working, status: 'failed', error: `Could not explain the change: ${why}.` }
    }
  } catch (error) {
    done = { ...working, status: 'failed', error: `Could not explain the change: ${messageOf(error)}` }
  }
  await update($, explanationAtom, latest => (latest?.requestId === working.requestId ? done : latest))
}

async function toggleDiff($: EngineInterface, path: string): Promise<void> {
  await update($, shownAtom, shown => (shown.includes(path) ? shown.filter(one => one !== path) : [...shown, path]))
}

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: PANE_TITLE, rows: PANE_ROWS })
}

async function runCommand($: EngineInterface, settings: Settings, args: string): Promise<string> {
  const word = args.trim().toLowerCase()
  const level = word === '' ? settings.level : levelOf(word)
  if (level === undefined) return `Usage: /explain-diff [beginner|expert]`
  const change = await read($, changeAtom)
  if (change === null) return 'No edits recorded yet. Run /explain-diff after a turn in which Claude changed files.'
  await openPane($)
  const current = await read($, explanationAtom)
  const isFresh = current?.changeId === change.id && current.level === level && current.status !== 'failed'
  if (!isFresh) $.clock.after(0, () => void explain($, settings, level))
  const count = change.files.length === 1 ? '1 file' : `${change.files.length} files`
  return isFresh ? `Showing the explanation of the last change (${count}).` : `Explaining the last change (${count}) for ${level === 'beginner' ? 'a beginner' : 'an expert'}…`
}

export const register: Register = (on, options: PluginOptions) => {
  const settings: Settings = {
    level: levelOf(options.level) ?? 'beginner',
    model: (typeof options.model === 'string' ? options.model.trim() : '') || 'sonnet',
  }
  const session: Session = { root: undefined, tracking: undefined }

  on('session.start', async ($, e, next) => {
    await registerCommand($, { name: 'explain-diff', description: 'Explain in plain words what the last turn changed and why', argumentHint: '[beginner|expert]' })
    try {
      await restore($, session)
    } catch (error) {
      $.ui.log(`explain-diff: could not load the last change: ${messageOf(error)}`, { to: 'debug' })
    }
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    session.tracking = { turnId: e.turnId, request: e.text, before: new Map() }
    return next(e)
  })

  // Keeps each file as it was before the turn first touched it.
  on('tool.call', { tool: EDIT_TOOLS }, async ($, e, next) => {
    const path = 'file_path' in e ? e.file_path : 'notebook_path' in e ? e.notebook_path : undefined
    const { tracking } = session
    if (tracking !== undefined && typeof path === 'string' && !tracking.before.has(path) && tracking.before.size < MAX_FILES) {
      tracking.before.set(path, await readFile($, path).catch((): Before => ({ kind: 'large' })))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const { tracking } = session
    if (e.agentId !== undefined || tracking === undefined) return result
    session.tracking = undefined
    if (tracking.before.size > 0) {
      const { answer } = e
      $.clock.after(0, () => void recordTurn($, session, tracking, answer).catch(error => $.ui.log(`explain-diff: ${messageOf(error)}`, { to: 'debug' })))
    }
    return result
  })

  on('command.run', { command: 'explain-diff' }, async ($, e) => {
    try {
      return { text: await runCommand($, settings, e.args) }
    } catch (error) {
      return { text: `Failed: ${messageOf(error)}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Code, Markdown, Text } = $.ui.resolve(e)
    const change = await read($, changeAtom)
    if (change === null) return <Text dimColor>No edits recorded yet. Run /explain-diff after a turn in which Claude changed files.</Text>
    const found = await read($, explanationAtom)
    const explanation = found?.changeId === change.id ? found : null
    const shown = await read($, shownAtom)
    const level = explanation?.level ?? settings.level
    const added = change.files.reduce((sum, file) => sum + file.added, 0)
    const removed = change.files.reduce((sum, file) => sum + file.removed, 0)
    const count = change.files.length === 1 ? '1 file' : `${change.files.length} files`

    return (
      <Box flexDirection="column" gap={1}>
        <Box key="header" flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text bold>Last change · {count}</Text>
            <Text color="success">+{added}</Text>
            <Text color="error">-{removed}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">
            You asked: {oneLine(change.request || '(no prompt)', REQUEST_SHOWN)}
          </Text>
        </Box>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="level:beginner" label="Beginner" hotkey="b" variant={level === 'beginner' ? 'primary' : undefined} onPress={() => void explain($, settings, 'beginner')} />
          <Button key="level:expert" label="Expert" hotkey="e" variant={level === 'expert' ? 'primary' : undefined} onPress={() => void explain($, settings, 'expert')} />
          {explanation?.status !== 'working' && <Button key="regenerate" label="Regenerate" hotkey="r" onPress={() => void explain($, settings, level)} />}
          <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
        {explanation === null && <Text dimColor>Press Beginner or Expert for an explanation, or run /explain-diff.</Text>}
        {explanation?.status === 'working' && (
          <Box key="working">
            <Text color="suggestion">⏳ Explaining for {level === 'beginner' ? 'a beginner' : 'an expert'}…</Text>
          </Box>
        )}
        {explanation?.status === 'failed' && (
          <Box key="failed">
            <Text color="error">{explanation.error}</Text>
          </Box>
        )}
        {explanation?.status === 'ready' && <Markdown key="summary" text={explanation.summary} />}
        {change.files.map(file => {
          const note = explanation?.status === 'ready' ? explanation.notes[file.path] : undefined
          const isShown = shown.includes(file.path)
          return (
            <Box key={`file:${file.path}`} flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Box flexShrink={1}>
                  <Text bold color="claude" wrap="truncate-start">
                    {file.path}
                  </Text>
                </Box>
                {file.status !== 'modified' && <Text dimColor>({file.status})</Text>}
                <Text color="success">+{file.added}</Text>
                <Text color="error">-{file.removed}</Text>
                {file.diff !== '' && (
                  <Button key={`diff:${file.path}`} label={isShown ? 'Hide diff' : 'Show diff'} onPress={() => void toggleDiff($, file.path)} />
                )}
              </Box>
              {note !== undefined && <Markdown key={`note:${file.path}`} text={noteMarkdown(note)} />}
              {file.diff === '' && <Text dimColor>Too large to diff.</Text>}
              {isShown && <Code source={cutDiff(file.diff, PANE_DIFF_LINES).text} format="diff" path={file.path} />}
            </Box>
          )
        })}
      </Box>
    )
  })
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
