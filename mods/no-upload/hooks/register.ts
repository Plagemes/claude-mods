import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import { UPLOAD_HINT, blockedUploads } from './upload'
import type { Upload } from './upload'
import { redactSummary } from './shared/secrets'

const MOD = 'no-upload'

const DEFAULT_ALLOW_WORD = 'UPLOAD-OK'
const MAX_SHOWN = 100
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])

const isPerson = (origin: PromptOrigin): boolean =>
  PERSON_ORIGINS.has(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)

const shorten = (command: string): string => {
  const line = command.trim().replace(/\s+/g, ' ')
  return line.length > MAX_SHOWN ? `${line.slice(0, MAX_SHOWN - 1)}…` : line
}

const denial = (command: string, uploads: readonly Upload[], allowWord: string): string => {
  const targets = uploads.map(upload => `${upload.host} (${upload.how})`).join(', ')
  const first = uploads[0]?.host ?? ''
  const word = allowWord === '' ? '' : `by writing ${allowWord} in their next message, or `
  return (
    `${MOD}: blocked \`${shorten(command)}\`. It would send data to ${targets}, which is not on the allowed list. ` +
    "Do not upload files or text to outside services without the user's explicit OK: tell them what you wanted to send and where, and ask. " +
    `They can approve it ${word}by adding "${first}" to the allowed hosts in this mod's settings.`
  )
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
  await hubHello($, { version: await ownVersion($), publishes: ['risk.blocked'], consumes: [] })
}

/** Tells mods-hub (when installed) what was blocked, the command masked and cut short. The deny never waits on it. */
async function reportBlock($: EngineInterface, uploads: readonly Upload[], command: string): Promise<void> {
  const targets = uploads.map(upload => `${upload.host} (${upload.how})`).join(', ')
  await hubPublish($, { topic: 'risk.blocked', data: { guard: MOD, tool: 'Bash', reason: `upload: would send data to ${targets}`, severity: 'medium', command: redactSummary(command) } })
}

export const register: Register = (on, options) => {
  const allowed = new Set(String(options.allowHosts ?? '').split(',').map(host => host.trim().toLowerCase()).filter(host => host !== ''))
  const allowWord = typeof options.allowWord === 'string' ? options.allowWord.trim() : DEFAULT_ALLOW_WORD
  let isAllowed = false

  on('prompt.submit', ($, e, next) => {
    if (isPerson(e.origin)) isAllowed = allowWord !== '' && e.text.includes(allowWord)
    // A turn nobody typed (a notification, a schedule, a peer) starts without the approval of an earlier prompt.
    else if (e.turnId === undefined) isAllowed = false
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await greetHub($)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (isAllowed) return next(e)
    const uploads = blockedUploads(e.command, allowed)
    if (uploads.length === 0) return next(e)
    await reportBlock($, uploads, e.command)
    return { deny: denial(e.command, uploads, allowWord) }
  }).catch(($, e, next) =>
    next.called || !('command' in e) || !UPLOAD_HINT.test(e.command) ? next(e) : { deny: `${MOD}: its check failed, so this command was blocked.` },
  )
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
