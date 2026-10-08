import type { EngineInterface, Register } from 'claude-code'

import { checkWorkflow, parseActionlint } from './workflow'
import type { Finding } from './workflow'

const WRITE_TOOLS = /^(?:Edit|MultiEdit|Write)$/
const WORKFLOW = /(?:^|[\\/])\.github[\\/]workflows[\\/][^\\/]+\.ya?ml$/
const ACTIONLINT_TIMEOUT_MS = 15000
const MAX_LISTED = 12

type Memory = { isActionlintMissing: boolean }

/** actionlint's problems for the file, or none when it is not installed (it is then not asked again). */
async function runActionlint($: EngineInterface, file: string, memory: Memory): Promise<Finding[]> {
  if (memory.isActionlintMissing) return []
  try {
    const { stdout } = await $.process.run(['actionlint', '-oneline', '-no-color', file], { timeoutMs: ACTIONLINT_TIMEOUT_MS })
    return parseActionlint(stdout).map(({ line, message }) => ({ line, severity: 'error', message: `actionlint: ${message}` }))
  } catch (error) {
    if (String(error).includes('ENOENT')) memory.isActionlintMissing = true
    return []
  }
}

async function check($: EngineInterface, file: string, requireSha: boolean, useActionlint: boolean, memory: Memory): Promise<Finding[]> {
  const text = await $.fs.read(file)
  const external = useActionlint ? await runActionlint($, file, memory) : []
  return [...checkWorkflow(text, { requireSha }), ...external].sort((a, b) => a.line - b.line)
}

const describe = ({ line, severity, message }: Finding): string => `  ${line === 0 ? 'file' : `line ${line}`} [${severity}]: ${message}`

/** Tells mods-hub what the check found, for mods that listen to `lint.result`; nothing happens without a hub. */
async function publishFindings($: EngineInterface, path: string, errors: number, warnings: number): Promise<void> {
  await hubPublish($, { topic: 'lint.result', data: { tool: 'ci-yaml-check', errors, warnings, files: [path] } })
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
    afterStart($, 'ci-yaml-check', () => greetHub($))
    return next(e)
  })

  const requireSha = options.requireSha === true
  const useActionlint = options.useActionlint !== false
  const memory: Memory = { isActionlintMissing: false }

  on('tool.call', { tool: WRITE_TOOLS }, async ($, e, next) => {
    const ran = await next(e)
    const file = 'file_path' in e ? e.file_path : undefined
    if (typeof file !== 'string' || !WORKFLOW.test(file) || ran.deny !== undefined || ran.isError === true) return ran
    if ('_host' in e && e._host !== undefined) return ran

    const found = await check($, file, requireSha, useActionlint, memory).catch((): Finding[] => [])
    if (found.length === 0) return ran

    const name = file.split(/[\\/]/).at(-1) ?? file
    const noun = found.length === 1 ? 'issue' : 'issues'
    const more = found.length > MAX_LISTED ? [`  (+${found.length - MAX_LISTED} more)`] : []
    const errors = found.filter(finding => finding.severity === 'error').length
    await publishFindings($, file, errors, found.length - errors)
    await hubNotify($, { level: 'warning', title: `${found.length} workflow ${noun} in ${name}` })
    return {
      ...ran,
      context: [...(ran.context ?? []), [`ci-yaml-check: ${found.length} ${noun} in ${file}:`, ...found.slice(0, MAX_LISTED).map(describe), ...more].join('\n')],
    }
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
