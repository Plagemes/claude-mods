import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PermissionLogEntry } from '../types'

const KEPT = 200
const SHOWN = 50
const MAX_SUMMARY_LENGTH = 100
const MAX_REASON_LENGTH = 200
/** Claude Code's wording when the person answers "no" at a permission prompt. */
const PROMPT_REJECTION = /^The user doesn't want to proceed/
const SUMMARY_FIELDS = ['command', 'file_path', 'notebook_path', 'url', 'query', 'pattern', 'path', 'prompt', 'description']

const denied = atom({ plugin: 'permission-log', key: 'denied' } as const, [])

const clockTime = (ms: number): string => {
  const date = new Date(ms)
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

const cut = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}...` : flat
}

/** What a call was about: its command, path, URL or query, else its arguments as JSON. */
const summarize = (args: unknown): string => {
  if (typeof args !== 'object' || args === null) return ''
  const fields = args as Record<string, unknown>
  const field = SUMMARY_FIELDS.find(name => typeof fields[name] === 'string')
  return cut(field === undefined ? JSON.stringify(args) : String(fields[field]), MAX_SUMMARY_LENGTH)
}

const statusLine = (count: number): string | undefined => (count > 0 ? `⛔ ${count} denied` : undefined)

const record = async ($: EngineInterface, call: { id?: string; tool: string; args: unknown; reason: string }) => {
  const at = await $.clock.now()
  const entry: PermissionLogEntry = {
    id: call.id ?? String(at),
    at,
    tool: call.tool,
    summary: summarize(call.args),
    reason: cut(call.reason, MAX_REASON_LENGTH),
  }
  const kept = await update($, denied, list =>
    list.some(known => known.id === entry.id) ? list : [...list, entry].slice(-KEPT),
  )
  $.ui.status(statusLine(kept.length))
}

/** A guard's `risk.blocked` on mods-hub's bus (only what this mod reads). */
type Blocked = { guard: string; tool: string; severity: string; reason: string; subject: string; at: number }

const rows = (entry: PermissionLogEntry, blocked?: Blocked): string[] => [
  `${clockTime(entry.at)}  ${entry.tool}  ${entry.summary}`,
  `          why: ${blocked === undefined ? '' : `[${blocked.guard} · ${blocked.severity}] `}${entry.reason}`,
]

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
const ownVersion = async ($: EngineInterface): Promise<string> => {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Says hello to mods-hub when it is installed. */
const greetHub = async ($: EngineInterface): Promise<void> => {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: ['risk.blocked'] })
}

/** The guards' reports on mods-hub's bus this session (`risk.blocked`), oldest first; none without the hub. */
const blockedOnHub = async ($: EngineInterface): Promise<Blocked[]> => {
  try {
    return (await $.mods.recent({ topic: 'risk.blocked', limit: KEPT })).map(event => {
      const data = event.data as Record<string, unknown>
      const text = (key: string): string => (typeof data[key] === 'string' ? String(data[key]) : '')
      return { guard: text('guard') || event.source, tool: text('tool'), severity: text('severity'), reason: text('reason'), subject: cut(text('command') || text('path'), MAX_SUMMARY_LENGTH), at: event.at }
    })
  } catch {
    return []
  }
}

/** The guard report that goes with a logged refusal: same tool, same command or path. */
const reportOf = (entry: PermissionLogEntry, reports: readonly Blocked[]): Blocked | undefined =>
  reports.find(report => report.tool === entry.tool && report.subject !== '' && (entry.summary.startsWith(report.subject) || report.subject.startsWith(entry.summary)))

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await registerCommand($, {
      name: 'denied',
      description: 'Lists the tool calls that were denied this session, and why.',
      argumentHint: '[clear]',
    })
    $.ui.status(statusLine((await read($, denied)).length))
    afterStart($, 'permission-log', () => greetHub($))
    return next(e)
  })

  // A refusal from a plugin's guard, or the person's "no" at the permission prompt.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const reason =
      ran.deny ?? (ran.isError && PROMPT_REJECTION.test(ran.text ?? '') ? 'Rejected by you at the permission prompt.' : undefined)
    if (reason !== undefined) await record($, { id: e.tool_use_id, tool: e.tool, args: e, reason })
    return ran
  })

  // The engine's own verdict: a deny rule, the permission mode, or a settings hook.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (e.tool_use_id !== undefined && verdict.decision === 'deny') {
      const rule = verdict.rule === undefined ? '' : ` (rule ${verdict.rule})`
      await record($, { id: e.tool_use_id, tool: e.tool, args: e.input, reason: `${verdict.reason ?? 'Denied by permissions.'}${rule}` })
    }
    return verdict
  })

  on('command.run', { command: 'denied' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await update($, denied, () => [])
      $.ui.status(undefined)
      return { text: 'Cleared the denied-call log.' }
    }

    const all = await read($, denied)
    // With mods-hub: which guard refused each call and how serious it is, and what guards reported without a refusal here.
    const reports = await blockedOnHub($)
    const matched = new Set<Blocked>()
    const lines = all.slice(-SHOWN).flatMap(entry => {
      const report = reportOf(entry, reports)
      if (report !== undefined) matched.add(report)
      return rows(entry, report)
    })
    const others = reports.filter(report => !matched.has(report)).slice(-SHOWN)
    const elsewhere =
      others.length === 0
        ? []
        : ['', `Also reported by guards (mods-hub):`, ...others.map(report => `${clockTime(report.at)}  ${report.tool}  ${report.subject}\n          why: [${report.guard} · ${report.severity}] ${cut(report.reason, MAX_REASON_LENGTH)}`)]
    if (all.length === 0 && others.length === 0) return { text: 'No tool call has been denied this session.' }

    const heading = `${all.length} denied tool call${all.length === 1 ? '' : 's'} (newest last)`
    return { text: [heading, '', ...lines, ...elsewhere].join('\n') }
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
