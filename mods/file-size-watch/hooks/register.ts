import type { EngineInterface, Register } from 'claude-code'

const DEFAULT_MAX_LINES = 500
const NOT_CODE =
  /\.(json|lock|lockb|map|svg|csv|tsv|snap|log|txt|md|mdx)$|\.min\.(js|css)$|\.generated\./

/** Lines in `text`, a final newline not starting a new one. */
const lineCount = (text: string): number =>
  text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)

/** Lines of the file on disk; 0 when it is missing or cannot be read. */
const linesOf = async ($: EngineInterface, path: string): Promise<number> => {
  try {
    return lineCount(await $.fs.read(path))
  } catch {
    return 0
  }
}

/** Tells mods-hub what the check found, for mods that listen to `lint.result`; nothing happens without a hub. */
async function publishFindings($: EngineInterface, path: string, errors: number, warnings: number): Promise<void> {
  await hubPublish($, { topic: 'lint.result', data: { tool: 'file-size-watch', errors, warnings, files: [path] } })
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

  const limit = typeof options.maxLines === 'number' ? options.maxLines : DEFAULT_MAX_LINES
  const toasted = new Set<string>()

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    if (e._host !== undefined || NOT_CODE.test(e.file_path)) return next(e)

    // An Edit says by itself whether it adds lines; only a Write needs the old file read.
    const isGrowing =
      e.tool === 'Edit'
        ? lineCount(e.new_string) > lineCount(e.old_string)
        : lineCount(e.content) > (await linesOf($, e.file_path))
    if (!isGrowing) return next(e)

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran

    const lines = e.tool === 'Write' ? lineCount(e.content) : await linesOf($, e.file_path)
    if (lines <= limit) return ran

    if (!toasted.has(e.file_path)) {
      toasted.add(e.file_path)
      await publishFindings($, e.file_path, 0, 1)
      await hubNotify($, { level: 'info', title: `${e.file_path.split('/').pop()} is ${lines} lines. Consider splitting it.` })
    }
    const note =
      `file-size-watch: ${e.file_path} is now ${lines} lines (limit ${limit}) and this edit made it longer. ` +
      `Before adding more to it, consider splitting it into smaller modules by responsibility.`
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
