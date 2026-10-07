import type { EngineInterface, Register } from 'claude-code'

import { newIssues } from './markup'
import type { Issue } from './markup'

const UI_FILE = /\.(?:jsx|tsx|vue|svelte|html?|astro)$/i
const MAX_FILE_BYTES = 400_000
const MAX_LISTED = 8

const basename = (path: string): string => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

/** The file as it is on disk now; empty when it is missing, too big or unreadable. */
async function readCurrent($: EngineInterface, path: string): Promise<string> {
  try {
    const stat = await $.fs.stat(path)
    return stat.kind === 'file' && stat.size <= MAX_FILE_BYTES ? await $.fs.read(path) : ''
  } catch {
    return ''
  }
}

type Change = { before: string; after: string }

/** The file before and after the edit, applied the way the tool would; the bare snippets when the edit cannot be replayed. */
async function changeOf($: EngineInterface, e: { tool: string; file_path: string; content?: unknown; old_string?: unknown; new_string?: unknown; replace_all?: unknown }): Promise<Change> {
  const current = await readCurrent($, e.file_path)
  if (e.tool === 'Write') return { before: current, after: String(e.content ?? '') }

  const oldText = String(e.old_string ?? '')
  const newText = String(e.new_string ?? '')
  if (oldText === '' || !current.includes(oldText)) return { before: oldText, after: newText }
  return { before: current, after: e.replace_all === true ? current.split(oldText).join(newText) : current.replace(oldText, () => newText) }
}

const listOf = (issues: readonly Issue[]): string =>
  [...issues.slice(0, MAX_LISTED).map(issue => `- line ${issue.line}: ${issue.message}`), ...(issues.length > MAX_LISTED ? [`- and ${issues.length - MAX_LISTED} more`] : [])].join('\n')

const countOf = (issues: readonly Issue[]): string => `${issues.length} accessibility issue${issues.length === 1 ? '' : 's'}`

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

/** Tells mods-hub what the check found, for mods that listen to `lint.result`; nothing happens without a hub. */
async function publishFindings($: EngineInterface, path: string, errors: number, warnings: number): Promise<void> {
  await hubPublish($, { topic: 'lint.result', data: { tool: 'a11y-guard', errors, warnings, files: [path] } })
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await greetHub($)
    return next(e)
  })

  const isBlocking = options.mode === 'block'

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    if (!UI_FILE.test(e.file_path) || e._host !== undefined) return next(e)
    const { before, after } = await changeOf($, e)
    // A file this big is generated or vendored: scanning it would stall the edit for no useful answer.
    if (after.length > MAX_FILE_BYTES) return next(e)
    const issues = newIssues(before, after)
    if (issues.length === 0) return next(e)

    const file = basename(e.file_path)
    if (isBlocking) {
      await publishFindings($, e.file_path, issues.length, 0)
      return {
        deny:
          `a11y-guard: blocked, this edit to ${file} adds ${countOf(issues)}:\n${listOf(issues)}\n` +
          'Fix the markup and make the edit again. (The user can set a11y-guard to warn mode to allow such edits.)',
      }
    }

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    await publishFindings($, e.file_path, 0, issues.length)
    await hubNotify($, { level: 'warning', title: `${countOf(issues)} in ${file}` })
    return { ...ran, context: [...(ran.context ?? []), `a11y-guard: this edit to ${e.file_path} adds ${countOf(issues)}:\n${listOf(issues)}\nFix them in a follow-up edit.`] }
  }).catch(($, e, next) => next(e))
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
