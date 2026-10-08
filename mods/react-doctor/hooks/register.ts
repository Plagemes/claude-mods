import type { EngineInterface, Register, ToolCallInput } from 'claude-code'

import { affectedSpans, analyze } from './analyze'
import type { Issue } from './analyze'

const JSX_FILE = /\.(?:jsx|tsx)$/i
const SCRIPT_FILE = /\.(?:js|mjs|cjs|ts|mts|cts)$/i
const USES_REACT = /from\s+['"](?:react|preact\/hooks|preact\/compat)['"]|require\(\s*['"]react['"]\s*\)/
const SKIPPED_PATH = /(?:^|\/)(?:node_modules|dist|build|\.next|out)\//
const MAX_FILE_CHARS = 400_000
const MAX_LEVELS = 12
const ESLINT_TIMEOUT_MS = 20_000
const MAX_LISTED = 12
const ESLINT_RULES = ['react-hooks/rules-of-hooks: error', 'react-hooks/exhaustive-deps: warn']
/** What the built-in check adds to ESLint's hook rules: the mistakes those rules do not look for. */
const BUILT_IN_ONLY = new Set<Issue['rule']>(['set-state-in-render', 'missing-key', 'no-deps-array', 'async-effect'])

type Settings = { useEslint: boolean }

/** A project's ESLint with eslint-plugin-react-hooks: its binary and the folder it runs in. */
type Linter = { bin: string; root: string }

/** What this load of the mod remembers: what each file was last told, its open issues, and where ESLint lives. */
type Host = { reported: Map<string, Set<string>>; open: Map<string, number>; linters: Map<string, Linter | null> }

type EslintReport = { messages?: { ruleId?: string | null; message?: string; line?: number; fatal?: boolean }[] }[]

const dirname = (path: string): string => path.slice(0, Math.max(1, path.lastIndexOf('/')))
const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
/** An issue with what identifies it while lines move: its rule, its message and which of the identical ones it is. */
type Keyed = Issue & { key: string }

const withKeys = (issues: readonly Issue[]): Keyed[] => {
  const seen = new Map<string, number>()
  return issues.map(issue => {
    const base = `${issue.rule}:${issue.message}`
    const nth = seen.get(base) ?? 0
    seen.set(base, nth + 1)
    return { ...issue, key: `${base}#${nth}` }
  })
}

const at = (issue: Issue): string => `${issue.line}:${issue.rule}:${issue.message}`

/** The lines an Edit's new text landed on; undefined (the whole file) for a Write or when it cannot be found. */
const editedRange = (e: ToolCallInput, source: string): { from: number; to: number } | undefined => {
  const inserted = 'new_string' in e && typeof e.new_string === 'string' ? e.new_string : undefined
  if (inserted === undefined || inserted.trim() === '') return undefined
  const at = source.indexOf(inserted)
  if (at < 0) return undefined
  const from = source.slice(0, at).split('\n').length
  return { from, to: from + inserted.split('\n').length - 1 }
}

/** ESLint's hook findings, its long advice cut to the first sentence. */
const fromEslint = (report: EslintReport): Issue[] =>
  report.flatMap(file =>
    (file.messages ?? [])
      .filter(message => message.ruleId === 'react-hooks/rules-of-hooks' || message.ruleId === 'react-hooks/exhaustive-deps')
      .map(message => ({
        line: message.line ?? 1,
        rule: message.ruleId === 'react-hooks/rules-of-hooks' ? ('conditional-hook' as const) : ('missing-deps' as const),
        message: (message.message ?? '').split(/\.\s/)[0]?.replace(/\.$/, '') ?? '',
      })),
  )

/** The nearest folder above `file` that has both eslint and eslint-plugin-react-hooks installed. */
async function linterFor($: EngineInterface, host: Host, file: string): Promise<Linter | null> {
  const start = dirname(file)
  const cached = host.linters.get(start)
  if (cached !== undefined) return cached
  let found: Linter | null = null
  let dir = start
  for (let level = 0; level < MAX_LEVELS; level += 1) {
    const bin = `${dir}/node_modules/.bin/eslint`
    const plugin = `${dir}/node_modules/eslint-plugin-react-hooks/package.json`
    if ((await $.fs.exists(plugin).catch(() => false)) && (await $.fs.exists(bin).catch(() => false))) {
      found = { bin, root: dir }
      break
    }
    if (await $.fs.exists(`${dir}/.git`).catch(() => false)) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  host.linters.set(start, found)
  return found
}

/** ESLint's react-hooks findings for one file; undefined when it could not run them (no plugin in its config, a crash). */
async function runEslint($: EngineInterface, linter: Linter, file: string): Promise<Issue[] | undefined> {
  try {
    const argv = [linter.bin, '--format', 'json', ...ESLINT_RULES.flatMap(rule => ['--rule', rule]), file]
    const ran = await $.process.run(argv, { cwd: linter.root, timeoutMs: ESLINT_TIMEOUT_MS, env: { NO_COLOR: '1' } })
    if (ran.exitCode > 1) return undefined
    const report: unknown = JSON.parse(ran.stdout)
    if (!Array.isArray(report)) return undefined
    // A file its config ignores, or one it could not parse, was not linted at all.
    const isUnlinted = (report as EslintReport).some(file => (file.messages ?? []).some(message => message.fatal === true || (message.ruleId == null && /ignored/i.test(message.message ?? ''))))
    return isUnlinted ? undefined : fromEslint(report as EslintReport)
  } catch {
    return undefined
  }
}

/** The React issues in what an edit touched, and all the file's open ones: ESLint's hook rules when the project has them, the built-in check for the rest. */
async function examine(
  $: EngineInterface,
  host: Host,
  settings: Settings,
  e: ToolCallInput,
  file: string,
): Promise<{ issues: Keyed[]; all: Keyed[]; isEslint: boolean } | undefined> {
  const text = await $.fs.read(file).catch(() => undefined)
  if (typeof text !== 'string' || text.length > MAX_FILE_CHARS) return undefined
  if (!JSX_FILE.test(file) && !USES_REACT.test(text)) return undefined

  const range = editedRange(e, text)
  const whole = analyze(text)
  const linter = settings.useEslint ? await linterFor($, host, file) : null
  const linted = linter === null ? undefined : await runEslint($, linter, file)
  const all = withKeys((linted === undefined ? whole : [...linted, ...whole.filter(issue => BUILT_IN_ONLY.has(issue.rule))]).sort((a, b) => a.line - b.line))
  if (range === undefined) return { issues: all, all, isEslint: linted !== undefined }

  // Built-in issues come from the touched components; ESLint's from the lines those components span.
  const touched = new Set(analyze(text, range).map(at))
  const spans = affectedSpans(text, range)
  const isTouched = (issue: Issue) =>
    linted !== undefined && !BUILT_IN_ONLY.has(issue.rule) ? spans.some(span => issue.line >= span.from && issue.line <= span.to) : touched.has(at(issue))
  return { issues: all.filter(isTouched), all, isEslint: linted !== undefined }
}

/** The issues the file was not told about yet; what it was told is kept while those issues stay open, so a fixed one is told again if it comes back. */
function fresh(host: Host, file: string, issues: readonly Keyed[], all: readonly Keyed[]): Keyed[] {
  const told = host.reported.get(file) ?? new Set<string>()
  const news = issues.filter(issue => !told.has(issue.key))
  const open = new Set(all.map(issue => issue.key))
  host.reported.set(file, new Set([...told, ...issues.map(issue => issue.key)].filter(key => open.has(key))))
  return news
}

/** The hook-order mistakes React itself rejects; the other findings are advice. */
const RULES_OF_HOOKS = new Set<Issue['rule']>(['conditional-hook', 'hook-in-loop', 'hook-in-callback', 'hook-after-return'])

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

/** The issues the file was just told about, as a `lint.result` on the hub's bus (nothing happens without the hub). */
async function publishIssues($: EngineInterface, file: string, news: readonly Issue[]): Promise<void> {
  const errors = news.filter(issue => RULES_OF_HOOKS.has(issue.rule)).length
  await hubPublish($, { topic: 'lint.result', data: { tool: 'react-doctor', errors, warnings: news.length - errors, files: [file] } })
}

function showStatus($: EngineInterface, host: Host): void {
  const files = [...host.open.entries()].filter(([, count]) => count > 0)
  const total = files.reduce((sum, [, count]) => sum + count, 0)
  $.ui.status(total === 0 ? undefined : `⚛ ${total} React issue${total === 1 ? '' : 's'} · ${files.map(([file]) => basename(file)).join(', ')}`)
}

export const register: Register = (on, options) => {
  const settings: Settings = { useEslint: options.useEslint !== false }
  const host: Host = { reported: new Map(), open: new Map(), linters: new Map() }

  on('session.start', async ($, e, next) => {
    afterStart($, 'react-doctor', () => greetHub($))
    return next(e)
  })

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const ran = await next(e)
    const file = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : ''
    if (ran.deny !== undefined || ran.isError === true || SKIPPED_PATH.test(file)) return ran
    if (!JSX_FILE.test(file) && !SCRIPT_FILE.test(file)) return ran
    try {
      const found = await examine($, host, settings, e, file)
      if (found === undefined) return ran
      const news = fresh(host, file, found.issues, found.all)
      host.open.set(file, found.all.length)
      showStatus($, host)
      if (news.length === 0) return ran
      await publishIssues($, file, news)

      const root = await $.session.cwd().catch(() => '')
      const shown = file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file
      const listed = news.slice(0, MAX_LISTED).map(issue => `- ${shown}:${issue.line} ${issue.message}`)
      const more = news.length > MAX_LISTED ? [`- …and ${news.length - MAX_LISTED} more`] : []
      const by = found.isEslint ? 'eslint-plugin-react-hooks and react-doctor' : 'react-doctor'
      const note = [`${by} found React issues in ${shown}:`, ...listed, ...more, 'Fix them, or say why one is intentional.'].join('\n')
      return { ...ran, context: [...(ran.context ?? []), note] }
    } catch {
      return ran
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
