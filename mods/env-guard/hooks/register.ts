import type { EngineInterface, Register } from 'claude-code'

import { hasNpmToken, isNpmrc, parseGlobs, protectionOf } from './paths'
import { redactSummary } from './shared/secrets'
import { baseName, embeddedShellScripts, simpleCommands } from './shared/shell'

const FILE_TOOLS = /^(?:Read|Edit|Write|MultiEdit|NotebookEdit|Grep)$/
const PATH_FIELDS = ['file_path', 'notebook_path', 'path', 'glob'] as const
const TEXT_FIELDS = ['new_string', 'content', 'new_source'] as const

// Commands that print, copy, search, edit or send the files named to them.
const FILE_COMMANDS = new Set([
  'cat', 'tac', 'nl', 'rev', 'less', 'more', 'head', 'tail', 'bat', 'batcat', 'grep', 'egrep', 'fgrep',
  'rg', 'ag', 'ack', 'awk', 'gawk', 'sed', 'cut', 'sort', 'uniq', 'tr', 'od', 'xxd', 'hexdump', 'strings',
  'base64', 'diff', 'cmp', 'comm', 'paste', 'join', 'cp', 'mv', 'rm', 'ln', 'tee', 'scp', 'rsync',
  'curl', 'wget', 'nc', 'ncat', 'vi', 'vim', 'nvim', 'nano', 'emacs', 'code', 'open', 'dd', 'jq', 'yq',
])
const GIT_READERS = new Set(['show', 'cat-file', 'blame', 'grep'])
/** How deep scripts handed to a shell further along a command (`docker exec app sh -c "…"`) are opened up. */
const MAX_NESTING = 3

const MOD = 'env-guard'

type Verdict = { path: string; rule: string; reason: string }

/** `@file`, `--flag=file` and `rev:file` all name a file after their last separator. */
function candidates(word: string): string[] {
  const tail = word.split(/[=@:]/).pop() ?? word
  return tail === word ? [word] : [word, tail]
}

async function expandHome($: EngineInterface, path: string): Promise<string> {
  if (!path.startsWith('~/')) return path
  const home = await $.env.get('HOME')
  return home === undefined ? path : `${home}${path.slice(1)}`
}

async function npmrcHoldsToken($: EngineInterface, path: string, newText: string): Promise<boolean> {
  if (hasNpmToken(newText)) return true
  try {
    return hasNpmToken(await $.fs.read(await expandHome($, path)))
  } catch {
    return false
  }
}

async function realPathOf($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    return (await $.fs.stat(path, { resolve: true })).realPath
  } catch {
    return undefined
  }
}

type Rules = { extra: RegExp[]; allowed: RegExp[] }

/** Why a path is off limits, or undefined when it may be used. */
async function judge($: EngineInterface, rules: Rules, path: string, newText = ''): Promise<Verdict | undefined> {
  if (rules.allowed.some(glob => glob.test(path))) return undefined
  if (rules.extra.some(glob => glob.test(path))) return { path, rule: 'protected-glob', reason: 'a path you protected' }
  const byName = protectionOf(path)
  if (byName) return { path, ...byName }
  if (isNpmrc(path) && (await npmrcHoldsToken($, path, newText))) return { path, rule: 'npmrc-token', reason: 'an .npmrc holding an auth token' }
  return undefined
}

/**
 * The first protected file a shell line reads or writes. The shared shell reader opens `bash -c "…"`, `eval`,
 * `$(…)` and heredocs fed to a shell; scripts handed to a shell further along (`docker exec app sh -c "…"`) are
 * opened here.
 */
async function bashVerdict($: EngineInterface, rules: Rules, command: string, depth = 0): Promise<Verdict | undefined> {
  for (const { argv, redirects } of simpleCommands(command)) {
    const names = argv.map(baseName)
    const touchesFiles = names.some(name => FILE_COMMANDS.has(name)) || (names.includes('git') && names.some(name => GIT_READERS.has(name)))
    const paths = [...redirects.map(({ target }) => target).filter(target => target !== ''), ...(touchesFiles ? argv : [])].flatMap(candidates)
    for (const path of paths) {
      const verdict = await judge($, rules, path)
      if (verdict) return verdict
    }
    for (const script of depth < MAX_NESTING ? embeddedShellScripts(argv) : []) {
      const verdict = await bashVerdict($, rules, script, depth + 1)
      if (verdict) return verdict
    }
  }
  return undefined
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

/** Tells mods-hub (when installed) what was blocked, path and command masked and cut short. The deny never waits on it. */
async function reportBlock($: EngineInterface, tool: string, verdict: Verdict, command?: string): Promise<void> {
  await hubPublish($, {
    topic: 'risk.blocked',
    data: {
      guard: MOD,
      tool,
      reason: `${verdict.rule}: ${verdict.reason}`,
      severity: 'high',
      path: redactSummary(verdict.path),
      ...(command === undefined ? {} : { command: redactSummary(command) }),
    },
  })
}

/** The verdict on where a symlink at `path` really points, shown as `path -> real`. */
async function linkVerdict($: EngineInterface, rules: Rules, path: string, newText: string): Promise<Verdict | undefined> {
  const real = await realPathOf($, path)
  const verdict = real === undefined || real === path ? undefined : await judge($, rules, real, newText)
  return verdict === undefined ? undefined : { ...verdict, path: `${path} -> ${real}` }
}

function refusal(what: string, { path, reason }: Verdict): string {
  return `${MOD}: ${what} ${path} (${reason}) is blocked. Ask the user for the value you need, or work from .env.example.`
}

export const register: Register = (on, options) => {
  const rules: Rules = {
    extra: parseGlobs(String(options.extraProtected ?? '')),
    allowed: parseGlobs(String(options.allowed ?? '')),
  }

  on('session.start', async ($, e, next) => {
    afterStart($, 'env-guard', () => greetHub($))
    return next(e)
  })

  on('tool.call', { tool: FILE_TOOLS }, async ($, e, next) => {
    const input: Readonly<Record<string, unknown>> = e
    const newText = TEXT_FIELDS.map(field => input[field]).filter(value => typeof value === 'string').join('\n')
    for (const field of PATH_FIELDS) {
      const path = input[field]
      if (typeof path !== 'string') continue
      const verdict = (await judge($, rules, path, newText)) ?? (field === 'glob' ? undefined : await linkVerdict($, rules, path, newText))
      if (verdict === undefined) continue
      await reportBlock($, String(e.tool), verdict)
      return { deny: refusal(`${String(e.tool)} of`, verdict) }
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${MOD}: its check failed, so the call was blocked.` }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const verdict = await bashVerdict($, rules, e.command)
    if (verdict === undefined) return next(e)
    await reportBlock($, 'Bash', verdict, e.command)
    return { deny: refusal('this command touches', verdict) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${MOD}: its check failed, so the command was blocked.` }))
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
