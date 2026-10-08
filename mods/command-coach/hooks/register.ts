import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import { dueRules, isGitCommit, isInstalled, isLongOutput, isTestPrompt, messageOf, summary } from './rules'
import type { Installed, Rule, Signals } from './rules'

const SHOWN_KEY = 'shown'
const LAST_TIP_KEY = 'lastTipAt'
const MINUTE_MS = 60_000
const DEFAULT_COOLDOWN_MINUTES = 120
/** A tip that was shown stays quiet this long. */
const REPEAT_MS = 14 * 24 * 60 * MINUTE_MS
const INSTALLED_TTL_MS = 10 * MINUTE_MS
const LIST_TIMEOUT_MS = 5000
const MAX_REASON = 300
const TOAST_MS = 12_000
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])
const WRITE_TOOLS = /^(?:Edit|MultiEdit|Write|NotebookEdit)$/

const isPerson = (origin: PromptOrigin): boolean =>
  PERSON_ORIGINS.has(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)

/** What this session has shown so far. */
const seen = {
  /** mods-hub is installed: its list of installed plugins and its `error.repeated` events are used. */
  isHubbed: false,
  longOutputs: 0,
  commits: 0,
  testPrompts: 0,
  permissionPrompts: 0,
  failures: 0,
  files: new Set<string>(),
  /** When this session started, as this process saw it: a resumed session counts from its resume. */
  startedAt: undefined as number | undefined,
}

const forgetSession = (): void => {
  Object.assign(seen, { longOutputs: 0, commits: 0, testPrompts: 0, permissionPrompts: 0, failures: 0, startedAt: undefined })
  seen.files.clear()
}

/** Mods already installed, asked of the CLI at most every few minutes. */
const installedCache: { at: number; value?: Installed } = { at: 0 }

type Shown = Readonly<Record<string, number>>

const readShown = async ($: EngineInterface): Promise<Shown> => {
  const stored = await $.store.get(SHOWN_KEY)
  return typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? (stored as Shown) : {}
}

/** The session's counters plus what the engine knows: context fill and age. */
async function signalsOf($: EngineInterface): Promise<Signals> {
  let contextPercent: number | undefined
  try {
    contextPercent = (await $.session.usage()).context.percent
  } catch {
    // Unknown context fill: the /compact rule stays quiet.
  }
  const now = await $.clock.now()
  seen.startedAt ??= now
  const repeatedErrors = seen.isHubbed ? await hubRepeatedErrors($) : undefined
  return {
    longOutputs: seen.longOutputs,
    commits: seen.commits,
    testPrompts: seen.testPrompts,
    permissionPrompts: seen.permissionPrompts,
    editedFiles: seen.files.size,
    failures: seen.failures,
    contextPercent,
    minutes: (now - seen.startedAt) / MINUTE_MS,
    ...(repeatedErrors === undefined ? {} : { repeatedErrors }),
  }
}

/** How many times the hub saw one command fail three times in a row this session; undefined if the hub cannot say. */
async function hubRepeatedErrors($: EngineInterface): Promise<number | undefined> {
  try {
    return (await $.mods.recent({ topic: 'error.repeated' })).length
  } catch {
    return undefined
  }
}

/** The installed plugins as the hub lists them (its `claude plugin list` cache is shared by every mod); undefined when it has not listed yet. */
async function hubPlugins($: EngineInterface): Promise<Set<string> | undefined> {
  try {
    const { plugins, listedAt } = await $.mods.installed()
    return listedAt === null ? undefined : new Set(plugins.filter(plugin => plugin.isEnabled).map(plugin => plugin.name))
  } catch {
    return undefined
  }
}

/** The plugins `claude plugin list --json` reports; empty when the CLI is missing or slow (nothing is assumed installed rather than saying nothing). */
async function cliPlugins($: EngineInterface): Promise<Set<string>> {
  const plugins = new Set<string>()
  try {
    const execPath = await $.env.get('CLAUDE_CODE_EXECPATH')
    const binary = execPath !== undefined && /(^|[\\/])claude(\.exe)?$/i.test(execPath.trim()) ? execPath.trim() : 'claude'
    const ran = await $.process.run([binary, 'plugin', 'list', '--json'], { timeoutMs: LIST_TIMEOUT_MS })
    const list: unknown = ran.exitCode === 0 ? JSON.parse(ran.stdout) : []
    for (const entry of Array.isArray(list) ? list : []) {
      const id = typeof entry?.id === 'string' ? entry.id : ''
      if (id !== '') plugins.add(id.split('@')[0] as string)
    }
  } catch {
    // The CLI is missing or slow.
  }
  return plugins
}

/** The plugins installed (the hub's cached list when it has one, else the CLI's) and the commands the session has, so no installed mod is advertised. */
async function installedMods($: EngineInterface, now: number): Promise<Installed> {
  if (installedCache.value !== undefined && now - installedCache.at < INSTALLED_TTL_MS) return installedCache.value
  const commands = new Set<string>()
  try {
    for (const command of await $.command.list()) commands.add(command.name)
  } catch {
    // Without the command list, the plugin list still answers.
  }
  const plugins = (seen.isHubbed ? await hubPlugins($) : undefined) ?? (await cliPlugins($))
  installedCache.value = { plugins, commands }
  installedCache.at = now
  return installedCache.value
}

/** Rules that are due and have not been shown lately, minus mods that are already installed. */
async function suggestions($: EngineInterface, signals: Signals, now: number, shown: Shown): Promise<Rule[]> {
  const fresh = dueRules(signals).filter(rule => now - (shown[rule.id] ?? 0) >= REPEAT_MS)
  if (!fresh.some(rule => rule.mod !== undefined)) return fresh
  const installed = await installedMods($, now)
  return fresh.filter(rule => !isInstalled(rule, installed))
}

/** After a turn: at most one tip per cooldown, never one already shown lately. */
async function coach($: EngineInterface, cooldownMs: number): Promise<void> {
  try {
    const now = await $.clock.now()
    const last = await $.store.get(LAST_TIP_KEY)
    if (typeof last === 'number' && now - last < cooldownMs) return
    const signals = await signalsOf($)
    const shown = await readShown($)
    const [rule] = await suggestions($, signals, now, shown)
    if (rule === undefined) return
    await hubNotify($, { level: 'info', title: `💡 ${messageOf(rule, signals)}` }, { timeoutMs: TOAST_MS })
    if (rule.mod !== undefined) await hubPublish($, { topic: 'mod.recommended', data: { name: rule.mod, reason: rule.tip(signals).slice(0, MAX_REASON) } })
    await $.store.set(SHOWN_KEY, { ...shown, [rule.id]: now })
    await $.store.set(LAST_TIP_KEY, now)
  } catch {
    // A tip is a nicety: never get in the way of a turn.
  }
}

/** The answer to /coach: what is worth trying now, and what the coach has seen. */
async function report($: EngineInterface): Promise<string> {
  const now = await $.clock.now()
  const signals = await signalsOf($)
  const due = dueRules(signals)
  const installed = due.some(rule => rule.mod !== undefined) ? await installedMods($, now) : undefined
  const open = due.filter(rule => installed === undefined || !isInstalled(rule, installed))
  const lines =
    open.length === 0
      ? ['Nothing to suggest right now. I watch for long command outputs, repeated commits, test-run prompts, a filling context, a long session, many approvals, many changed files and failures.']
      : ['Worth trying now:', ...open.map((rule, index) => `${index + 1}. ${messageOf(rule, signals)}`)]
  return [...lines, '', `Seen this session: ${summary(signals)}`].join('\n')
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

/** With mods-hub installed: hello (this mod publishes `mod.recommended` and reads `error.repeated`). */
async function greetHub($: EngineInterface): Promise<void> {
  seen.isHubbed = (await hubMode($)) !== undefined && (await hubHello($, { version: await ownVersion($), publishes: ['mod.recommended'], consumes: ['error.repeated'] }))
}

export const register: Register = (on, options) => {
  const asked = Number(options.cooldownMinutes)
  const cooldownMs = (Number.isFinite(asked) && asked >= 0 ? asked : DEFAULT_COOLDOWN_MINUTES) * MINUTE_MS
  const showToasts = options.showToasts !== false

  on('session.start', async ($, e, next) => {
    seen.startedAt = await $.clock.now()
    afterStart($, 'command-coach', () => greetHub($))
    await registerCommand($, {
      name: 'coach',
      description: 'Suggest Claude Code commands and mods that fit how you work',
      argumentHint: '[reset]',
    })
    return next(e)
  })

  on('command.run', { command: 'coach' }, async ($, e) => {
    if (e.args.trim().toLowerCase() === 'reset') {
      forgetSession()
      await $.store.delete(SHOWN_KEY)
      await $.store.delete(LAST_TIP_KEY)
      installedCache.value = undefined
      return { text: 'Cleared the counts for this session and the tips shown so far: they can be suggested again.' }
    }
    return { text: await report($) }
  })

  on('prompt.submit', ($, e, next) => {
    if (isPerson(e.origin) && isTestPrompt(e.text)) seen.testPrompts += 1
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    if (ran.isError === true) {
      seen.failures += 1
    } else if (e.tool === 'Bash') {
      if (isLongOutput(ran.text ?? '')) seen.longOutputs += 1
      if (isGitCommit(e.command)) seen.commits += 1
    } else if (WRITE_TOOLS.test(String(e.tool))) {
      const path = 'file_path' in e ? e.file_path : 'notebook_path' in e ? e.notebook_path : undefined
      if (typeof path === 'string') seen.files.add(path)
    }
    return ran
  })

  on('classic.PermissionRequest', ($, e, next) => {
    seen.permissionPrompts += 1
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    // After the turn, in the background: asking the CLI which mods are installed takes a second or two.
    if (showToasts && e.agentId === undefined && e.reason === 'answer') $.clock.after(0, () => void coach($, cooldownMs))
    return next(e)
  })

  on('session.end', ($, e, next) => {
    if (e.reason === 'clear') forgetSession()
    return next(e)
  })
}

/** Registers a slash command. A refused name (Claude Code's own, or another mod's) is reported as a notice, never thrown, so the rest of session.start still runs. */
async function registerCommand($: EngineInterface, spec: Parameters<EngineInterface['command']['register']>[0]): Promise<boolean> {
  try {
    await $.command.register(spec)
    return true
  } catch (error) {
    $.ui.log(`${$.plugin.name}: /${spec.name} was not registered (${error instanceof Error ? error.message : String(error)}).`)
    return false
  }
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
