import type { EngineInterface, FsEntry, Register } from 'claude-code'

import { findStyleFindings, styleBlocksOnly } from './stylesheet'
import { findClassFindings } from './tailwind'
import type { Finding } from './tailwind'

const MARKUP_FILE = /\.(?:jsx|tsx|vue|svelte|html?|astro)$/i
const STYLE_FILE = /\.(?:css|scss|sass|less)$/i
const EMBEDS_STYLES = /\.(?:vue|svelte|html?|astro)$/i
const NOT_CHECKED = /(?:\.(?:test|spec|stories)\.|(?:^|\/)node_modules\/)/
/** Signs that a project has a dark theme: media query, theme attribute or class, Tailwind's darkMode or dark: variants. */
const DARK_SUPPORT =
  /prefers-color-scheme\s*:\s*dark|\[data-(?:bs-)?(?:theme|mode)\s*=\s*["']?dark|(?:^|[\s,}>])\.dark(?![\w-])|\bdarkMode\s*:|@custom-variant\s+dark|color-scheme\s*:[^;]*\bdark\b|\bnext-themes\b|\bdark:[\w[-]/
const OPT_OUT = 'dark-ok'
const SEARCH_FOLDERS = ['', 'src', 'app', 'src/app', 'styles', 'src/styles', 'src/assets']
const SEARCH_FILE = /^(?:tailwind\.config\.(?:js|ts|cjs|mjs)|package\.json|[\w.-]+\.(?:css|scss|sass|less))$/i
const MAX_SEARCH_BYTES = 200_000
const MAX_FILE_BYTES = 400_000
const MAX_FILES_PER_FOLDER = 12
const CACHE_MS = 60_000
const MAX_LISTED = 8

type Cache = { at: number; isSupported: boolean }
type Change = { before: string; after: string }

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** Lines marked dark-ok are left out (kept empty, so line numbers stay). */
const withoutOptOuts = (text: string): string => text.split('\n').map(line => (line.includes(OPT_OUT) ? '' : line)).join('\n')

async function readCurrent($: EngineInterface, path: string): Promise<string> {
  try {
    const stat = await $.fs.stat(path)
    return stat.kind === 'file' && stat.size <= MAX_FILE_BYTES ? await $.fs.read(path) : ''
  } catch {
    return ''
  }
}

/** The file before and after the edit, applied the way the tool would; the bare snippets when the edit cannot be replayed. */
async function changeOf($: EngineInterface, e: { tool: string; file_path: string; content?: unknown; old_string?: unknown; new_string?: unknown; replace_all?: unknown }): Promise<Change> {
  const current = await readCurrent($, e.file_path)
  if (e.tool === 'Write') return { before: current, after: String(e.content ?? '') }
  const oldText = String(e.old_string ?? '')
  const newText = String(e.new_string ?? '')
  if (oldText === '' || !current.includes(oldText)) return { before: oldText, after: newText }
  return { before: current, after: e.replace_all === true ? current.split(oldText).join(newText) : current.replace(oldText, () => newText) }
}

/** Findings of `after` that `before` did not have (a multiset difference by key). */
const added = (before: readonly Finding[], after: readonly Finding[]): Finding[] => {
  const available = new Map<string, number>()
  for (const finding of before) available.set(finding.key, (available.get(finding.key) ?? 0) + 1)
  return after.filter(finding => {
    const left = available.get(finding.key) ?? 0
    available.set(finding.key, left - 1)
    return left <= 0
  })
}

const findingsOf = (path: string, { before, after }: Change): Finding[] => {
  const [oldText, newText] = [withoutOptOuts(before), withoutOptOuts(after)]
  const isEmbedded = EMBEDS_STYLES.test(path)
  return [
    ...(MARKUP_FILE.test(path) ? added(findClassFindings(oldText), findClassFindings(newText)) : []),
    ...(STYLE_FILE.test(path) || isEmbedded
      ? added(findStyleFindings(isEmbedded ? styleBlocksOnly(oldText) : oldText), findStyleFindings(isEmbedded ? styleBlocksOnly(newText) : newText))
      : []),
  ]
}

/** Does the project have a dark theme? Looks in Tailwind's config, package.json and the global style sheets, at most once a minute. */
async function projectHasDarkMode($: EngineInterface, cache: Cache): Promise<boolean> {
  const now = await $.clock.now()
  if (now - cache.at < CACHE_MS) return cache.isSupported
  const root = ((await $.session.repo())?.root ?? (await $.session.cwd())).replace(/\/+$/, '')

  let isSupported = false
  for (const folder of SEARCH_FOLDERS) {
    if (isSupported) break
    const path = folder === '' ? root : `${root}/${folder}`
    let entries: FsEntry[]
    try {
      entries = await $.fs.list(path)
    } catch {
      continue
    }
    for (const entry of entries.filter(entry => entry.kind === 'file' && SEARCH_FILE.test(entry.name) && entry.size <= MAX_SEARCH_BYTES).slice(0, MAX_FILES_PER_FOLDER)) {
      try {
        isSupported = DARK_SUPPORT.test(await $.fs.read(`${path}/${entry.name}`))
      } catch {
        isSupported = false
      }
      if (isSupported) break
    }
  }
  cache.at = now
  cache.isSupported = isSupported
  return isSupported
}

const listOf = (findings: readonly Finding[]): string =>
  [
    ...findings.slice(0, MAX_LISTED).map(finding => `- line ${finding.line}: ${finding.text} -> ${finding.advice}`),
    ...(findings.length > MAX_LISTED ? [`- and ${findings.length - MAX_LISTED} more`] : []),
  ].join('\n')

/** Tells mods-hub what the check found, for mods that listen to `lint.result`; nothing happens without a hub. */
async function publishFindings($: EngineInterface, path: string, errors: number, warnings: number): Promise<void> {
  await hubPublish($, { topic: 'lint.result', data: { tool: 'dark-mode-check', errors, warnings, files: [path] } })
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    afterStart($, 'dark-mode-check', () => greetHub($))
    return next(e)
  })

  const cache: Cache = { at: Number.NEGATIVE_INFINITY, isSupported: false }

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const path = e.file_path
    if (!(MARKUP_FILE.test(path) || STYLE_FILE.test(path)) || NOT_CHECKED.test(path) || e._host !== undefined) return next(e)

    const change = await changeOf($, e)
    const findings = findingsOf(path, change)
    // The cheap analysis comes first: the project is only searched for a dark theme when something was found.
    if (findings.length === 0 || !(DARK_SUPPORT.test(change.after) || (await projectHasDarkMode($, cache)))) return next(e)

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const colors = findings.reduce((sum, finding) => sum + finding.count, 0)
    await publishFindings($, path, 0, colors)
    await hubNotify($, { level: 'info', title: `${colors} color${colors === 1 ? '' : 's'} without a dark variant in ${basename(path)}` })
    const note =
      `dark-mode-check: this project supports dark mode, but this edit to ${path} adds colors with no dark variant:\n${listOf(findings)}\n` +
      `Add the dark counterparts, or use colors the dark theme redefines. Put "${OPT_OUT}" on a line where a light-only color is intended.`
    return { ...ran, context: [...(ran.context ?? []), note] }
  }).catch(($, e, next) => next(e))
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
