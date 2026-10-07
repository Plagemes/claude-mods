import type { EngineInterface, Register } from 'claude-code'

import { findLeaks, introducedLeaks } from './scan'

const WRITE_TOOLS = /^(?:Edit|MultiEdit|Write)$/
const CODE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/i
/** Code nobody edits for its leaks: dependencies, build output, tests and mocks. */
const NOT_CHECKED = /(?:^|[\\/])(?:node_modules|dist|build|coverage|\.next|\.nuxt|__tests__|__mocks__|vendor)[\\/]|\.(?:test|spec|stories|d|min)\.[cm]?[jt]sx?$/i
const MAX_FILE_CHARS = 400_000
const MAX_REPORTED = 3
const MAX_TOAST_MESSAGE = 90

const compile = (source: string): RegExp | undefined => {
  try {
    return source === '' ? undefined : new RegExp(source)
  } catch {
    return undefined
  }
}

const readCode = ($: EngineInterface, path: string): Promise<string | undefined> =>
  $.fs.read(path).then(
    text => (text.length > MAX_FILE_CHARS ? undefined : text),
    () => undefined,
  )

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** Tells mods-hub what the check found, for mods that listen to `lint.result`; nothing happens without a hub. */
async function publishFindings($: EngineInterface, path: string, errors: number, warnings: number): Promise<void> {
  await hubPublish($, { topic: 'lint.result', data: { tool: 'leak-hint', errors, warnings, files: [path] } })
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

  const ignore = compile(String(options.ignore ?? ''))

  on('tool.call', { tool: WRITE_TOOLS }, async ($, e, next) => {
    const input: Readonly<Record<string, unknown>> = e
    const path = typeof input.file_path === 'string' ? input.file_path : ''
    if (!CODE_FILE.test(path) || NOT_CHECKED.test(path) || ignore?.test(path) === true) return next(e)

    // What the file said before the edit tells what the edit brought in, and what was already there.
    const before = (await readCode($, path)) ?? ''
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    const after = await readCode($, path)
    if (after === undefined) return ran
    const found = introducedLeaks(findLeaks(before), findLeaks(after))
    const [first] = found
    if (first === undefined) return ran

    const name = path.split(/[\\/]/).at(-1) ?? path
    const more = found.length > 1 ? ` (+${found.length - 1} more)` : ''
    await publishFindings($, path, 0, found.length)
    await hubNotify($, { level: 'info', title: `possible leak in ${name}:${first.line}${more}: ${clip(first.message, MAX_TOAST_MESSAGE)}` })

    const lines = found.slice(0, MAX_REPORTED).map(leak => `- line ${leak.line}: ${leak.message}`)
    const note = [
      `leak-hint: this edit to ${path} may have introduced a leak (found by pattern, so check it):`,
      ...lines,
      ...(found.length > MAX_REPORTED ? [`- (+${found.length - MAX_REPORTED} more)`] : []),
      'If it is real, add the cleanup now; if the listener has to live as long as the page, say so in a comment.',
    ].join('\n')
    return { ...ran, context: [...(ran.context ?? []), note] }
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
