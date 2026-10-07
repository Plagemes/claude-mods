import type { EngineInterface, Register } from 'claude-code'

import { redactSummary } from './shared/secrets'

const MOD = 'main-branch-warn'
const EDIT_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit)$/
const TOAST_MS = 8000
const GIT_TIMEOUT_MS = 3000
const MAX_PARENT_STEPS = 12

function parentOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (cut < 0) return ''
  return cut === 0 ? '/' : path.slice(0, cut)
}

/** The nearest directory that exists at or above `dir`: a Write may create folders that are not there yet. */
async function existingDirectory($: EngineInterface, dir: string): Promise<string | undefined> {
  let current = dir
  for (let step = 0; step < MAX_PARENT_STEPS && current !== ''; step++) {
    try {
      if (await $.fs.exists(current)) return current
    } catch {
      return undefined
    }
    const parent = parentOf(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/** The branch of the repository the file lives in; undefined outside a repository or on a detached HEAD. */
async function branchOfFile($: EngineInterface, file: string | undefined): Promise<string | undefined> {
  try {
    const cwd = file === undefined ? undefined : await existingDirectory($, parentOf(file))
    const { exitCode, stdout } = await $.process.run(['git', 'symbolic-ref', '--short', '-q', 'HEAD'], { cwd, timeoutMs: GIT_TIMEOUT_MS })
    return exitCode === 0 && stdout.trim() !== '' ? stdout.trim() : undefined
  } catch {
    return undefined
  }
}

function fileOf(input: Readonly<Record<string, unknown>>): string | undefined {
  const path = input.file_path ?? input.notebook_path
  return typeof path === 'string' ? path : undefined
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

/** Tells mods-hub (when installed) about an edit refused in block mode, the path masked and cut short. */
async function reportBlock($: EngineInterface, tool: string, branch: string, path: string | undefined): Promise<void> {
  await hubPublish($, {
    topic: 'risk.blocked',
    data: { guard: MOD, tool, reason: `edit-on-main: editing directly on "${branch}"`, severity: 'low', ...(path === undefined ? {} : { path: redactSummary(path) }) },
  })
}

export const register: Register = (on, options) => {
  const mainBranches = String(options.branches ?? 'main,master,trunk')
    .split(',')
    .map(name => name.trim())
    .filter(name => name !== '')
  const shouldBlock = options.block === true
  let hasWarned = false

  on('session.start', async ($, e, next) => {
    await greetHub($)
    return next(e)
  })

  on('tool.call', { tool: EDIT_TOOLS }, async ($, e, next) => {
    const file = fileOf(e)
    const branch = await branchOfFile($, file)
    const isOnMain = branch !== undefined && mainBranches.includes(branch)

    $.ui.status(isOnMain ? `⚠ editing on ${branch}` : undefined)
    if (!isOnMain) return next(e)

    if (shouldBlock) {
      await reportBlock($, String(e.tool), branch, file)
      return {
        deny: `${MOD}: not editing directly on "${branch}". Create a branch first (git switch -c <type>/<name>, or /git-branch <task> with branch-namer), then retry.`,
      }
    }
    if (!hasWarned) {
      hasWarned = true
      // `warning`: it reaches your phone channel while you are away (a toast when there is no hub).
      const title = `Claude is editing directly on "${branch}". Branch first: git switch -c <name> (or /git-branch).`
      await hubNotify($, { level: 'warning', title }, { timeoutMs: TOAST_MS })
    }
    return next(e)
  }).catch(($, e, next) => (next.called || !shouldBlock ? next(e) : { deny: `${MOD}: its check failed, so the edit was blocked.` }))
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
