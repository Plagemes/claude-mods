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
const TOAST_MS = 12_000
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])
const WRITE_TOOLS = /^(?:Edit|MultiEdit|Write|NotebookEdit)$/

const isPerson = (origin: PromptOrigin): boolean =>
  PERSON_ORIGINS.has(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)

/** What this session has shown so far. */
const seen = {
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
  return {
    longOutputs: seen.longOutputs,
    commits: seen.commits,
    testPrompts: seen.testPrompts,
    permissionPrompts: seen.permissionPrompts,
    editedFiles: seen.files.size,
    failures: seen.failures,
    contextPercent,
    minutes: (now - seen.startedAt) / MINUTE_MS,
  }
}

/** The plugins `claude plugin list` reports and the commands the session has, so no installed mod is advertised. */
async function installedMods($: EngineInterface, now: number): Promise<Installed> {
  if (installedCache.value !== undefined && now - installedCache.at < INSTALLED_TTL_MS) return installedCache.value
  const plugins = new Set<string>()
  const commands = new Set<string>()
  try {
    for (const command of await $.command.list()) commands.add(command.name)
  } catch {
    // Without the command list, the plugin list below still answers.
  }
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
    // The CLI is missing or slow: assume nothing is installed rather than say nothing.
  }
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
    $.ui.toast(`💡 ${messageOf(rule, signals)}`, { timeoutMs: TOAST_MS })
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

export const register: Register = (on, options) => {
  const asked = Number(options.cooldownMinutes)
  const cooldownMs = (Number.isFinite(asked) && asked >= 0 ? asked : DEFAULT_COOLDOWN_MINUTES) * MINUTE_MS
  const showToasts = options.showToasts !== false

  on('session.start', async ($, e, next) => {
    seen.startedAt = await $.clock.now()
    await $.command.register({
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

  on('turn.complete', async ($, e, next) => {
    if (showToasts && e.agentId === undefined && e.reason === 'answer') await coach($, cooldownMs)
    return next(e)
  })

  on('session.end', ($, e, next) => {
    if (e.reason === 'clear') forgetSession()
    return next(e)
  })
}
