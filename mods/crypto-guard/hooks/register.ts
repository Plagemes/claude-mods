import type { EngineInterface, Register } from 'claude-code'

import { RULES } from './rules'
import { ALLOW_MARKER, findWeakCrypto, isScannedFile } from './scan'
import type { Hit } from './scan'

const MAX_LISTED = 6

type Change = { path: string; before: string; after: string; isWholeFile: boolean }

/** The file's current text for a Write: '' when it is new, remote or unreadable. */
async function currentText($: EngineInterface, path: string, isRemote: boolean): Promise<string> {
  if (isRemote) return ''
  try {
    return String(await $.fs.read(path))
  } catch {
    return ''
  }
}

const editsOf = (edits: unknown, field: 'old_string' | 'new_string'): string =>
  (Array.isArray(edits) ? edits : []).map(edit => (typeof edit?.[field] === 'string' ? edit[field] : '')).join('\n')

/** The text a file-changing tool call replaces and the text it puts there; undefined for other tools. */
async function changeOf($: EngineInterface, input: Readonly<Record<string, unknown>>): Promise<Change | undefined> {
  const tool = String(input.tool)
  const path = input.file_path ?? input.notebook_path
  if (typeof path !== 'string' || !isScannedFile(path)) return undefined
  if (tool === 'Edit') return { path, before: String(input.old_string ?? ''), after: String(input.new_string ?? ''), isWholeFile: false }
  if (tool === 'MultiEdit') return { path, before: editsOf(input.edits, 'old_string'), after: editsOf(input.edits, 'new_string'), isWholeFile: false }
  if (tool === 'NotebookEdit') return { path, before: '', after: String(input.new_source ?? ''), isWholeFile: false }
  if (tool === 'Write') return { path, before: await currentText($, path, input._host !== undefined), after: String(input.content ?? ''), isWholeFile: true }
  return undefined
}

const listing = (hits: readonly Hit[], isWholeFile: boolean): string => {
  const rows = hits.slice(0, MAX_LISTED).map(hit => {
    const where = isWholeFile ? `line ${hit.line}: ` : ''
    const rule = RULES[hit.rule]
    return `- ${where}${hit.code}\n  -> ${hit.detail ?? rule.title}. ${rule.advice}`
  })
  const more = hits.length > MAX_LISTED ? [`- ...and ${hits.length - MAX_LISTED} more`] : []
  return [...rows, ...more].join('\n')
}

const FOOTER = `If a line is intended (a checksum that is not a security control, a test vector), put "${ALLOW_MARKER}" in a comment on it.`

/** Tells mods-hub what the check found, for mods that listen to `lint.result`; nothing happens without a hub. */
async function publishFindings($: EngineInterface, path: string, errors: number, warnings: number): Promise<void> {
  await hubPublish($, { topic: 'lint.result', data: { tool: 'crypto-guard', errors, warnings, files: [path] } })
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
  await hubHello($, { version: await ownVersion($), publishes: ['lint.result'], consumes: [] })
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await greetHub($)
    return next(e)
  })

  const isBlocking = options.mode === 'block'

  on('tool.call', { tool: /^(?:Edit|MultiEdit|Write|NotebookEdit)$/ }, async ($, e, next) => {
    const change = await changeOf($, e)
    if (change === undefined) return next(e)

    const hits = findWeakCrypto(change.before, change.after)
    if (hits.length === 0) return next(e)

    const shown = listing(hits, change.isWholeFile)
    if (isBlocking) {
      await publishFindings($, change.path, hits.length, 0)
      return { deny: `crypto-guard: blocked, ${change.path} would use weak cryptography:\n${shown}\n${FOOTER}` }
    }

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const name = change.path.split(/[\\/]/).pop() ?? change.path
    await publishFindings($, change.path, 0, hits.length)
    await hubNotify($, { level: 'warning', title: `weak cryptography in ${name}: ${[...new Set(hits.map(hit => RULES[hit.rule].title))].slice(0, 2).join(', ')}` })
    return { ...ran, context: [...(ran.context ?? []), `crypto-guard: this edit added weak cryptography to ${change.path}:\n${shown}\n${FOOTER}`] }
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
