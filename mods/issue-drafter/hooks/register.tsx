import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { IssueDraftState } from '../types'
import { asText, draftPrompt, issueUrl, parseArgs, parseDraft } from './draft'
import type { IssueKind } from './draft'
import { redactText } from './shared/secrets'

const PANE = 'issue'
const GH_TIMEOUT_MS = 60_000
const DEFAULT_TMP = '/tmp'
const TYPE_LABELS: Record<IssueKind, string> = { bug: 'bug', feature: 'enhancement' }
/** How many failures of each kind the hub's bus may add to the draft's prompt, and how much of a body an event carries. */
const FAILURES_KEPT = 3
const EVENT_BODY_CHARS = 4_000

const draftAtom = atom({ plugin: 'issue-drafter', key: 'draft' } as const, null)

type Settings = { labels: string[]; typeLabels: boolean }

const firstLine = (text: string): string => text.trim().split('\n')[0]?.trim() ?? ''

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// ── mods-hub: failures other mods reported, and the issue on the bus ────────────────────────────────

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Says hello to mods-hub when it is installed. */
async function greetHub($: EngineInterface): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: ['issue.drafted'], consumes: ['ci.result', 'error.repeated'] })
}

/**
 * The failures mods-hub's bus reported this session, newest last: CI runs that failed (ci-watch) and commands
 * that failed again and again (`error.repeated`). None without the hub.
 */
async function reportedFailures($: EngineInterface): Promise<string[]> {
  try {
    const ci = (await $.mods.recent({ topic: 'ci.result', limit: 20 }))
      .map(event => event.data as { workflow?: unknown; outcome?: unknown; branch?: unknown; url?: unknown })
      .filter(data => data.outcome === 'failed')
      .slice(-FAILURES_KEPT)
      .map(data => `CI workflow "${asString(data.workflow)}" failed${data.branch ? ` on ${asString(data.branch)}` : ''}${data.url ? ` (${asString(data.url)})` : ''}`)
    const repeated = (await $.mods.recent({ topic: 'error.repeated', limit: FAILURES_KEPT }))
      .map(event => event.data as { command?: unknown; signature?: unknown; count?: unknown; tool?: unknown })
      .map(data => `\`${asString(data.command ?? data.signature)}\` (${asString(data.tool)}) failed ${asString(data.count)} times in a row`)
    return [...ci, ...repeated]
  } catch {
    return []
  }
}

const asString = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value) : '')

/** A created issue on the hub's bus, for every session (ticket-linker, team-hub). Its body is masked. */
async function publishIssue($: EngineInterface, issue: { title: string; body: string }, url: string, labels: readonly string[]): Promise<void> {
  const body = redactText(issue.body).text
  await hubPublish($, {
    topic: 'issue.drafted',
    data: { title: issue.title, body: body.length > EVENT_BODY_CHARS ? `${body.slice(0, EVENT_BODY_CHARS - 1)}…` : body, url, labels: [...labels] },
    scope: 'global',
  })
}

/** Asks a fork of this conversation for the draft; answers why not when there is none. */
async function draft($: EngineInterface, kind: IssueKind | undefined, focus: string): Promise<string | undefined> {
  await update($, draftAtom, (): IssueDraftState => ({ status: 'drafting', kind: kind ?? 'bug', title: '', body: '', focus, note: '' }))
  const reply = await $.model.fork({ prompt: draftPrompt(kind, focus, await reportedFailures($)) })
  if (!reply.isAnswered) {
    const why =
      reply.reason === 'nothing-to-fork' ? 'Nothing to draft yet: describe the problem or idea to Claude first.'
        : reply.reason === 'api-error' ? `The model call failed (${reply.error}${reply.status === null ? '' : `, HTTP ${reply.status}`}).`
          : reply.reason === 'aborted' ? 'Drafting was interrupted.'
            : 'The model gave no draft.'
    await update($, draftAtom, () => null)
    return why
  }
  const parsed = parseDraft(reply.text, kind)
  if (parsed === undefined) {
    await update($, draftAtom, () => null)
    return 'The draft came back in an unexpected shape; try /issue again.'
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
    $.ui.toast(`Created ${url}`)
    await publishIssue($, current, url, labels)
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
    await greetHub($)
    return next(e)
  })

  on('command.run', { command: 'issue' }, async ($, e) => {
    const { kind, focus } = parseArgs(e.args)
    await $.ui.open({ id: PANE, title: 'Issue draft', rows: 24 })
    const problem = await draft($, kind, focus)
    if (problem !== undefined) {
      await $.ui.close({ id: PANE })
      return { text: problem }
    }
    const ready = await read($, draftAtom)
    return { text: `Drafted ${ready?.kind ?? 'an'} issue "${ready?.title ?? ''}". Review it in the Issue draft pane, then create it with gh or copy it.` }
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
      $.ui.toast(copied.isCopied ? `${what} copied` : `Could not copy (${copied.reason})`)
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
            <Button key="copy-url" label="Copy link" hotkey="c" onPress={press => void copy(press.surface, issue.url ?? '', 'Link')} />
          ) : (
            <Button key="copy" label="Copy" hotkey="c" onPress={press => void copy(press.surface, asText(issue), 'Issue')} />
          )}
          {isOpen && <Button key="redraft" label="Redraft" hotkey="r" onPress={() => void draft($, issue.kind, issue.focus)} />}
          <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}

// #region @vendored shared/hub-client.ts sha256:0acb840d81b7: edit the source, then run `node scripts/sync-shared.mjs`.
// mods-hub client (docs/MOD_CONTRACT.md): uses the hub when it is installed, keeps working when it is not.

type HubMods = EngineInterface['mods']

/** Publishes an event on the hub's bus; false when there is no hub or it refused the event. */
async function hubPublish($: EngineInterface, input: Parameters<HubMods['publish']>[0]): Promise<boolean> {
  try {
    await $.mods.publish(input)
    return true
  } catch {
    return false
  }
}

/**
 * Routes a notification through the hub (channels, silent, night, presence), or shows it as a toast when there is
 * no hub: `title — body`, for `fallback.timeoutMs` when given (the toast's own option).
 */
async function hubNotify($: EngineInterface, input: Parameters<HubMods['notify']>[0], fallback: { timeoutMs?: number } = {}): Promise<void> {
  try {
    await $.mods.notify(input)
  } catch {
    const text = input.body === undefined || input.body === '' ? input.title : `${input.title} — ${input.body}`
    if (fallback.timeoutMs === undefined) $.ui.toast(text)
    else $.ui.toast(text, { timeoutMs: fallback.timeoutMs })
  }
}

/** The global mode (presence, silent, night, interaction), or undefined when there is no hub. */
async function hubMode($: EngineInterface): Promise<Awaited<ReturnType<HubMods['mode']>> | undefined> {
  try {
    return await $.mods.mode()
  } catch {
    return undefined
  }
}

/** Announces this mod to the hub, with its panel tab when it has one; call once from `session.start`. */
async function hubHello($: EngineInterface, hello: Parameters<HubMods['hello']>[0], tab?: Parameters<HubMods['registerTab']>[0]): Promise<boolean> {
  try {
    await $.mods.hello(hello)
    if (tab !== undefined) await $.mods.registerTab(tab)
    return true
  } catch {
    return false
  }
}

/** Opens the shared panel on this mod's tab; false when there is no hub (open your own pane then). */
async function hubShowTab($: EngineInterface, id: string): Promise<boolean> {
  try {
    return (await $.mods.showTab({ id })).isPlaced
  } catch {
    return false
  }
}

/**
 * Stops, pauses or resumes the automatic work (`control.stop` / `control.pause` / `control.resume`) in this session
 * or, with `scope: 'all'`, in every session; false when there is no hub (stop what you run yourself then).
 */
async function hubStop($: EngineInterface, input: Parameters<HubMods['stop']>[0]): Promise<boolean> {
  try {
    await $.mods.stop(input)
    return true
  } catch {
    return false
  }
}

/** Puts a fact on the hub's blackboard as `<this mod>.<name>`; false when there is no hub or it refused the fact. */
async function hubShareFact($: EngineInterface, input: Parameters<HubMods['share']>[0]): Promise<boolean> {
  try {
    await $.mods.share(input)
    return true
  } catch {
    return false
  }
}

/** A fact from the hub's blackboard by its full key (`stack-detector.stack`); undefined when there is no hub or no such fact. */
async function hubReadFact($: EngineInterface, key: string): Promise<Awaited<ReturnType<HubMods['read']>> | undefined> {
  try {
    return (await $.mods.read({ key })) ?? undefined
  } catch {
    return undefined
  }
}

/** Whether the shared panel shows tab `id` now; read while drawing, it subscribes the drawing. */
async function hubTabIs($: EngineInterface, id: string): Promise<boolean> {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
  return value === id
}
// #endregion @vendored shared/hub-client.ts
