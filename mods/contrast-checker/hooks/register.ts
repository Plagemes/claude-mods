import type { EngineInterface, Register, ToolCallInput } from 'claude-code'

import { analyze, isChecked, report } from './analyze'
import type { Level, Range } from './analyze'
import { ratioText } from './color'

const MAX_FILE_CHARS = 400_000
const MAX_RANGES = 20
const EDIT_TOOLS = /^(?:Edit|MultiEdit|Write)$/
const SKIPPED_PATH = /(?:^|[\\/])(?:node_modules|dist|build|\.next|vendor|coverage)[\\/]/

/** Where `needle` stands in `text`, every time (an edit's new text may land anywhere it occurs). */
const occurrences = (text: string, needle: string): Range[] => {
  const ranges: Range[] = []
  for (let at = text.indexOf(needle); at !== -1 && ranges.length < MAX_RANGES; at = text.indexOf(needle, at + Math.max(1, needle.length))) {
    ranges.push({ start: at, end: at + needle.length })
  }
  return ranges
}

/** The stretches an edit wrote: everything for Write, each new string for Edit and MultiEdit. */
const writtenRanges = (e: ToolCallInput, text: string): Range[] | 'all' => {
  if (String(e.tool) === 'Write') return 'all'
  const strings: unknown[] = 'new_string' in e ? [e.new_string] : 'edits' in e && Array.isArray(e.edits) ? e.edits.map((edit: { new_string?: unknown }) => edit.new_string) : []
  return strings.flatMap(value => (typeof value === 'string' && value.trim() !== '' ? occurrences(text, value) : []))
}

/** Tells mods-hub what the check found, for mods that listen to `lint.result`; nothing happens without a hub. */
async function publishFindings($: EngineInterface, path: string, errors: number, warnings: number): Promise<void> {
  await hubPublish($, { topic: 'lint.result', data: { tool: 'contrast-checker', errors, warnings, files: [path] } })
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

  const level: Level = options.level === 'AAA' ? 'AAA' : 'AA'

  on('tool.call', { tool: EDIT_TOOLS }, async ($, e, next) => {
    const ran = await next(e)
    const path = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : ''
    if (ran.deny !== undefined || ran.isError === true || !isChecked(path) || SKIPPED_PATH.test(path)) return ran
    try {
      const text = await $.fs.read(path)
      if (typeof text !== 'string' || text.length > MAX_FILE_CHARS) return ran
      const ranges = writtenRanges(e, text)
      if (ranges !== 'all' && ranges.length === 0) return ran
      const issues = analyze(path, text, ranges, level)
      if (issues.length === 0) return ran
      const file = path.split(/[\\/]/).pop() ?? path
      const lowest = Math.min(...issues.map(issue => issue.ratio))
      await publishFindings($, path, 0, issues.length)
      await hubNotify($, { level: 'warning', title: `⚠ ${issues.length} contrast issue${issues.length === 1 ? '' : 's'} in ${file} (lowest ${ratioText(lowest)}, WCAG ${level})` })
      return { ...ran, context: [...(ran.context ?? []), report(path, issues, level)] }
    } catch (error) {
      $.ui.log(`contrast-checker: could not check ${path}: ${String(error)}`, { to: 'debug' })
      return ran
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
