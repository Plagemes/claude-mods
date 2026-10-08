import type { EngineInterface, Register } from 'claude-code'

import { redactSummary } from './shared/secrets'
import { junkFor, matchesGlob, megabytes, parseGitAdd, parseStatus, type GitAdd, type StatusEntry } from './staging'

const STATUS_TIMEOUT_MS = 15000
const MAX_STATS = 300
const MAX_LISTED = 6
const MB = 1024 * 1024
const MOD = 'gitignore-guard'

/** One file that should stay out of git; `rule` (`ignored-file` or `big-file`) is for mods-hub's risk.blocked. */
type Finding = { rule: string; label: string; ignoreLine: string }
type Candidate = { shown: string; actual: string }

/** What a broad `git add` would pick up: the repository root and the changed paths under it. */
async function pendingEntries($: EngineInterface, add: GitAdd): Promise<{ root: string; entries: StatusEntry[] } | undefined> {
  try {
    const repo = await $.session.repo()
    if (repo === null) return undefined
    const { exitCode, stdout, isStdoutTruncated } = await $.process.run(
      ['git', '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { timeoutMs: STATUS_TIMEOUT_MS },
    )
    if (exitCode !== 0) return undefined
    const cwd = await $.session.cwd()
    const folder = add.isCurrentDirectoryOnly && cwd.startsWith(`${repo.root}/`) ? `${cwd.slice(repo.root.length + 1)}/` : ''
    return { root: repo.root, entries: parseStatus(stdout, isStdoutTruncated).filter(entry => entry.path.startsWith(folder)) }
  } catch {
    return undefined
  }
}

async function sizeOf($: EngineInterface, path: string): Promise<number | undefined> {
  try {
    const stat = await $.fs.stat(path)
    return stat.kind === 'file' ? stat.size : undefined
  } catch {
    return undefined
  }
}

async function bigFiles($: EngineInterface, candidates: readonly Candidate[], maxBytes: number): Promise<Finding[]> {
  const found: Finding[] = []
  for (const { shown, actual } of candidates.slice(0, MAX_STATS)) {
    const size = await sizeOf($, actual)
    if (size !== undefined && size > maxBytes) found.push({ rule: 'big-file', label: `${shown} (${megabytes(size)})`, ignoreLine: shown })
  }
  return found
}

/** One finding per kind of junk, with a count, so node_modules is a single line and not 40,000. */
function collapseByIgnoreLine(findings: readonly Finding[]): Finding[] {
  const groups = new Map<string, { first: Finding; count: number }>()
  for (const finding of findings) {
    const group = groups.get(finding.ignoreLine)
    if (group) group.count += 1
    else groups.set(finding.ignoreLine, { first: finding, count: 1 })
  }
  return [...groups.values()].map(({ first, count }) => ({
    rule: first.rule,
    ignoreLine: first.ignoreLine,
    label: count > 1 ? `${first.ignoreLine} (${count} files)` : first.label,
  }))
}

function report(findings: readonly Finding[]): string {
  const listed = findings.slice(0, MAX_LISTED).map(finding => `  ${finding.label}`)
  const more = findings.length > MAX_LISTED ? [`  (+${findings.length - MAX_LISTED} more)`] : []
  const ignoreLines = [...new Set(findings.map(finding => finding.ignoreLine))].slice(0, MAX_LISTED).map(line => `  ${line}`)
  return [
    `${MOD}: this git add would stage files that normally stay out of git:`,
    ...listed,
    ...more,
    'Add to .gitignore:',
    ...ignoreLines,
    'Then stage again, or name the files you want instead of using -A / .',
  ].join('\n')
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

/** Tells mods-hub (when installed) what was blocked, the command masked and cut short. The deny never waits on it. */
async function reportBlock($: EngineInterface, findings: readonly Finding[], command: string): Promise<void> {
  const first = findings[0]
  if (first === undefined) return
  const labels = findings.slice(0, MAX_LISTED).map(finding => finding.label).join(', ')
  await hubPublish($, {
    topic: 'risk.blocked',
    data: {
      guard: MOD,
      tool: 'Bash',
      reason: `${first.rule}: git add would stage ${labels}${findings.length > MAX_LISTED ? ` (+${findings.length - MAX_LISTED} more)` : ''}`,
      severity: 'low',
      command: redactSummary(command),
    },
  })
}

export const register: Register = (on, options) => {
  const maxBytes = Math.max(0, Number(options.maxFileMb ?? 5)) * MB
  const extraGlobs = String(options.extraPatterns ?? '')
    .split(',')
    .map(glob => glob.trim())
    .filter(glob => glob !== '')

  /** Unambiguous junk and the extra patterns always; build output only when asked to add everything. */
  const classify = (path: string, includeBuildOutput: boolean): Finding | undefined => {
    const junk = junkFor(path, includeBuildOutput)
    if (junk) return { rule: 'ignored-file', label: `${path} (${junk.reason})`, ignoreLine: junk.ignoreLine }
    const glob = extraGlobs.find(candidate => matchesGlob(path, candidate))
    return glob === undefined ? undefined : { rule: 'ignored-file', label: `${path} (matches ${glob})`, ignoreLine: glob }
  }

  on('session.start', async ($, e, next) => {
    afterStart($, 'gitignore-guard', () => greetHub($))
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!/\badd\b/.test(e.command)) return next(e)
    const add = parseGitAdd(e.command)
    if (add === undefined) return next(e)

    const findings = add.paths.flatMap(path => classify(path, false) ?? [])

    if (add.isBroad) {
      const pending = await pendingEntries($, add)
      if (pending) {
        const junk = pending.entries.filter(entry => entry.status === '??').flatMap(entry => classify(entry.path, true) ?? [])
        findings.push(...collapseByIgnoreLine(junk))
        if (maxBytes > 0 && junk.length === 0) {
          const files = pending.entries.filter(entry => !entry.status.includes('D') && !entry.path.endsWith('/'))
          findings.push(...(await bigFiles($, files.map(entry => ({ shown: entry.path, actual: `${pending.root}/${entry.path}` })), maxBytes)))
        }
      }
    }

    const named = add.paths.filter(path => !/[*?[]/.test(path)).map(path => ({ shown: path, actual: path }))
    if (maxBytes > 0 && findings.length === 0 && named.length > 0) findings.push(...(await bigFiles($, named, maxBytes)))

    if (findings.length === 0) return next(e)
    await reportBlock($, findings, e.command)
    return { deny: report(findings) }
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
