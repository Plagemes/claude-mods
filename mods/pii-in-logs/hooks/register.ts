import type { EngineInterface, Register } from 'claude-code'

import { ALLOW_MARKER, findPii, isScannedFile } from './scan'
import type { Finding } from './scan'

const MOD = 'pii-in-logs'
const MAX_LISTED = 5

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
  if (typeof path !== 'string') return undefined
  if (tool === 'Edit') return { path, before: String(input.old_string ?? ''), after: String(input.new_string ?? ''), isWholeFile: false }
  if (tool === 'MultiEdit') return { path, before: editsOf(input.edits, 'old_string'), after: editsOf(input.edits, 'new_string'), isWholeFile: false }
  if (tool === 'NotebookEdit') return { path, before: '', after: String(input.new_source ?? ''), isWholeFile: false }
  if (tool === 'Write') {
    return { path, before: await currentText($, path, input._host !== undefined), after: String(input.content ?? ''), isWholeFile: true }
  }
  return undefined
}

const listing = (findings: readonly Finding[], isWholeFile: boolean): string => {
  const rows = findings.slice(0, MAX_LISTED).map(finding => {
    const where = isWholeFile ? `line ${finding.line}: ` : ''
    return `- ${where}${finding.call}  (prints ${finding.reasons.join(', ')})`
  })
  const more = findings.length > MAX_LISTED ? [`- ...and ${findings.length - MAX_LISTED} more`] : []
  return [...rows, ...more].join('\n')
}

const ADVICE =
  'Log an id or a masked value instead (for example the last 4 characters, or a hash), or leave the value out. ' +
  `If this is intended, put "${ALLOW_MARKER}" in a comment on that line.`

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
  await hubHello($, { version: await ownVersion($), publishes: ['secret.detected', 'lint.result', 'risk.blocked'], consumes: [] })
}

/**
 * Tells mods-hub (when installed) what an edit's log statements print: `secret.detected` (kind `log-statement`),
 * and `risk.blocked` when it was refused or `lint.result` (warnings) when it went through. Never the values.
 */
async function announce($: EngineInterface, tool: string, path: string, findings: readonly Finding[], isBlocked: boolean): Promise<void> {
  await hubPublish($, { topic: 'secret.detected', data: { kind: 'log-statement', where: 'edit', action: isBlocked ? 'blocked' : 'warned', path } })
  if (isBlocked) {
    const what = [...new Set(findings.flatMap(finding => finding.reasons))].slice(0, MAX_LISTED).join(', ')
    await hubPublish($, { topic: 'risk.blocked', data: { guard: MOD, tool, reason: `pii-log: log statements would print ${what}`, severity: 'medium', path } })
  } else {
    await hubPublish($, { topic: 'lint.result', data: { tool: MOD, errors: 0, warnings: findings.length, files: [path] } })
  }
}

export const register: Register = (on, options) => {
  const isBlocking = options.mode === 'block'

  on('session.start', async ($, e, next) => {
    await greetHub($)
    return next(e)
  })

  on('tool.call', { tool: /^(?:Edit|MultiEdit|Write|NotebookEdit)$/ }, async ($, e, next) => {
    const change = await changeOf($, e)
    if (change === undefined || !isScannedFile(change.path)) return next(e)

    const findings = findPii(change.before, change.after)
    if (findings.length === 0) return next(e)

    const shown = listing(findings, change.isWholeFile)
    if (isBlocking) {
      await announce($, String(e.tool), change.path, findings, true)
      return { deny: `${MOD}: blocked, ${change.path} would log personal data or secrets:\n${shown}\n${ADVICE}` }
    }

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const name = change.path.split(/[\\/]/).pop() ?? change.path
    await announce($, String(e.tool), change.path, findings, false)
    // `warning`: it reaches your phone channel while you are away (a toast when there is no hub).
    await hubNotify($, { level: 'warning', title: `${findings.length} log statement${findings.length === 1 ? '' : 's'} in ${name} may print personal data or secrets`, topic: 'secret.detected' })
    return { ...ran, context: [...(ran.context ?? []), `${MOD}: this edit added ${findings.length === 1 ? 'a log statement' : 'log statements'} to ${change.path} that may print personal data or secrets:\n${shown}\n${ADVICE}`] }
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
