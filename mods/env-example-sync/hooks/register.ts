import type { EngineInterface, Register } from 'claude-code'

import { addedReads, BUILT_IN_IGNORED, isExampleName, listedNames, withNames } from './env'

const WRITE_TOOLS = /^(?:Edit|MultiEdit|Write)$/
const SOURCE_FILE = /\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts|vue|svelte|astro|py|rb|php|go|rs|java|kt|cs)$/i
const SKIPPED_PATH =
  /(^|[\\/])(node_modules|vendor|dist|build|\.git|tests?|__tests__|specs?)[\\/]|\.(?:test|spec)\.|_test\.go$|(^|[\\/])test_[^\\/]*\.py$|_spec\.rb$/
const DEFAULT_FILES = ['.env.example', '.env.sample']
const MAX_LEVELS = 12
const MAX_SHOWN = 6

type Input = Readonly<Record<string, unknown>>
type Settings = { files: readonly string[]; ignored: ReadonlySet<string> }

const dirname = (path: string): string => path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))
const basename = (path: string): string => path.split(/[\\/]/).at(-1) ?? path

/** Every piece of text a write-type call puts in the file, and the text it replaces. */
function textsOf(input: Input): { added: string; replaced: string } {
  const edits: readonly unknown[] = Array.isArray(input.edits) ? input.edits : [input]
  const pick = (field: string) =>
    edits.map(edit => (edit as Record<string, unknown>)[field]).filter((value): value is string => typeof value === 'string').join('\n')
  return typeof input.content === 'string' ? { added: input.content, replaced: '' } : { added: pick('new_string'), replaced: pick('old_string') }
}

/** The example file nearest to the edited file, looking in its folder and each folder above up to the project root. */
async function findExample($: EngineInterface, file: string, files: readonly string[]): Promise<string | undefined> {
  const root = await $.session.root().catch(() => undefined)
  let folder = dirname(file)
  for (let level = 0; level < MAX_LEVELS && folder !== ''; level += 1) {
    for (const name of files) {
      const candidate = `${folder}/${name}`
      if (await $.fs.exists(candidate).catch(() => false)) return candidate
    }
    if (folder === root) break
    folder = dirname(folder)
  }
  return undefined
}

/** Appends the variables missing from the example file; resolves to the ones it added. */
async function syncExample($: EngineInterface, file: string, names: readonly string[], settings: Settings): Promise<{ example: string; added: string[] } | undefined> {
  const example = await findExample($, file, settings.files)
  if (example === undefined) return undefined
  const text = await $.fs.read(example).catch(() => undefined)
  if (text === undefined) return undefined
  const listed = listedNames(text)
  const added = names.filter(name => !listed.has(name))
  if (added.length === 0) return undefined
  await $.fs.write(example, withNames(text, added))
  return { example, added }
}

/** Tells mods-hub what the check found, for mods that listen to `lint.result`; nothing happens without a hub. */
async function publishFindings($: EngineInterface, path: string, errors: number, warnings: number): Promise<void> {
  await hubPublish($, { topic: 'lint.result', data: { tool: 'env-example-sync', errors, warnings, files: [path] } })
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

  const configured = String(options.file ?? '').trim()
  const settings: Settings = {
    files: configured !== '' && isExampleName(basename(configured)) ? [configured] : DEFAULT_FILES,
    ignored: new Set([
      ...BUILT_IN_IGNORED,
      ...String(options.ignore ?? '')
        .split(',')
        .map(name => name.trim())
        .filter(name => name !== ''),
    ]),
  }

  on('tool.call', { tool: WRITE_TOOLS }, async ($, e, next) => {
    const input: Input = e
    const file = input.file_path
    if (typeof file !== 'string' || !SOURCE_FILE.test(file) || SKIPPED_PATH.test(file) || input._host !== undefined) return next(e)

    const { added, replaced } = textsOf(input)
    const before = input.content === undefined ? replaced : await $.fs.read(file).catch(() => '')
    const names = addedReads(before, added, settings.ignored)
    const ran = await next(e)
    if (names.length === 0 || ran.deny !== undefined || ran.isError === true) return ran

    const synced = await syncExample($, file, names, settings).catch(() => undefined)
    if (synced === undefined) return ran
    const shown = synced.added.slice(0, MAX_SHOWN).join(', ') + (synced.added.length > MAX_SHOWN ? ` (+${synced.added.length - MAX_SHOWN})` : '')
    await publishFindings($, synced.example, 0, synced.added.length)
    await hubNotify($, { level: 'info', title: `${basename(synced.example)}: added ${shown}` })
    return {
      ...ran,
      context: [
        ...(ran.context ?? []),
        `env-example-sync: added ${shown} to ${synced.example} with empty values. Give them example values or a comment there if that helps; .env itself was not touched.`,
      ],
    }
  })
}

// #region @vendored shared/hub-client.ts sha256:d76b7319c8a3: edit the source, then run `node scripts/sync-shared.mjs`.
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

/** Routes a notification through the hub (channels, silent, night, presence), or shows a toast when there is no hub. */
async function hubNotify($: EngineInterface, input: Parameters<HubMods['notify']>[0]): Promise<void> {
  try {
    await $.mods.notify(input)
  } catch {
    $.ui.toast(input.body === undefined || input.body === '' ? input.title : `${input.title} — ${input.body}`)
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

/** Whether the shared panel shows tab `id` now; read while drawing, it subscribes the drawing. */
async function hubTabIs($: EngineInterface, id: string): Promise<boolean> {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
  return value === id
}
// #endregion @vendored shared/hub-client.ts
