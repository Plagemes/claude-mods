import type { EngineInterface, Register } from 'claude-code'

import { addedFindings, describeFinding, fileKindOf, findHardCoded } from './scan'
import type { Finding } from './scan'

const DEFAULT_ATTRIBUTES = 'title,placeholder,aria-label,alt'
const MAX_LISTED = 6

const parseAttributes = (value: unknown): Set<string> =>
  new Set(
    (typeof value === 'string' && value.trim() !== '' ? value : DEFAULT_ATTRIBUTES)
      .split(',')
      .map(name => name.trim().toLowerCase())
      .filter(name => name !== ''),
  )

const listFindings = (found: readonly Finding[]): string => {
  const listed = found.slice(0, MAX_LISTED).map(describeFinding).join(', ')
  return found.length > MAX_LISTED ? `${listed}, +${found.length - MAX_LISTED} more` : listed
}

const baseName = (path: string): string => path.split(/[\\/]/).at(-1) ?? path

// What a Write replaces: the file's current text, or nothing for a new file.
const currentText = async ($: EngineInterface, path: string): Promise<string> => {
  try {
    return await $.fs.read(path)
  } catch {
    return ''
  }
}

/** Tells mods-hub what the check found, for mods that listen to `lint.result`; nothing happens without a hub. */
async function publishFindings($: EngineInterface, path: string, errors: number, warnings: number): Promise<void> {
  await hubPublish($, { topic: 'lint.result', data: { tool: 'i18n-guard', errors, warnings, files: [path] } })
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

  const attributes = parseAttributes(options.attributes)
  const isBlocking = options.mode === 'block'

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const kind = fileKindOf(e.file_path)
    if (kind === undefined) return next(e)

    // Only strings the change adds count: those already in the file are not this edit's to fix.
    const found =
      e.tool === 'Write'
        ? addedFindings(findHardCoded(await currentText($, e.file_path), kind, attributes, true), findHardCoded(e.content, kind, attributes, true))
        : addedFindings(findHardCoded(e.old_string, kind, attributes, false), findHardCoded(e.new_string, kind, attributes, false))
    if (found.length === 0) return next(e)

    const file = baseName(e.file_path)
    if (isBlocking) {
      await publishFindings($, e.file_path, found.length, 0)
      return {
        deny: `i18n-guard: hard-coded user-facing strings in ${file}: ${listFindings(found)}. Render them with the project's i18n function (for example t('key')), add the keys to the translation files, then retry.`,
      }
    }

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    await publishFindings($, e.file_path, 0, found.length)
    await hubNotify($, { level: 'warning', title: `${found.length} hard-coded string${found.length === 1 ? '' : 's'} in ${file}` })
    const note = `i18n-guard: ${file} now has hard-coded user-facing strings: ${listFindings(found)}. Move them into the translation files and render them with the project's i18n function (for example t('key')).`
    return { ...ran, context: [...(ran.context ?? []), note] }
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
