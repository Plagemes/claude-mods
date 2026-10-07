import type { EngineInterface, Register } from 'claude-code'

import { COVERED_BY_HADOLINT, lintDockerfile } from './dockerfile'
import type { Rule } from './dockerfile'
import { parseHadolint } from './hadolint'

const WRITE_TOOLS = /^(?:Edit|MultiEdit|Write)$/
const DOCKERFILE = /(?:^|[\\/])(?:Dockerfile|Containerfile)(?:\.[\w.-]+)?$|\.dockerfile$/i
const HADOLINT_TIMEOUT_MS = 15000
const MAX_LISTED = 12

type Line = { line: number; text: string }

type Memory = { isHadolintMissing: boolean }

/** hadolint's findings for the file as lines, or undefined when it is not installed or gave no JSON. */
async function runHadolint($: EngineInterface, file: string, memory: Memory): Promise<Line[] | undefined> {
  if (memory.isHadolintMissing) return undefined
  try {
    const { stdout } = await $.process.run(['hadolint', '--no-color', '--format', 'json', file], { timeoutMs: HADOLINT_TIMEOUT_MS })
    return parseHadolint(stdout)?.map(({ code, line, message }) => ({ line, text: `${message} [${code}]` }))
  } catch (error) {
    if (String(error).includes('ENOENT')) memory.isHadolintMissing = true
    return undefined
  }
}

async function lint($: EngineInterface, file: string, ignored: ReadonlySet<string>, useHadolint: boolean, memory: Memory): Promise<Line[]> {
  const text = await $.fs.read(file)
  const builtIn = lintDockerfile(text).filter(finding => !ignored.has(finding.rule))
  const external = useHadolint ? await runHadolint($, file, memory) : undefined
  if (external === undefined) return builtIn.map(({ line, message }) => ({ line, text: message }))

  const covered: readonly Rule[] = COVERED_BY_HADOLINT
  const own = builtIn.filter(finding => !covered.includes(finding.rule)).map(({ line, message }) => ({ line, text: message }))
  const theirs = external.filter(({ text: message }) => ![...ignored].some(code => message.toUpperCase().includes(`[${code.toUpperCase()}]`)))
  return [...theirs, ...own].sort((a, b) => a.line - b.line)
}

/** Tells mods-hub what the check found, for mods that listen to `lint.result`; nothing happens without a hub. */
async function publishFindings($: EngineInterface, path: string, errors: number, warnings: number): Promise<void> {
  await hubPublish($, { topic: 'lint.result', data: { tool: 'docker-lint', errors, warnings, files: [path] } })
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

  const ignored = new Set(
    String(options.ignore ?? '')
      .split(',')
      .map(rule => rule.trim())
      .filter(rule => rule !== ''),
  )
  const useHadolint = options.useHadolint !== false
  const memory: Memory = { isHadolintMissing: false }

  on('tool.call', { tool: WRITE_TOOLS }, async ($, e, next) => {
    const ran = await next(e)
    const file = 'file_path' in e ? e.file_path : undefined
    if (typeof file !== 'string' || !DOCKERFILE.test(file) || ran.deny !== undefined || ran.isError === true) return ran
    if ('_host' in e && e._host !== undefined) return ran

    const found = await lint($, file, ignored, useHadolint, memory).catch((): Line[] => [])
    if (found.length === 0) return ran

    const name = file.split(/[\\/]/).at(-1) ?? file
    const listed = found.slice(0, MAX_LISTED).map(({ line, text }) => `  line ${line}: ${text}`)
    const more = found.length > MAX_LISTED ? [`  (+${found.length - MAX_LISTED} more)`] : []
    await publishFindings($, file, 0, found.length)
    await hubNotify($, { level: 'warning', title: `${found.length} Dockerfile ${found.length === 1 ? 'issue' : 'issues'} in ${name}` })
    return {
      ...ran,
      context: [...(ran.context ?? []), [`docker-lint: ${found.length} ${found.length === 1 ? 'issue' : 'issues'} in ${file}:`, ...listed, ...more].join('\n')],
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
