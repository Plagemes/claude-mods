import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelForkResult, PluginOptions, Register } from 'claude-code'

import type { Draft } from '../types'
import { paneFailure } from './shared/render-safe'

const MOD = 'decision-log'
const PANE = 'decision-log'
const DEFAULT_DIRECTORY = 'docs/decisions'
const ADR_FILE = /^(\d{4})-.+\.md$/
const SLUG_CHARS = 50
const LISTED_MAX = 100
const PANE_ROWS = 30
/** How much of the Decision section goes into a `decision.recorded` event. */
const SUMMARY_CHARS = 300

const draftAtom = atom({ plugin: 'decision-log', key: 'draft' } as const, null)

type Settings = { directory: string; status: 'Accepted' | 'Proposed' }

function readSettings(options: PluginOptions): Settings {
  const raw = typeof options.directory === 'string' ? options.directory.trim() : ''
  const directory = raw.replace(/^\.?\/+/, '').replace(/\/+$/, '') || DEFAULT_DIRECTORY

  return { directory, status: options.status === 'Proposed' ? 'Proposed' : 'Accepted' }
}

const pad = (n: number): string => String(n).padStart(4, '0')
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function slugOf(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_CHARS)
    .replace(/-+$/, '')

  return slug || 'decision'
}

function dateOf(ms: number): string {
  const day = new Date(ms)
  const two = (n: number): string => String(n).padStart(2, '0')

  return `${day.getFullYear()}-${two(day.getMonth() + 1)}-${two(day.getDate())}`
}

const fileNameOf = (draft: Pick<Draft, 'number' | 'title'>): string => `${pad(draft.number)}-${slugOf(draft.title)}.md`

function adrMarkdown(draft: Draft, status: string): string {
  return `# ${pad(draft.number)}. ${draft.title}\n\n- Status: ${status}\n- Date: ${draft.date}\n\n${draft.body}\n`
}

function forkPrompt(title: string): string {
  return [
    `Draft an Architecture Decision Record titled "${title}" from this conversation.`,
    'Use only what the conversation establishes; write "TBD" where something is unknown instead of inventing it.',
    'Reply with Markdown only, no preamble and no code fence, using exactly these sections in this order:',
    '## Context',
    '## Decision',
    '## Consequences',
    '## Alternatives considered',
    'Keep it under 400 words; short paragraphs and bullet points are welcome.',
  ].join('\n')
}

/** The fork's reply from its first section on, outer code fence removed. */
function cleanBody(text: string): string {
  const unfenced = text.trim().replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/, '$1').trim()
  const start = unfenced.search(/^## /m)

  return (start > 0 ? unfenced.slice(start) : unfenced).trim()
}

function failureOf(reply: ModelForkResult): string {
  if (reply.isAnswered) return 'The model returned an empty draft.'
  if (reply.reason === 'nothing-to-fork') {
    return 'There is no conversation to draft from yet. Discuss the decision with Claude first, then run /decide again.'
  }
  if (reply.reason === 'api-error') return `The model request failed (${reply.status ?? 'no response'}, ${reply.error}).`
  if (reply.reason === 'aborted') return 'Drafting was interrupted.'
  return 'The model returned an empty draft.'
}

/** The Decision section's first paragraph, for the hub's `decision.recorded`; undefined when the draft has none. */
function summaryOf(body: string): string | undefined {
  const section = /^## Decision\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(body)?.[1]?.trim()
  const paragraph = section?.split(/\n\s*\n/)[0]?.replace(/\s+/g, ' ').trim()
  if (paragraph === undefined || paragraph === '' || paragraph === 'TBD') return undefined
  return paragraph.length > SUMMARY_CHARS ? `${paragraph.slice(0, SUMMARY_CHARS - 1)}…` : paragraph
}

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
  await hubHello($, { version: await ownVersion($), publishes: ['decision.recorded'], consumes: [] })
}

/**
 * A saved ADR on the hub's bus, for every session (project-brain, recall, session-journal, handoff, team-hub
 * pick it up). Nothing happens without the hub.
 */
async function publishDecision($: EngineInterface, draft: Draft, path: string, status: string): Promise<void> {
  const summary = summaryOf(draft.body)
  await hubPublish($, {
    topic: 'decision.recorded',
    data: { title: draft.title, path, status, ...(summary === undefined ? {} : { summary }) },
    scope: 'global',
  })
}

async function folderOf($: EngineInterface, settings: Settings): Promise<string> {
  return `${(await $.session.root()).replace(/[\\/]+$/, '')}/${settings.directory}`
}

/** The ADR files of the folder, lowest number first; none when the folder is missing. */
async function adrFiles($: EngineInterface, folder: string): Promise<string[]> {
  const entries = await $.fs.list(folder).catch(() => [])

  return entries
    .filter(entry => entry.kind === 'file' && ADR_FILE.test(entry.name))
    .map(entry => entry.name)
    .sort()
}

async function nextNumber($: EngineInterface, folder: string): Promise<number> {
  const numbers = (await adrFiles($, folder)).map(name => Number(ADR_FILE.exec(name)?.[1] ?? 0))

  return Math.max(0, ...numbers) + 1
}

/** Forks the conversation for the ADR's sections and files them into the draft `id`, if it is still current. */
async function writeDraft($: EngineInterface, id: string, title: string): Promise<void> {
  let body = ''
  let error = ''
  try {
    const reply = await $.model.fork({ prompt: forkPrompt(title) })
    body = reply.isAnswered ? cleanBody(reply.text) : ''
    error = body ? '' : failureOf(reply)
  } catch (failure) {
    error = `Drafting failed: ${messageOf(failure)}`
  }
  await update($, draftAtom, (draft): Draft | null =>
    draft?.id !== id ? draft : body ? { ...draft, phase: 'ready', body, error: '' } : { ...draft, phase: 'failed', error },
  )
}

async function startDraft($: EngineInterface, title: string, settings: Settings): Promise<string> {
  const folder = await folderOf($, settings)
  const draft: Draft = {
    id: crypto.randomUUID(),
    title,
    number: await nextNumber($, folder),
    date: dateOf(await $.clock.now()),
    phase: 'drafting',
    body: '',
    error: '',
    path: '',
  }
  await update($, draftAtom, () => draft)
  await $.ui.open({ id: PANE, title: `ADR ${pad(draft.number)}`, rows: PANE_ROWS })
  $.clock.after(0, () => void writeDraft($, draft.id, title))

  return `📝 ${MOD}: drafting ADR ${pad(draft.number)} “${title}” from this conversation…`
}

async function redraft($: EngineInterface): Promise<void> {
  const draft = await read($, draftAtom)
  if (draft === null) return
  const id = crypto.randomUUID()
  await update($, draftAtom, (current): Draft | null => (current === null ? null : { ...current, id, phase: 'drafting', error: '' }))
  $.clock.after(0, () => void writeDraft($, id, draft.title))
}

async function saveDraft($: EngineInterface, settings: Settings): Promise<void> {
  const draft = await read($, draftAtom)
  if (draft === null || draft.phase !== 'ready') return
  const folder = await folderOf($, settings)
  const number = Math.max(draft.number, await nextNumber($, folder))
  const name = fileNameOf({ number, title: draft.title })
  const path = `${settings.directory}/${name}`
  try {
    await $.fs.write(`${folder}/${name}`, adrMarkdown({ ...draft, number }, settings.status))
  } catch (error) {
    $.ui.toast(`⚠️ ${MOD}: could not write ${path}: ${messageOf(error)}`)
    return
  }
  await update($, draftAtom, (current): Draft | null => (current?.id === draft.id ? { ...current, number, phase: 'saved', path } : current))
  $.ui.toast(`✅ ${MOD}: saved ${path}`)
  await publishDecision($, draft, path, settings.status)
}

async function closeDraft($: EngineInterface): Promise<void> {
  await update($, draftAtom, () => null)
  await $.ui.close({ id: PANE })
}

/** `/decisions`: one line per ADR with its status and date. */
async function listDecisions($: EngineInterface, settings: Settings): Promise<string> {
  const folder = await folderOf($, settings)
  const files = (await adrFiles($, folder)).slice(-LISTED_MAX)
  if (files.length === 0) return `${MOD}: no decisions in ${settings.directory} yet. Record one with /decide <title>.`

  const lines: string[] = []
  for (const name of files) {
    const text = await $.fs.read(`${folder}/${name}`).catch(() => '')
    const content = typeof text === 'string' ? text : ''
    const title = /^#\s+(?:\d+\.\s*)?(.+)$/m.exec(content)?.[1]?.trim() ?? name
    const status = /^[-*]?\s*status:\s*(.+)$/im.exec(content)?.[1]?.trim()
    const date = /^[-*]?\s*date:\s*(.+)$/im.exec(content)?.[1]?.trim()
    const facts = [status, date].filter(Boolean).join(', ')
    lines.push(`${name.slice(0, 4)}. ${title}${facts ? ` (${facts})` : ''}`)
  }
  const count = files.length === 1 ? '1 decision' : `${files.length} decisions`

  return `📚 ${count} in ${settings.directory}\n${lines.join('\n')}`
}

async function decide($: EngineInterface, args: string, settings: Settings): Promise<string> {
  const title = args.trim().replace(/^["'“]|["'”]$/g, '').trim()
  if (title) return startDraft($, title, settings)

  const draft = await read($, draftAtom)
  if (draft !== null && draft.phase !== 'saved') {
    await $.ui.open({ id: PANE, title: `ADR ${pad(draft.number)}`, rows: PANE_ROWS })
    return `${MOD}: reopened the draft of “${draft.title}”.`
  }
  return `${MOD}: usage /decide <title>, e.g. /decide Use Postgres for event storage`
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    await registerCommand($, {
      name: 'decide',
      description: 'Draft an Architecture Decision Record from this conversation',
      argumentHint: '<title>',
    })
    await registerCommand($, { name: 'decisions', description: 'List the Architecture Decision Records of this project' })
    afterStart($, 'decision-log', () => greetHub($))

    return next(e)
  })

  on('command.run', { command: 'decide' }, async ($, e) => ({ text: await decide($, e.args, settings) }))

  on('command.run', { command: 'decisions' }, async $ => ({ text: await listDecisions($, settings) }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const draft = await read($, draftAtom)

    if (draft === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No ADR draft. Run /decide {'<title>'} to start one.</Text>
        </Box>
      )
    }

    const heading = (
      <Text bold>
        ADR {pad(draft.number)} · {draft.title}
      </Text>
    )

    if (draft.phase === 'drafting') {
      return (
        <Box flexDirection="column" gap={1}>
          {heading}
          <Text dimColor>⏳ Drafting Context, Decision, Consequences and Alternatives from the conversation…</Text>
          <Box flexDirection="row">
            <Button key="discard" label="Cancel" hotkey="d" onPress={() => closeDraft($)} />
          </Box>
        </Box>
      )
    }

    if (draft.phase === 'failed') {
      return (
        <Box flexDirection="column" gap={1}>
          {heading}
          <Text color="error">⚠️ {draft.error}</Text>
          <Box flexDirection="row" gap={1}>
            <Button key="retry" label="Retry" hotkey="r" variant="primary" onPress={() => redraft($)} />
            <Button key="close" label="Close" hotkey="d" role="dismiss" onPress={() => closeDraft($)} />
          </Box>
        </Box>
      )
    }

    if (draft.phase === 'saved') {
      return (
        <Box flexDirection="column" gap={1}>
          {heading}
          <Text color="success">✅ Saved {draft.path}</Text>
          <Box flexDirection="row">
            <Button key="close" label="Close" hotkey="d" role="dismiss" onPress={() => closeDraft($)} />
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {heading}
        <Text dimColor>
          Will be saved as {settings.directory}/{fileNameOf(draft)}
        </Text>
        <Markdown key="adr" text={adrMarkdown(draft, settings.status)} />
        <Box flexDirection="row" gap={1}>
          <Button key="save" label="Save" hotkey="s" variant="primary" onPress={() => saveDraft($, settings)} />
          <Button key="regenerate" label="Regenerate" hotkey="r" onPress={() => redraft($)} />
          <Button key="discard" label="Discard" hotkey="d" onPress={() => closeDraft($)} />
        </Box>
      </Box>
    )
  }).catch(async ($, e, next) =>
    next.error.kind === 're-entry'
      ? next(e)
      : paneFailure($.ui.resolve(e), { title: 'decision-log', failure: next.error, below: await next(e).catch(() => null), onRetry: () => $.ui.invalidate('ui.render') }),
  )
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

// #region @vendored shared/hub-client.ts sha256:6b153e2e759f: edit the source, then run `node scripts/sync-shared.mjs`.
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
/**
 * Runs a mod's start-up work (the hub hello, a first scan, loading what it keeps) once `session.start` has returned,
 * after a short delay staggered by the mod's name (0.15–1.35 s), so ~200 mods sharing one hooks worker do not all wait
 * on the hub, a process or the disk inside the session.start chain (`ran past its 10s budget`). A failure is logged
 * to the debug log. Call it from `session.start` in place of `await work()`; never await the hub there
 * (scripts/check-startup.mjs).
 */
function afterStart($: EngineInterface, mod: string, work: () => Promise<unknown>): void {
  let hash = 7
  for (let i = 0; i < mod.length; i += 1) hash = (hash * 31 + mod.charCodeAt(i)) % 1_200
  $.clock.after(150 + hash, () => {
    void work().catch(error => $.ui.log(`${mod}: start-up work failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' }))
  })
}
// #endregion @vendored shared/hub-client.ts
