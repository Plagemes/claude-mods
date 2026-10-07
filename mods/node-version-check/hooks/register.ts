import type { EngineInterface, Register } from 'claude-code'

import { matchesPin, parseVersion, satisfies } from './semver'
import type { Version } from './semver'
import { simpleCommands } from './shared/shell'

const NODE_TIMEOUT_MS = 3000
const INSTALL_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  npm: ['install', 'i', 'ci', 'add', 'update', 'rebuild'],
  pnpm: ['install', 'i', 'add', 'update', 'up'],
  yarn: ['install', 'add', 'up', 'upgrade'],
}

/** A version requirement the project states: where, and what. */
type Wanted = { label: string; spec: string; isMet: (version: Version) => boolean | undefined }

type Check = { running: string; unmet: Wanted[] }

type State = {
  /** What the first look found; undefined until it has run. */
  check: Check | undefined
  isLooking: boolean
  isWarned: boolean
}

/** The first line of a version file that is not blank or a comment. */
const firstLine = (text: string): string => text.split(/\r?\n/).map(line => line.trim()).find(line => line !== '' && !line.startsWith('#')) ?? ''

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

/** What the folder asks of Node: .nvmrc, .node-version, .tool-versions and package.json engines.node. */
async function requirementsIn($: EngineInterface, folder: string): Promise<Wanted[]> {
  const wanted: Wanted[] = []
  for (const file of ['.nvmrc', '.node-version']) {
    const spec = firstLine((await readText($, `${folder}/${file}`)) ?? '')
    if (spec !== '') wanted.push({ label: file, spec, isMet: version => matchesPin(version, spec) })
  }
  const toolVersions = await readText($, `${folder}/.tool-versions`)
  const asdf = toolVersions === undefined ? undefined : /^(?:nodejs|node)[ \t]+(\S+)/m.exec(toolVersions)?.[1]
  if (asdf !== undefined) wanted.push({ label: '.tool-versions', spec: asdf, isMet: version => matchesPin(version, asdf) })
  const manifest = await readText($, `${folder}/package.json`)
  if (manifest !== undefined) {
    try {
      const engines = (JSON.parse(manifest) as { engines?: { node?: unknown } }).engines
      const range = typeof engines?.node === 'string' ? engines.node : undefined
      if (range !== undefined) wanted.push({ label: 'package.json engines', spec: range, isMet: version => satisfies(version, range) })
    } catch {
      // A package.json that does not parse says nothing about Node.
    }
  }
  return wanted
}

/** The Node the session runs on, compared with what the project asks for; undefined when either is unknown. */
async function lookAtNode($: EngineInterface): Promise<Check | undefined> {
  let running: Version | undefined
  let text = ''
  try {
    const { exitCode, stdout } = await $.process.run(['node', '--version'], { timeoutMs: NODE_TIMEOUT_MS })
    text = stdout.trim()
    running = exitCode === 0 ? parseVersion(text) : undefined
  } catch {
    running = undefined
  }
  if (running === undefined) return undefined

  const folders = [...new Set([await $.session.cwd(), await $.session.root().catch(() => '')])].filter(folder => folder !== '')
  const wanted = (await Promise.all(folders.map(folder => requirementsIn($, folder)))).flat()
  return { running: text, unmet: wanted.filter(item => item.isMet(running) === false) }
}

/** Looks once (the answer is kept); concurrent callers share the first look. */
async function checkOnce($: EngineInterface, state: State): Promise<Check | undefined> {
  if (state.check !== undefined || state.isLooking) return state.check
  state.isLooking = true
  try {
    state.check = await lookAtNode($)
  } catch {
    state.check = undefined
  } finally {
    state.isLooking = false
  }
  return state.check
}

const wantsText = ({ spec, label }: Wanted): string => `${spec} (${label})`

/** At session start: one toast and one status line, the first time a mismatch is found. */
async function warnAtStart($: EngineInterface, state: State): Promise<void> {
  const check = await checkOnce($, state)
  const first = check?.unmet[0]
  if (check === undefined || first === undefined || state.isWarned) return
  state.isWarned = true
  await hubNotify($, { level: 'warning', title: `node ${check.running} is running, but the project wants ${wantsText(first)}` })
  $.ui.status(`⚠ node ${check.running}, project wants ${first.spec}`)
}

/** Whether the command line installs packages with npm, pnpm or yarn. */
function isInstall(command: string): boolean {
  return simpleCommands(command).some(({ name, argv }) => {
    const rest = argv.slice(1)
    const subcommands = INSTALL_SUBCOMMANDS[name]
    if (subcommands === undefined) return false
    const [first] = rest.filter(word => !word.startsWith('-'))
    return first === undefined ? name === 'yarn' && rest.length === 0 : subcommands.includes(first)
  })
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
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: [] })
}

export const register: Register = on => {
  const state: State = { check: undefined, isLooking: false, isWarned: false }

  on('session.start', async ($, e, next) => {
    await greetHub($)
    const started = await next(e)
    $.clock.after(0, () => void warnAtStart($, state))
    return started
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!isInstall(e.command)) return next(e)
    const check = await checkOnce($, state)
    const ran = await next(e)
    const first = check?.unmet[0]
    if (check === undefined || first === undefined || ran.deny !== undefined) return ran
    const note =
      `node-version-check: node ${check.running} is running, but the project wants ${wantsText(first)}. ` +
      `Packages with native code were built for this Node, so if the install or the app misbehaves, switch Node (nvm use, fnm use, volta) and install again.`
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
