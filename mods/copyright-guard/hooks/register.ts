import type { EngineInterface, Register } from 'claude-code'

import { changesOf, describeProject, isForeign, isNoticeHome, mergeProject, noticesIn, parseLicenseText, parsePackageJson } from './notices'
import type { Notice, Project } from './notices'

const WRITE_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit)$/
const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'COPYING', 'COPYING.md']
const PROJECT_CACHE_MS = 60_000
const MAX_REPORTED = 3
const TOAST_NOTICE_LENGTH = 60

type ProjectCache = { project: Project | undefined; at: number }

const readText = ($: EngineInterface, path: string): Promise<string | undefined> => $.fs.read(path).catch(() => undefined)

/** The license and holders LICENSE and package.json give the project, read again at most once a minute. */
const projectOf = async ($: EngineInterface, cache: ProjectCache, allow: readonly string[]): Promise<Project> => {
  const now = await $.clock.now()
  if (cache.project !== undefined && now - cache.at < PROJECT_CACHE_MS) return cache.project

  const root = await $.session.root()
  const licenseTexts = await Promise.all(LICENSE_FILES.map(name => readText($, `${root}/${name}`)))
  const license = licenseTexts.find(text => text !== undefined)
  const manifest = await readText($, `${root}/package.json`)

  cache.project = mergeProject(
    [...(license === undefined ? [] : [parseLicenseText(license)]), ...(manifest === undefined ? [] : [parsePackageJson(manifest)])],
    allow,
  )
  cache.at = now
  return cache.project
}

const message = (path: string, project: Project, found: readonly Notice[]): string =>
  [
    `copyright-guard: ${path} now holds a license or copyright notice that does not match this project (${describeProject(project)}):`,
    ...found.slice(0, MAX_REPORTED).map(notice => `- ${notice.text}`),
    ...(found.length > MAX_REPORTED ? [`- (+${found.length - MAX_REPORTED} more)`] : []),
    'If this text was copied from another project, check that its license lets you use it here, keep its notice, and tell the user where it came from.',
    "If you wrote the notice yourself, remove it or make it match the project's.",
  ].join('\n')

/** Tells mods-hub what the check found, for mods that listen to `lint.result`; nothing happens without a hub. */
async function publishFindings($: EngineInterface, path: string, errors: number, warnings: number): Promise<void> {
  await hubPublish($, { topic: 'lint.result', data: { tool: 'copyright-guard', errors, warnings, files: [path] } })
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

  const allow = String(options.allow ?? '')
    .split(',')
    .map(term => term.trim())
    .filter(term => term !== '')
  const cache: ProjectCache = { project: undefined, at: 0 }

  on('tool.call', { tool: WRITE_TOOLS }, async ($, e, next) => {
    const input: Readonly<Record<string, unknown>> = e
    const path = String(input.file_path ?? input.notebook_path ?? '')
    if (path === '' || isNoticeHome(path)) return next(e)

    // A Write replaces the whole file, so what was there is read first: its own notices are not news.
    const existing = typeof input.content === 'string' ? ((await readText($, path)) ?? '') : ''
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    const added = changesOf(input, existing).flatMap(noticesIn)
    if (added.length === 0) return ran
    const project = await projectOf($, cache, allow)
    const foreign = added.filter(notice => isForeign(notice, project))
    if (foreign.length === 0) return ran

    const first = foreign[0]?.text ?? ''
    const shown = first.length > TOAST_NOTICE_LENGTH ? `${first.slice(0, TOAST_NOTICE_LENGTH - 1)}…` : first
    await publishFindings($, path, 0, foreign.length)
    await hubNotify($, { level: 'warning', title: `other license in ${path.split(/[\\/]/).at(-1)}: ${shown}` })
    return { ...ran, context: [...(ran.context ?? []), message(path, project, foreign)] }
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
