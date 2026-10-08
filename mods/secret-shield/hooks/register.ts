import type { EngineInterface, Register } from 'claude-code'

import { findLeaks, isTemplatePath, type Finding } from './scan'
import { redactSummary } from './shared/secrets'

const MOD = 'secret-shield'
const WRITE_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit)$/
const MAX_REPORTED = 3

function compile(source: string): RegExp | undefined {
  try {
    return source === '' ? undefined : new RegExp(source)
  } catch {
    return undefined
  }
}

/** Every piece of new text a write-type tool call would put on disk. */
function addedTexts(input: Readonly<Record<string, unknown>>): string[] {
  const texts = [input.new_string, input.content, input.new_source]
  const edits = Array.isArray(input.edits) ? input.edits : []
  for (const edit of edits) {
    if (typeof edit === 'object' && edit !== null) texts.push((edit as Record<string, unknown>).new_string)
  }
  return texts.filter((text): text is string => typeof text === 'string')
}

function targetPath(input: Readonly<Record<string, unknown>>): string {
  const path = input.file_path ?? input.notebook_path
  return typeof path === 'string' ? path : 'file'
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
  await hubHello($, { version: await ownVersion($), publishes: ['risk.blocked', 'secret.detected'], consumes: [] })
}

/** Tells mods-hub (when installed) what was refused: one `secret.detected` per kind, and the `risk.blocked`. Never the value. */
async function reportBlock($: EngineInterface, tool: string, path: string, findings: readonly Finding[]): Promise<void> {
  const shownPath = redactSummary(path)
  for (const kind of new Set(findings.map(finding => finding.kind))) {
    await hubPublish($, { topic: 'secret.detected', data: { kind, where: 'edit', action: 'blocked', path: shownPath } })
  }
  const what = [...new Set(findings.map(finding => finding.pattern))].join(', ')
  await hubPublish($, { topic: 'risk.blocked', data: { guard: MOD, tool, reason: `secret-in-file: ${what}`, severity: 'high', path: shownPath } })
}

export const register: Register = (on, options) => {
  const allowlist = compile(String(options.allowlist ?? ''))

  on('session.start', async ($, e, next) => {
    afterStart($, 'secret-shield', () => greetHub($))
    return next(e)
  })

  on('tool.call', { tool: WRITE_TOOLS }, async ($, e, next) => {
    const path = targetPath(e)
    if (allowlist?.test(path) === true) return next(e)
    const findings = addedTexts(e).flatMap(text => findLeaks(text, allowlist, isTemplatePath(path)))

    if (findings.length === 0) return next(e)
    await reportBlock($, String(e.tool), path, findings)

    const lines = findings
      .slice(0, MAX_REPORTED)
      .map(f => `  line ${f.line}: ${f.pattern} -> ${f.preview}`)
      .join('\n')
    const more = findings.length > MAX_REPORTED ? `\n  (+${findings.length - MAX_REPORTED} more)` : ''
    return {
      deny: `${MOD}: refusing to write ${path}; it looks like it contains a secret.\n${lines}${more}\nUse an environment variable or a secret manager and reference it by name.`,
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${MOD}: its scan failed, so the write was blocked.` }))
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
