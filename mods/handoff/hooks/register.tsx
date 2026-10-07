import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HandoffView } from '../types'
import { composeNote, handoffPrompt, missingSections, sectionsOf, stampOf } from './note'
import type { GitFacts } from './note'

const PANE = 'handoff'
const GIT_TIMEOUT_MS = 10_000
const STATUS_LINES = 40
const STAT_LINES = 30
const MAX_SUFFIX = 20

const viewAtom = atom({ plugin: 'handoff', key: 'view' } as const, null)

type Settings = { dir: string; copy: boolean }

/** A failure's detail is a lowercase clause; as a command answer it starts a sentence. */
const asSentence = (clause: string): string => clause.charAt(0).toUpperCase() + clause.slice(1)

const capLines = (text: string, max: number): string => {
  const lines = text.trimEnd().split('\n').filter(line => line.trim() !== '')
  return lines.length > max ? [...lines.slice(0, max), `… ${lines.length - max} more`].join('\n') : lines.join('\n')
}

async function git($: EngineInterface, args: readonly string[]): Promise<string | undefined> {
  try {
    const run = await $.process.run(['git', ...args], { timeoutMs: GIT_TIMEOUT_MS })
    return run.exitCode === 0 ? run.stdout : undefined
  } catch {
    return undefined
  }
}

async function gitFacts($: EngineInterface): Promise<GitFacts | undefined> {
  const branch = (await git($, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim()
  if (branch === undefined) return undefined
  return {
    branch,
    status: capLines((await git($, ['status', '--short'])) ?? '', STATUS_LINES),
    diffStat: capLines((await git($, ['diff', '--stat', 'HEAD'])) ?? '', STAT_LINES),
    commits: capLines((await git($, ['log', '-5', '--format=%h %s'])) ?? '', 5),
  }
}

/** `.claude/handoff/2026-10-07-1342.md`, or `-2`, `-3`… when that minute already has one. */
async function freePath($: EngineInterface, dir: string, stamp: string): Promise<string> {
  for (let n = 1; n <= MAX_SUFFIX; n += 1) {
    const path = `${dir}/${stamp}${n === 1 ? '' : `-${n}`}.md`
    if (!(await $.fs.exists(path))) return path
  }
  return `${dir}/${stamp}-${Date.now()}.md`
}

async function writeHandoff($: EngineInterface, settings: Settings, note: string): Promise<HandoffView> {
  const set = async (view: HandoffView): Promise<HandoffView> => {
    await update($, viewAtom, () => view)
    return view
  }
  await set({ status: 'writing', text: '', path: '', isCopied: false, detail: 'Reading the session and git…' })
  const facts = await gitFacts($)
  const reply = await $.model.fork({ prompt: handoffPrompt(facts, note) })
  if (!reply.isAnswered) {
    const why =
      reply.reason === 'nothing-to-fork' ? 'nothing to hand off yet: this conversation has no work in it.'
        : reply.reason === 'api-error' ? `the model call failed (${reply.error}).`
          : reply.reason === 'aborted' ? 'writing the note was interrupted.'
            : 'the model wrote nothing.'
    return set({ status: 'error', text: '', path: '', isCopied: false, detail: why })
  }
  const when = await $.clock.now()
  const root = await $.session.root()
  const sessionId = await $.session.id().catch(() => undefined)
  const text = composeNote(sectionsOf(reply.text), { when, branch: facts?.branch, sessionId })
  const absolute = await freePath($, `${root}/${settings.dir}`, stampOf(when))
  await $.fs.write(absolute, text)
  const path = absolute.slice(root.length + 1)
  const isCopied = settings.copy && (await $.ui.copy({ text }).catch(() => ({ isCopied: false }))).isCopied
  const missing = missingSections(text)
  const detail = missing.length === 0 ? '' : `Missing sections: ${missing.join(', ')}.`
  return set({ status: 'ready', text, path, isCopied, detail })
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    dir: String(options.dir ?? '').trim().replace(/^\.\/|\/+$/g, '') || '.claude/handoff',
    copy: options.copy !== false,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'handoff',
      description: 'Write a handoff note (goal, status, changes, next steps) to .claude/handoff and copy it',
      argumentHint: '[what to stress]',
    })
    return next(e)
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'Handoff', rows: 24 })
    const view = await writeHandoff($, settings, e.args.trim())
    if (view.status !== 'ready') {
      await $.ui.close({ id: PANE })
      return { text: asSentence(view.detail) }
    }
    const copied = view.isCopied ? ' and copied it to the clipboard' : settings.copy ? ' (the clipboard was not reachable; use Copy in the pane)' : ''
    return { text: `Wrote ${view.path}${copied}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const view = await read($, viewAtom)
    if (view === null || view.status === 'writing') {
      return <Text color="suggestion">{view?.detail ?? 'Writing the handoff note…'}</Text>
    }
    const copy = async (surface: typeof e.surface) => {
      const copied = await $.ui.copy({ text: view.text, surface })
      $.ui.toast(copied.isCopied ? 'Note copied' : `Could not copy (${copied.reason})`)
    }

    return (
      <Box flexDirection="column" gap={1}>
        {view.status === 'error' ? (
          <Text color="error">{view.detail}</Text>
        ) : (
          <Box flexDirection="column">
            <Text bold wrap="truncate-end">{`Saved to ${view.path}`}</Text>
            <Text dimColor>{view.isCopied ? 'Copied to the clipboard: paste it where your teammate will see it.' : 'Use Copy to put it on the clipboard.'}</Text>
            {view.detail !== '' && <Text color="warning">{view.detail}</Text>}
          </Box>
        )}
        {view.status === 'ready' && <Markdown key="note" text={view.text} />}
        <Box gap={1}>
          {view.status === 'ready' && <Button key="copy" label="Copy" hotkey="c" variant="primary" onPress={press => void copy(press.surface)} />}
          <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}
