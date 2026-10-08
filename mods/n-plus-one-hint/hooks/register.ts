import type { EngineInterface, Register } from 'claude-code'

import { ADVICE, findLoopQueries, introduced, isScanned } from './loops'
import type { Hit } from './loops'

const WRITE_TOOLS = /^(?:Edit|MultiEdit|Write)$/
/** Tests, migrations, seeds and vendored code run queries in loops on purpose, or are not ours. */
const SKIPPED_PATH =
  /(^|[\\/])(node_modules|vendor|dist|build|\.git|tests?|__tests__|specs?|migrations?|db[\\/]migrate|seeds?|fixtures)[\\/]|\.(?:test|spec)\.|_test\.go$|(^|[\\/])test_[^\\/]*\.py$|_spec\.rb$|Tests?\.(?:java|cs|kt)$/
const MAX_LISTED = 4

type Input = Readonly<Record<string, unknown>>

const extensionOf = (path: string): string => {
  const name = path.split(/[\\/]/).at(-1) ?? ''
  return name.includes('.') ? (name.split('.').at(-1) ?? '').toLowerCase() : ''
}

/** The file as it will be once the tool has run. */
function resultingText(before: string, input: Input): string {
  if (typeof input.content === 'string') return input.content
  const edits: readonly unknown[] = Array.isArray(input.edits) ? input.edits : [input]
  let text = before
  for (const edit of edits) {
    const { old_string, new_string, replace_all } = edit as Record<string, unknown>
    if (typeof old_string !== 'string' || typeof new_string !== 'string' || old_string === '') continue
    text = replace_all === true ? text.replaceAll(old_string, () => new_string) : text.replace(old_string, () => new_string)
  }
  return text
}

/** Queries in loops that this change introduces: in the file after it, and not already in a loop before it. */
async function addedLoopQueries($: EngineInterface, path: string, input: Input): Promise<Hit[]> {
  const extension = extensionOf(path)
  if (!isScanned(extension) || SKIPPED_PATH.test(path)) return []
  const before = await $.fs.read(path).catch(() => '')
  return introduced(findLoopQueries(before, extension), findLoopQueries(resultingText(before, input), extension))
}

function describe(path: string, hits: readonly Hit[]): string {
  const lines = hits.slice(0, MAX_LISTED).map(({ line, call }) => `  ${path}:${line}  ${call}(...) runs once per iteration`)
  const more = hits.length > MAX_LISTED ? [`  (+${hits.length - MAX_LISTED} more)`] : []
  const advice = [...new Set(hits.map(hit => ADVICE[hit.kind]))].slice(0, 2).map(text => `  Instead: ${text}.`)
  return [`n-plus-one-hint: this edit puts a database query inside a loop, the N+1 pattern (one query per item):`, ...lines, ...more, ...advice].join('\n')
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

/** The hint as a notification through mods-hub when it is installed, a toast otherwise; the hits also go out as `lint.result`. */
async function report($: EngineInterface, path: string, hits: readonly Hit[]): Promise<void> {
  const first = hits[0] as Hit
  await hubNotify($, {
    level: 'info',
    title: `possible N+1 query in ${path.split(/[\\/]/).at(-1)}:${first.line}${hits.length > 1 ? ` (+${hits.length - 1})` : ''}`,
    topic: 'lint.result',
  })
  await hubPublish($, { topic: 'lint.result', data: { tool: 'n-plus-one-hint', errors: 0, warnings: hits.length, files: [path] } })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    afterStart($, 'n-plus-one-hint', () => greetHub($))
    return next(e)
  })

  on('tool.call', { tool: WRITE_TOOLS }, async ($, e, next) => {
    const input: Input = e
    const path = input.file_path
    if (typeof path !== 'string' || input._host !== undefined) return next(e)

    const hits = await addedLoopQueries($, path, input)
    if (hits.length === 0) return next(e)

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    await report($, path, hits)
    return { ...ran, context: [...(ran.context ?? []), describe(path, hits)] }
  })
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
