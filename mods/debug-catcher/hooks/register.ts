import type { EngineInterface, Register } from 'claude-code'

/** `isOutput`: the language's way to print, which is a program's real output in a command-line entry point. */
type Rule = { label: string; pattern: RegExp; isOutput?: boolean }

const JAVASCRIPT: Rule[] = [
  { label: 'console.log', pattern: /\bconsole\.(log|debug|trace|dir|table)\s*\(/, isOutput: true },
  { label: 'debugger', pattern: /^\s*debugger\s*;?\s*(\/\/.*)?$/ },
]

const RULES_BY_EXTENSION: Record<string, Rule[]> = {
  js: JAVASCRIPT,
  jsx: JAVASCRIPT,
  mjs: JAVASCRIPT,
  cjs: JAVASCRIPT,
  ts: JAVASCRIPT,
  tsx: JAVASCRIPT,
  mts: JAVASCRIPT,
  cts: JAVASCRIPT,
  vue: JAVASCRIPT,
  svelte: JAVASCRIPT,
  py: [
    { label: 'print()', pattern: /^\s*print\s*\(/, isOutput: true },
    { label: 'breakpoint', pattern: /\b(breakpoint\(\)|i?pdb\.set_trace\(\))/ },
  ],
  rb: [
    { label: 'pp', pattern: /^\s*pp[\s(]/ },
    { label: 'debugger', pattern: /\b(binding\.(pry|irb)|byebug)\b/ },
  ],
  php: [{ label: 'var_dump', pattern: /(^|[^\w>:$.])(var_dump|print_r|dd|dump)\s*\(/ }],
  rs: [{ label: 'dbg!', pattern: /\bdbg!\s*[([{]/ }],
  go: [{ label: 'fmt.Println', pattern: /\bfmt\.Println\s*\(/, isOutput: true }],
  java: [
    { label: 'System.out', pattern: /\bSystem\.(out|err)\.print(ln)?\s*\(/, isOutput: true },
    { label: 'printStackTrace', pattern: /\.printStackTrace\s*\(/ },
  ],
}

/** A command-line program, whose printing is its output: a shebang, Python's __main__ guard, Go's package main, Java's main(). */
const PROGRAM = /^#!|\bif\s+__name__\s*==\s*['"]__main__['"]|^package\s+main\b|\bstatic\s+void\s+main\s*\(/m
const PROGRAM_FILE = /(^|[\\/])(__main__|manage)\.py$/

const NOT_SOURCE =
  /(^|\/)(tests?|__tests__|specs?|scripts?|fixtures?|examples?|e2e|bin)\/|\.(test|spec|stories)\.[^/]+$|(^|\/)(conftest|test_[^/]*)\.py$|_test\.(go|py)$|\.config\.[^/]+$/

const COMMENT = /^\s*(\/\/|#|\*|\/\*)/
const IGNORE_MARKER = 'debug-catcher: ignore'
const MAX_SAMPLES = 3
const MAX_SAMPLE_LENGTH = 60

const rulesFor = (path: string): Rule[] => {
  if (NOT_SOURCE.test(path)) return []
  return RULES_BY_EXTENSION[path.split('.').pop()?.toLowerCase() ?? ''] ?? []
}

const countLines = (text: string): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const line of text.split('\n')) {
    const key = line.trim()
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/** Lines of `after` that `before` does not have, compared as a multiset of trimmed lines. */
const newLines = (before: string, after: string): string[] => {
  const available = countLines(before)
  return after.split('\n').filter(line => {
    const key = line.trim()
    const left = available.get(key) ?? 0
    available.set(key, left - 1)
    return left <= 0
  })
}

const debugLines = (lines: string[], rules: Rule[]): string[] =>
  lines.filter(
    line =>
      !COMMENT.test(line) &&
      !line.includes(IGNORE_MARKER) &&
      rules.some(rule => rule.pattern.test(line)),
  )

const sample = (line: string): string => {
  const text = line.trim()
  return `\`${text.length > MAX_SAMPLE_LENGTH ? `${text.slice(0, MAX_SAMPLE_LENGTH)}...` : text}\``
}

const readLocal = async ($: EngineInterface, path: string): Promise<string> => {
  try {
    return await $.fs.read(path)
  } catch {
    return ''
  }
}

const plural = (n: number): string => `${n} debug statement${n === 1 ? '' : 's'}`

/** Tells mods-hub what the check found, for mods that listen to `lint.result`; nothing happens without a hub. */
async function publishFindings($: EngineInterface, path: string, errors: number, warnings: number): Promise<void> {
  await hubPublish($, { topic: 'lint.result', data: { tool: 'debug-catcher', errors, warnings, files: [path] } })
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
    afterStart($, 'debug-catcher', () => greetHub($))
    return next(e)
  })

  const pending = new Map<string, number>()

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const rules = rulesFor(e.file_path)
    if (rules.length === 0) return next(e)

    let before = ''
    let after = ''
    if (e.tool === 'Edit') {
      before = e.old_string
      after = e.new_string
    } else {
      after = e.content
      before = e._host === undefined ? await readLocal($, e.file_path) : ''
    }

    // In a program's entry point print() and console.log are the output: only debugger-style rules apply there.
    const usesOutput = rules.some(rule => rule.isOutput === true)
    const fileText = usesOutput ? (e.tool === 'Write' ? after : `${e._host === undefined ? await readLocal($, e.file_path) : ''}\n${after}`) : ''
    const isProgram = usesOutput && (PROGRAM_FILE.test(e.file_path) || PROGRAM.test(fileText))
    const checked = isProgram ? rules.filter(rule => rule.isOutput !== true) : rules
    const added = debugLines(newLines(before, after), checked)
    const removed = debugLines(newLines(after, before), checked)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran

    const net = Math.max(0, (pending.get(e.file_path) ?? 0) + added.length - removed.length)
    if (net > 0) pending.set(e.file_path, net)
    else pending.delete(e.file_path)

    const total = [...pending.values()].reduce((sum, n) => sum + n, 0)
    $.ui.status(total > 0 ? `⚠ ${plural(total)} to remove` : undefined)

    if (added.length === 0) return ran

    await publishFindings($, e.file_path, 0, added.length)
    const samples = added.slice(0, MAX_SAMPLES).map(sample).join(', ')
    const note =
      `debug-catcher: this edit added ${plural(added.length)} to ${e.file_path}: ${samples}. ` +
      `Remove them before you finish; to keep one on purpose, add "${IGNORE_MARKER}" to its line.`
    return { ...ran, context: [...(ran.context ?? []), note] }
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
