import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { IssueDraftState } from '../types'
import { asText, draftPrompt, issueUrl, parseArgs, parseDraft } from './draft'
import type { IssueKind } from './draft'

const NAME = 'issue-drafter'
const PANE = 'issue'
const GH_TIMEOUT_MS = 60_000
const DEFAULT_TMP = '/tmp'
const TYPE_LABELS: Record<IssueKind, string> = { bug: 'bug', feature: 'enhancement' }

const draftAtom = atom({ plugin: 'issue-drafter', key: 'draft' } as const, null)

type Settings = { labels: string[]; typeLabels: boolean }

const firstLine = (text: string): string => text.trim().split('\n')[0]?.trim() ?? ''

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Asks a fork of this conversation for the draft; answers why not when there is none. */
async function draft($: EngineInterface, kind: IssueKind | undefined, focus: string): Promise<string | undefined> {
  await update($, draftAtom, (): IssueDraftState => ({ status: 'drafting', kind: kind ?? 'bug', title: '', body: '', focus, note: '' }))
  const reply = await $.model.fork({ prompt: draftPrompt(kind, focus) })
  if (!reply.isAnswered) {
    const why =
      reply.reason === 'nothing-to-fork' ? 'nothing to draft yet: describe the problem or idea to Claude first.'
        : reply.reason === 'api-error' ? `the model call failed (${reply.error}${reply.status === null ? '' : `, HTTP ${reply.status}`}).`
          : reply.reason === 'aborted' ? 'drafting was interrupted.'
            : 'the model gave no draft.'
    await update($, draftAtom, () => null)
    return why
  }
  const parsed = parseDraft(reply.text, kind)
  if (parsed === undefined) {
    await update($, draftAtom, () => null)
    return 'the draft came back in an unexpected shape; try /issue again.'
  }
  await update($, draftAtom, (): IssueDraftState => ({ status: 'ready', ...parsed, focus, note: '' }))
  return undefined
}

async function createIssue($: EngineInterface, settings: Settings): Promise<void> {
  const current = await read($, draftAtom)
  if (current === null || current.status === 'creating' || current.status === 'created') return
  await update($, draftAtom, (): IssueDraftState => ({ ...current, status: 'creating', note: 'Creating the issue with gh…' }))
  const fail = (note: string) => update($, draftAtom, (): IssueDraftState => ({ ...current, status: 'error', note }))
  try {
    const tmp = ((await $.env.get('TMPDIR')) ?? DEFAULT_TMP).replace(/\/+$/, '') || DEFAULT_TMP
    const bodyFile = `${tmp}/claude-issue-${await $.clock.now()}.md`
    await $.fs.write(bodyFile, `${current.body}\n`)
    const labels = [...settings.labels, ...(settings.typeLabels ? [TYPE_LABELS[current.kind]] : [])]
    const run = await $.process.run(
      ['gh', 'issue', 'create', '--title', current.title, '--body-file', bodyFile, ...labels.flatMap(label => ['--label', label])],
      { cwd: await $.session.root(), timeoutMs: GH_TIMEOUT_MS },
    )
    const url = issueUrl(run.stdout)
    if (run.exitCode !== 0 || url === undefined) {
      await fail(`gh failed: ${firstLine(run.stderr) || firstLine(run.stdout) || `exit code ${run.exitCode}`}`)
      return
    }
    await update($, draftAtom, (): IssueDraftState => ({ ...current, status: 'created', url, note: '' }))
    $.ui.toast(`${NAME}: created ${url}`)
  } catch (error) {
    const message = errorText(error)
    await fail(/ENOENT|not found|cannot start/i.test(message)
      ? 'The GitHub CLI (gh) is not installed or not on PATH: get it at https://cli.github.com, or use Copy.'
      : `could not run gh: ${message}`)
  }
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    labels: String(options.labels ?? '').split(',').map(label => label.trim()).filter(Boolean),
    typeLabels: options.typeLabels === true,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'issue',
      description: 'Turn this conversation into a GitHub issue (preview, then create with gh or copy)',
      argumentHint: '[bug|feature] [focus]',
    })
    return next(e)
  })

  on('command.run', { command: 'issue' }, async ($, e) => {
    const { kind, focus } = parseArgs(e.args)
    await $.ui.open({ id: PANE, title: 'Issue draft', rows: 24 })
    const problem = await draft($, kind, focus)
    if (problem !== undefined) {
      await $.ui.close({ id: PANE })
      return { text: `${NAME}: ${problem}` }
    }
    const ready = await read($, draftAtom)
    return { text: `${NAME}: drafted ${ready?.kind ?? 'an'} issue "${ready?.title ?? ''}". Review it in the Issue draft pane, then create it with gh or copy it.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Markdown, Link } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const issue = await read($, draftAtom)
    if (issue === null) return <Text dimColor>Run /issue to draft one from this conversation.</Text>
    if (issue.status === 'drafting') {
      return <Text color="suggestion">{`Drafting ${issue.focus === '' ? 'an issue' : `"${issue.focus}"`} from the conversation…`}</Text>
    }
    const copy = async (surface: typeof e.surface, text: string, what: string) => {
      const copied = await $.ui.copy({ text, surface })
      $.ui.toast(copied.isCopied ? `${NAME}: ${what} copied` : `${NAME}: could not copy (${copied.reason})`)
    }
    const retitle = (title: string) =>
      update($, draftAtom, current => (current === null || title.trim() === '' ? current : { ...current, title: title.trim() }))
    const isOpen = issue.status === 'ready' || issue.status === 'error'

    return (
      <Box flexDirection="column" gap={1}>
        <Box gap={1}>
          <Text color={issue.kind === 'bug' ? 'error' : 'success'} bold>{issue.kind === 'bug' ? '● bug' : '● feature'}</Text>
          <Text bold wrap="truncate-end">{issue.title}</Text>
        </Box>
        {Input !== undefined && isOpen && (
          <Input key="title" label="Title " value={issue.title} submitLabel="rename" onSubmit={value => void retitle(value)} />
        )}
        <Markdown key="body" text={issue.body} />
        {issue.status === 'creating' && <Text color="suggestion">{issue.note}</Text>}
        {issue.status === 'error' && <Text color="error">{issue.note}</Text>}
        {issue.status === 'created' && issue.url !== undefined && (
          <Box gap={1}>
            <Text color="success">✓ Created</Text>
            <Link href={issue.url} />
          </Box>
        )}
        <Box gap={1} flexWrap="wrap">
          {isOpen && <Button key="create" label="Create with gh" hotkey="g" variant="primary" onPress={() => void createIssue($, settings)} />}
          {issue.status === 'created' && issue.url !== undefined ? (
            <Button key="copy-url" label="Copy link" hotkey="c" onPress={press => void copy(press.surface, issue.url ?? '', 'link')} />
          ) : (
            <Button key="copy" label="Copy" hotkey="c" onPress={press => void copy(press.surface, asText(issue), 'issue')} />
          )}
          {isOpen && <Button key="redraft" label="Redraft" hotkey="r" onPress={() => void draft($, issue.kind, issue.focus)} />}
          <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}
