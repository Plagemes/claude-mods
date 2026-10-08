import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register, RenderElement, RenderInput, Timer, ToolCallInput, ToolCallResult } from 'claude-code'

import type { GuardianBlock, GuardianRow, GuardianSnapshot } from '../types'
import { criticalFindings } from './fallback'
import type { Finding } from './fallback'
import { GUARDS, GUARD_NAMES, POLICY_LEVELS, applyChanges, describeChange, isObject, isPolicyLevel, planApply, policyFile, policyFor, readPolicyFile, stamp } from './policy'
import type { Change, Json, Overrides, Policy, PolicyLevel } from './policy'
import { computeScore, scoreLine } from './score'

// ── Constants ───────────────────────────────────────────────────────────────────────────────────────

const VERSION = '1.0.0'
const PANE = 'guardian'
const HUB_PANE = 'claude-mods'
const TAB = { id: 'guardian', title: 'Guardian', order: 70, command: 'guardian' }
const PROJECT_FILE = '.claude/guardian.json'
const POLICY_DIR = '.claude/claude-mods/guardian'
const LIST_TIMEOUT_MS = 15_000
const INSTALL_TIMEOUT_MS = 120_000
const INSTALLED_TTL_MS = 10 * 60_000
const DAY_MS = 24 * 60 * 60_000
const WINDOW_MS = 7 * DAY_MS
const MAX_KEPT = 50
const FEED_SHOWN = 6
/** Longest option value the diff shows; guardian's own values are all shorter, so none is cut. */
const DIFF_VALUE_MAX = 400
const REFRESH_DELAY_MS = 1_500
const NARROW = 72
const CLAUDE_BINARY = /(^|[\\/])claude(\.exe)?$/i
const DENY_PREFIX = /^([a-z0-9][a-z0-9-]*)\s*(?:\(|:)/
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])
const HOTKEYS: Readonly<Record<PolicyLevel, string>> = { permissive: 'p', standard: 's', strict: 't', custom: 'c' }
const USAGE = 'Usage: /guardian [level permissive|standard|strict|custom | apply [--yes] | install <guard> | score]'

// ── State the tab draws from ────────────────────────────────────────────────────────────────────────

const snapshotAtom = atom({ plugin: 'guardian', key: 'snapshot' } as const, null as GuardianSnapshot | null)
const confirmAtom = atom({ plugin: 'guardian', key: 'isConfirming' } as const, false)
const noticeAtom = atom({ plugin: 'guardian', key: 'notice' } as const, null as string | null)
const busyAtom = atom({ plugin: 'guardian', key: 'busy' } as const, null as string | null)

// ── The per-load runtime ────────────────────────────────────────────────────────────────────────────

type Options = { level: PolicyLevel; fallback: boolean; marketplace: string }
type ProjectStats = { blocks: GuardianBlock[]; secrets: { at: number; path?: string }[]; risky: { at: number; command: string }[] }

type Runtime = {
  options: Options
  /** The project root (git root, else the working directory); '' until the session started. */
  root: string
  home: string
  settingsPath: string
  policy: Policy
  overrides: Overrides
  source: GuardianSnapshot['source']
  installed: Set<string> | undefined
  installedAt: number
  relevant: Map<string, boolean>
  bin: string | undefined
  timer: Timer | undefined
  seq: number
}

const newRuntime = (options: Options): Runtime => ({
  options,
  root: '',
  home: '',
  settingsPath: '',
  policy: policyFor(options.level, { fallback: options.fallback }),
  overrides: {},
  source: 'setting',
  installed: undefined,
  installedAt: 0,
  relevant: new Map(),
  bin: undefined,
  timer: undefined,
  seq: 0,
})

const isPerson = (origin: PromptOrigin): boolean => PERSON_ORIGINS.has(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)
const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`
const projectName = (root: string): string => root.split('/').filter(part => part !== '').pop() ?? root

const ago = (at: number, now: number): string => {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

// ── Files ───────────────────────────────────────────────────────────────────────────────────────────

async function readJson($: EngineInterface, path: string): Promise<unknown> {
  try {
    return JSON.parse(await $.fs.read(path)) as unknown
  } catch {
    return undefined
  }
}

async function writeJson($: EngineInterface, path: string, value: unknown): Promise<boolean> {
  try {
    await $.fs.write(path, `${JSON.stringify(value, null, 2)}\n`)
    return true
  } catch {
    return false
  }
}

/** Finds the home folder, the user settings file and the project root. */
async function locate($: EngineInterface, rt: Runtime): Promise<void> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  const configDir = configured !== undefined && configured !== '' ? configured : `${home}/.claude`
  rt.home = home
  rt.settingsPath = home === '' && configDir.startsWith('/.claude') ? '' : `${configDir}/settings.json`
  let root = ''
  try {
    root = (await $.session.repo())?.root ?? ''
  } catch {
    root = ''
  }
  rt.root = root !== '' ? root : await $.session.cwd()
}

/** The project's `.claude/guardian.json` level when it has one, else the mod's own setting. */
async function loadPolicy($: EngineInterface, rt: Runtime): Promise<void> {
  const text = await $.fs.read(`${rt.root}/${PROJECT_FILE}`).catch(() => undefined)
  const file = text === undefined ? undefined : readPolicyFile(text)
  if (file === undefined) {
    rt.policy = policyFor(rt.options.level, { fallback: rt.options.fallback })
    rt.overrides = {}
    rt.source = 'setting'
    return
  }
  rt.overrides = file.overrides
  rt.policy = policyFor(file.level, { ...(file.base === undefined ? {} : { base: file.base }), overrides: file.overrides, fallback: file.fallback ?? rt.options.fallback })
  rt.source = 'project'
}

/** Writes the chosen policy: per project, and as the last chosen one under ~/.claude/claude-mods/guardian. */
async function savePolicy($: EngineInterface, rt: Runtime): Promise<boolean> {
  const at = new Date(await $.clock.now()).toISOString()
  const isSaved = await writeJson($, `${rt.root}/${PROJECT_FILE}`, policyFile(rt.policy, at))
  if (rt.home !== '') await writeJson($, `${rt.home}/${POLICY_DIR}/policy.json`, policyFile(rt.policy, at, rt.root))
  await hubShare($, rt.policy, rt.root)
  return isSaved
}

// ── The hub (soft: every call falls back when mods-hub is not installed) ────────────────────────────

async function hubRecent($: EngineInterface, topic: string): Promise<{ id: string; at: number; source: string; data: unknown }[]> {
  try {
    return await $.mods.recent({ topic, limit: MAX_KEPT })
  } catch {
    return []
  }
}

async function hubInstalled($: EngineInterface): Promise<Set<string> | undefined> {
  try {
    const installed = await $.mods.installed()
    return installed.listedAt === null ? undefined : new Set(installed.plugins.filter(plugin => plugin.isEnabled).map(plugin => plugin.name))
  } catch {
    return undefined
  }
}

async function hubShare($: EngineInterface, policy: Policy, project: string): Promise<void> {
  try {
    const guards = Object.fromEntries(Object.entries(policy.guards).map(([name, guard]) => [name, guard.options]))
    await $.mods.share({ name: 'policy', value: { level: policy.level, base: policy.base, fallback: policy.isFallbackOn, project, guards } })
  } catch {
    // No hub: the policy files are the record.
  }
}

// ── Installed guards and project relevance ──────────────────────────────────────────────────────────

async function claudeBin($: EngineInterface, rt: Runtime): Promise<string> {
  if (rt.bin === undefined) {
    const execPath = (await $.env.get('CLAUDE_CODE_EXECPATH'))?.trim()
    rt.bin = execPath !== undefined && CLAUDE_BINARY.test(execPath) ? execPath : 'claude'
  }
  return rt.bin
}

/** The installed, enabled plugins: the hub's cached list, else `claude plugin list --json`, else enabledPlugins. */
async function knownInstalled($: EngineInterface, rt: Runtime, isForced = false): Promise<Set<string> | undefined> {
  const now = await $.clock.now()
  if (!isForced && rt.installed !== undefined && now - rt.installedAt < INSTALLED_TTL_MS) return rt.installed
  let names = isForced ? undefined : await hubInstalled($)
  if (names === undefined) {
    try {
      const listed = await $.process.run([await claudeBin($, rt), 'plugin', 'list', '--json'], { timeoutMs: LIST_TIMEOUT_MS })
      const list: unknown = listed.exitCode === 0 ? JSON.parse(listed.stdout) : undefined
      if (Array.isArray(list)) {
        names = new Set(
          list
            .filter(entry => isObject(entry) && typeof entry.id === 'string' && entry.enabled !== false)
            .map(entry => String((entry as Json).id).replace(/@[^@]*$/, '')),
        )
      }
    } catch {
      names = undefined
    }
  }
  if (names === undefined) {
    const settings = await readJson($, rt.settingsPath)
    const enabled = isObject(settings) && isObject(settings.enabledPlugins) ? settings.enabledPlugins : undefined
    if (enabled !== undefined) names = new Set(Object.entries(enabled).filter(([, on]) => on === true).map(([id]) => id.replace(/@[^@]*$/, '')))
  }
  if (names !== undefined) {
    rt.installed = names
    rt.installedAt = now
  }
  return rt.installed
}

/** Which guards matter in this project, from the files at its root (a Python project gets venv-guard, …). */
async function checkRelevance($: EngineInterface, rt: Runtime): Promise<void> {
  const seen = new Map<string, boolean>()
  for (const guard of GUARDS) {
    if (guard.markers === undefined) continue
    let isRelevant = false
    for (const marker of guard.markers) {
      if (!seen.has(marker)) seen.set(marker, await $.fs.exists(`${rt.root}/${marker}`).catch(() => false))
      if (seen.get(marker) === true) {
        isRelevant = true
        break
      }
    }
    rt.relevant.set(guard.name, isRelevant)
  }
}

// ── Per-project history (blocks, secrets, risky commands), kept 7 days ──────────────────────────────

const statsKey = (rt: Runtime): string => `project:${rt.root}`

async function loadStats($: EngineInterface, rt: Runtime): Promise<ProjectStats> {
  const stored = await $.store.get(statsKey(rt)).catch(() => undefined)
  const value = isObject(stored) ? stored : {}
  const list = <T,>(key: string): T[] => (Array.isArray(value[key]) ? (value[key] as T[]) : [])
  return { blocks: list<GuardianBlock>('blocks'), secrets: list('secrets'), risky: list('risky') }
}

async function saveStats($: EngineInterface, rt: Runtime, stats: ProjectStats): Promise<void> {
  const since = (await $.clock.now()) - WINDOW_MS
  const recent = <T extends { at: number },>(items: T[]): T[] => items.filter(item => item.at >= since).slice(-MAX_KEPT)
  await $.store.set(statsKey(rt), { blocks: recent(stats.blocks), secrets: recent(stats.secrets), risky: recent(stats.risky) }).catch(() => undefined)
}

async function recordBlock($: EngineInterface, rt: Runtime, block: Omit<GuardianBlock, 'id' | 'at'>): Promise<void> {
  const at = await $.clock.now()
  rt.seq += 1
  const stats = await loadStats($, rt)
  stats.blocks.push({ ...block, id: `${block.source}-${at}-${rt.seq}`, at })
  await saveStats($, rt, stats)
}

/** A critical command or a secret went through with no guard stopping it. */
async function recordAllowed($: EngineInterface, rt: Runtime, findings: readonly Finding[]): Promise<void> {
  const at = await $.clock.now()
  const stats = await loadStats($, rt)
  for (const finding of findings) {
    if (finding.rule === 'secret-write') stats.secrets.push({ at, ...(finding.path === undefined ? {} : { path: finding.path }) })
    else stats.risky.push({ at, command: oneLine(finding.command ?? finding.path ?? finding.reason, 200) })
  }
  await saveStats($, rt, stats)
}

/** Adds the hub's risk.blocked events of this session to the project's history, once each. */
async function mergeHubBlocks($: EngineInterface, rt: Runtime, stats: ProjectStats): Promise<boolean> {
  const known = new Set(stats.blocks.map(block => block.id))
  let isChanged = false
  for (const event of await hubRecent($, 'risk.blocked')) {
    const data = isObject(event.data) ? event.data : {}
    const id = `hub-${event.id}`
    if (event.source === 'guardian' || known.has(id) || typeof data.guard !== 'string') continue
    const severity = data.severity === 'low' || data.severity === 'medium' ? data.severity : 'high'
    stats.blocks.push({
      id,
      at: event.at,
      guard: data.guard,
      tool: String(data.tool ?? ''),
      reason: oneLine(String(data.reason ?? ''), 200),
      severity,
      ...(typeof data.command === 'string' ? { command: oneLine(data.command, 200) } : {}),
      ...(typeof data.path === 'string' ? { path: data.path } : {}),
      source: 'hub',
    })
    isChanged = true
  }
  // A deny guardian saw itself and the hub's event for it are one block.
  if (isChanged) {
    stats.blocks = stats.blocks.filter(
      block => block.source !== 'observed' || !stats.blocks.some(other => other.source === 'hub' && other.guard === block.guard && Math.abs(other.at - block.at) < 5_000),
    )
    stats.blocks.sort((a, b) => a.at - b.at)
  }
  return isChanged
}

// ── The snapshot the tab draws ──────────────────────────────────────────────────────────────────────

async function refresh($: EngineInterface, rt: Runtime): Promise<GuardianSnapshot> {
  const now = await $.clock.now()
  const raw = await readJson($, rt.settingsPath)
  const settings: Json = isObject(raw) ? raw : {}
  const installed = rt.installed
  const stats = await loadStats($, rt)
  if (await mergeHubBlocks($, rt, stats)) await saveStats($, rt, stats)
  const recentBlocks = stats.blocks.filter(block => block.at >= now - WINDOW_MS)
  const hubSecrets = (await hubRecent($, 'secret.detected')).filter(event => isObject(event.data) && event.data.action === 'warned').length
  const marketplace = rt.options.marketplace
  const policy = rt.policy

  const rows: GuardianRow[] = GUARDS.map(guard => {
    const isInstalled = installed?.has(guard.name) ?? false
    const blocks = recentBlocks.filter(block => block.guard === guard.name || block.for === guard.name)
    return {
      name: guard.name,
      title: guard.title,
      isRecommended: policy.guards[guard.name]?.isRecommended ?? false,
      isRelevant: guard.markers === undefined || rt.relevant.get(guard.name) !== false,
      isInstalled,
      pending: isInstalled ? planApply(settings, policy, new Set([guard.name]), marketplace).length : 0,
      isCoveredByFallback: !isInstalled && policy.isFallbackOn && guard.fallback !== undefined,
      lastBlockAt: blocks.length === 0 ? null : Math.max(...blocks.map(block => block.at)),
    }
  })
  const score = computeScore({
    level: policy.base,
    guards: rows.map(row => ({ ...row, weight: GUARDS.find(guard => guard.name === row.name)?.weight ?? 1, isConfigured: row.pending === 0 })),
    blocks: recentBlocks.length,
    secrets: stats.secrets.filter(item => item.at >= now - WINDOW_MS).length + hubSecrets,
    riskyAllowed: stats.risky.filter(item => item.at >= now - WINDOW_MS).length,
    isInstalledKnown: installed !== undefined,
  })
  const snapshot: GuardianSnapshot = {
    level: policy.level,
    base: policy.base,
    source: rt.source,
    project: rt.root,
    isFallbackOn: policy.isFallbackOn,
    isInstalledKnown: installed !== undefined,
    rows,
    score,
    blocks: recentBlocks.slice(-MAX_KEPT),
    changes: planApply(settings, policy, installed ?? new Set(), marketplace),
    settingsPath: rt.settingsPath,
    updatedAt: now,
  }
  await update($, snapshotAtom, () => snapshot)
  return snapshot
}

function scheduleRefresh($: EngineInterface, rt: Runtime): void {
  rt.timer?.cancel()
  rt.timer = $.clock.after(REFRESH_DELAY_MS, () => void refresh($, rt).catch(() => undefined))
}

/** The installed guards and the project's relevance, read once (a command may come before the start's background work ends). */
async function ensureReady($: EngineInterface, rt: Runtime): Promise<void> {
  await knownInstalled($, rt)
  if (rt.relevant.size === 0) await checkRelevance($, rt)
}

async function startSession($: EngineInterface, rt: Runtime): Promise<void> {
  await ensureReady($, rt)
  await refresh($, rt)
  await hubShare($, rt.policy, rt.root)
}

// ── Actions (commands and buttons) ──────────────────────────────────────────────────────────────────

async function setLevel($: EngineInterface, rt: Runtime, level: PolicyLevel): Promise<string> {
  rt.policy = policyFor(level, { base: level === 'custom' ? rt.policy.base : undefined, overrides: rt.overrides, fallback: rt.policy.fallback })
  rt.source = 'project'
  const isSaved = await savePolicy($, rt)
  await update($, confirmAtom, () => false)
  const snapshot = await refresh($, rt)
  const pending = snapshot.changes.length
  const text = [
    `Level ${level} for ${projectName(rt.root)}${isSaved ? ` (saved to ${PROJECT_FILE})` : ' (the project file could not be written)'}.`,
    pending === 0 ? 'Your installed guards already match it.' : `${plural(pending, 'option change')} ready: press Apply in the Guardian tab or run /guardian apply.`,
    rt.policy.isFallbackOn ? 'The fallback guard is on for critical cases of guards that are not installed.' : '',
  ].filter(line => line !== '').join(' ')
  await update($, noticeAtom, () => text)
  return text
}

/** Same option changes, value for value (what was reviewed is what gets written). */
const sameChanges = (a: readonly Change[], b: readonly Change[]): boolean =>
  a.length === b.length && a.every((change, index) => {
    const other = b[index]
    return other !== undefined && other.key === change.key && other.option === change.option && other.before === change.before && other.after === change.after
  })

/**
 * Backs settings.json up, then writes the policy's options for the installed guards into `pluginConfigs`.
 * `reviewed`: the diff the person confirmed in the tab; when settings.json, the installed guards or the policy
 * changed since, nothing is written and the new diff is shown for another review.
 */
async function applyPolicy($: EngineInterface, rt: Runtime, reviewed?: readonly Change[]): Promise<string> {
  await update($, confirmAtom, () => false)
  if (rt.settingsPath === '') return 'Cannot find your settings file (HOME is not set).'
  const exists = await $.fs.exists(rt.settingsPath).catch(() => false)
  const text = exists ? await $.fs.read(rt.settingsPath).catch(() => undefined) : '{}'
  let settings: unknown
  try {
    settings = text === undefined ? undefined : JSON.parse(text)
  } catch {
    settings = undefined
  }
  if (text === undefined || !isObject(settings)) {
    const failed = `Nothing applied: ${rt.settingsPath} is not a JSON object guardian can edit safely.`
    await update($, noticeAtom, () => failed)
    return failed
  }
  const installed = (await knownInstalled($, rt)) ?? new Set<string>()
  const changes = planApply(settings, rt.policy, installed, rt.options.marketplace)
  if (reviewed !== undefined && !sameChanges(reviewed, changes)) {
    const stale = 'Nothing applied: the changes differ from the diff you reviewed (settings.json or the installed guards changed). Review the new diff.'
    await refresh($, rt)
    if (changes.length > 0) await update($, confirmAtom, () => true)
    await update($, noticeAtom, () => stale)
    return stale
  }
  if (changes.length === 0) {
    const done = 'Nothing to apply: the installed guards already match the policy.'
    await update($, noticeAtom, () => done)
    await refresh($, rt)
    return done
  }
  const backup = exists ? `${rt.settingsPath}.guardian-${stamp(await $.clock.now())}.bak` : undefined
  try {
    if (backup !== undefined) await $.fs.write(backup, text)
    await $.fs.write(rt.settingsPath, `${JSON.stringify(applyChanges(settings, changes), null, 2)}\n`)
  } catch (error) {
    const failed = `Nothing applied: could not write ${rt.settingsPath} (${error instanceof Error ? error.message : String(error)}).`
    await update($, noticeAtom, () => failed)
    return failed
  }
  const guards = new Set(changes.map(change => change.guard)).size
  const done = `Applied ${plural(changes.length, 'option')} to ${plural(guards, 'guard')}${backup === undefined ? '' : ` (backup: ${backup})`}. Run /reload-plugins so running guards pick them up.`
  await update($, noticeAtom, () => done)
  await refresh($, rt)
  return done
}

async function installGuard($: EngineInterface, rt: Runtime, name: string): Promise<string> {
  if (!GUARD_NAMES.has(name)) return `guardian does not know a guard named "${name}".`
  await update($, busyAtom, () => `Installing ${name}…`)
  let text: string
  try {
    const ran = await $.process.run([await claudeBin($, rt), 'plugin', 'install', `${name}@${rt.options.marketplace}`, '--scope', 'user', '--json'], { timeoutMs: INSTALL_TIMEOUT_MS })
    const said = `${ran.stdout}\n${ran.stderr}`.trim().split('\n').pop() ?? ''
    text = ran.exitCode === 0 ? `Installed ${name}. Run /reload-plugins to activate it, then Apply to configure it.` : `Could not install ${name}: ${oneLine(said, 160) || `exit code ${ran.exitCode}`}`
  } catch (error) {
    text = `Could not install ${name}: ${error instanceof Error ? error.message : String(error)}`
  }
  await update($, busyAtom, () => null)
  await knownInstalled($, rt, true)
  await refresh($, rt)
  await update($, noticeAtom, () => text)
  return text
}

async function reloadPlugins($: EngineInterface): Promise<void> {
  try {
    await $.command.run({ command: 'reload-plugins', args: '' })
  } catch {
    $.ui.toast('Run /reload-plugins to apply the change')
  }
}

async function openView($: EngineInterface): Promise<void> {
  if (!(await hubShowTab($, TAB.id))) await $.ui.open({ id: PANE, title: TAB.title })
}

function summary(snapshot: GuardianSnapshot): string {
  const lines = [
    `Guardian — ${snapshot.level}${snapshot.level === 'custom' ? ` (on ${snapshot.base})` : ''}${snapshot.source === 'project' ? ` from ${PROJECT_FILE}` : ''} · safety ${scoreLine(snapshot.score)}`,
    ...snapshot.score.parts.map(part => `  ${part.label}: ${part.points}/${part.max} — ${part.detail}`),
  ]
  if (snapshot.score.fixes.length > 0) lines.push('Top fixes:', ...snapshot.score.fixes.map((fix, index) => `  ${index + 1}. ${fix.text} (+${fix.gain})`))
  const covered = snapshot.rows.filter(row => row.isCoveredByFallback && row.isRelevant).map(row => row.name)
  if (snapshot.isFallbackOn && covered.length > 0) lines.push(`Fallback guard covers: ${covered.join(', ')}`)
  if (snapshot.changes.length > 0) lines.push(`${plural(snapshot.changes.length, 'option change')} pending — /guardian apply to review.`)
  return lines.join('\n')
}

async function runCommand($: EngineInterface, rt: Runtime, args: string, origin: PromptOrigin): Promise<string> {
  const [verb = '', ...rest] = args.trim().split(/\s+/).filter(word => word !== '')
  await ensureReady($, rt)
  switch (verb) {
    case '': {
      const snapshot = await refresh($, rt)
      await openView($)
      return summary(snapshot)
    }
    case 'score':
      return summary(await refresh($, rt))
    case 'level': {
      const level = rest[0]
      if (!isPolicyLevel(level)) return USAGE
      return setLevel($, rt, level)
    }
    case 'apply': {
      if (rest.includes('--yes')) {
        if (!isPerson(origin)) return 'Only you can apply the policy: type /guardian apply --yes yourself.'
        return applyPolicy($, rt)
      }
      const snapshot = await refresh($, rt)
      if (snapshot.changes.length === 0) return 'Nothing to apply: the installed guards already match the policy.'
      return [
        `Applying the ${snapshot.level} policy changes ${rt.settingsPath} (pluginConfigs only; backed up first):`,
        ...snapshot.changes.slice(0, 40).map(change => `  ${describeChange(change, 200)}`),
        'Run /guardian apply --yes, or press Apply in the Guardian tab, to write them.',
      ].join('\n')
    }
    case 'install': {
      const name = rest[0] ?? ''
      if (!isPerson(origin)) return 'Only you can install guards: type the command yourself.'
      return installGuard($, rt, name)
    }
    default:
      return USAGE
  }
}

// ── The guard: fallback blocks at strict, and what the other guards did ─────────────────────────────

type ToolInput = Readonly<Record<string, unknown>> & { tool: string }

/** The findings guardian blocks now: strict, fallback on, and the guard for the case not installed. */
function blocking(rt: Runtime, findings: readonly Finding[]): Finding[] {
  if (!rt.policy.isFallbackOn) return []
  return findings.filter(finding => rt.installed?.has(finding.guard) !== true)
}

async function guardCall($: EngineInterface, rt: Runtime, e: ToolCallInput, next: (e: ToolCallInput) => Promise<ToolCallResult>): Promise<ToolCallResult> {
  const tool = String(e.tool)
  const findings = criticalFindings(tool, e as ToolInput)
  const stop = blocking(rt, findings)[0]
  if (stop !== undefined) {
    const reason = `${stop.reason} (strict-level fallback for ${stop.guard}, which is not installed)`
    $.clock.after(0, () => void reportBlock($, rt, tool, stop, reason))
    return { deny: `guardian: ${reason}. Ask the user, or install ${stop.guard} for the full guard.` }
  }
  const ran = await next(e)
  if (ran.deny !== undefined) {
    const guard = DENY_PREFIX.exec(ran.deny.trim())?.[1]
    if (guard !== undefined && GUARD_NAMES.has(guard)) {
      const reason = oneLine(ran.deny.replace(DENY_PREFIX, ''), 200)
      const raw = (e as ToolInput).command
      const command = typeof raw === 'string' ? oneLine(raw, 200) : undefined
      $.clock.after(0, () => void recordBlock($, rt, { guard, tool, reason, severity: 'medium', ...(command === undefined ? {} : { command }), source: 'observed' }).then(() => scheduleRefresh($, rt)))
    }
  } else if (ran.isError !== true && findings.length > 0) {
    $.clock.after(0, () => void recordAllowed($, rt, findings).then(() => scheduleRefresh($, rt)))
  }
  return ran
}

async function reportBlock($: EngineInterface, rt: Runtime, tool: string, finding: Finding, reason: string): Promise<void> {
  const command = finding.command === undefined ? undefined : oneLine(finding.command, 200)
  await recordBlock($, rt, { guard: 'guardian', for: finding.guard, tool, reason, severity: 'high', ...(command === undefined ? {} : { command }), ...(finding.path === undefined ? {} : { path: finding.path }), source: 'guardian' })
  await hubPublish($, { topic: 'risk.blocked', data: { guard: 'guardian', tool, reason, severity: 'high', ...(command === undefined ? {} : { command }), ...(finding.path === undefined ? {} : { path: finding.path }) } })
  await refresh($, rt)
}

// ── Drawing: the Guardian tab body (and the /guardian pane without the hub) ─────────────────────────

const GAUGE_WIDTH = 24

const gauge = (score: number, width: number): string => {
  const filled = Math.round((score / 100) * width)
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}

const scoreColor = (score: number): 'success' | 'warning' | 'error' => (score >= 75 ? 'success' : score >= 50 ? 'warning' : 'error')

const pad = (text: string, width: number): string => (text.length >= width ? `${text.slice(0, width - 1)} ` : text.padEnd(width))

function rowStatus(row: GuardianRow): string {
  if (row.isInstalled) return row.pending === 0 ? 'configured' : `${plural(row.pending, 'change')} pending`
  if (row.isCoveredByFallback) return 'fallback'
  return row.isRecommended ? 'missing' : 'optional'
}

async function drawBody($: EngineInterface, e: RenderInput<'Pane'>, rt: Runtime): Promise<RenderElement> {
  const { Box, Button, Text } = $.ui.resolve(e)
  const snapshot = await read($, snapshotAtom)
  const isConfirming = await read($, confirmAtom)
  const notice = await read($, noticeAtom)
  const busy = await read($, busyAtom)
  if (snapshot === null) return <Box key="guardian-loading"><Text dimColor>Guardian is reading the project…</Text></Box>

  const width = Math.max(30, e.props.bodyColumns)
  const isNarrow = width < NARROW
  const score = snapshot.score
  const rows = snapshot.rows.filter(row => row.isRelevant && (row.isRecommended || row.isInstalled))
  const others = snapshot.rows.filter(row => row.isRelevant && !row.isRecommended && !row.isInstalled).length

  const chips = (
    <Box key="levels" flexDirection="row" flexWrap="wrap" columnGap={1}>
      <Text bold>Level</Text>
      {POLICY_LEVELS.map(level => (
        <Button key={`level-${level}`} label={level} hotkey={HOTKEYS[level]} variant={snapshot.level === level ? 'primary' : 'secondary'} onPress={() => setLevel($, rt, level).then(() => undefined)} />
      ))}
      <Text dimColor>{snapshot.source === 'project' ? PROJECT_FILE : 'mod setting'}</Text>
    </Box>
  )

  const fixes = score.fixes.map((fix, index) => {
    const action = fix.action
    return (
      <Box key={`fix-${index}`} flexDirection="row" columnGap={1}>
        <Text>{`${index + 1}. ${fix.text}`}</Text>
        <Text color="success">{`+${fix.gain}`}</Text>
        {action?.kind === 'install' ? <Button key={`fix-install-${action.name}`} label="Install" onPress={() => installGuard($, rt, action.name).then(() => undefined)} /> : null}
        {action?.kind === 'apply' ? <Button key="fix-apply" label="Review" onPress={() => update($, confirmAtom, () => true).then(() => undefined)} /> : null}
        {action?.kind === 'level' ? <Button key="fix-level" label="Go strict" onPress={() => setLevel($, rt, action.level).then(() => undefined)} /> : null}
      </Box>
    )
  })

  const diff = isConfirming ? (
    <Box key="confirm" flexDirection="column" marginTop={1}>
      <Text bold>{`Apply ${plural(snapshot.changes.length, 'change')} to ${snapshot.settingsPath} (pluginConfigs only, backed up first):`}</Text>
      {/* Every change, values in full: what Confirm writes is exactly what is listed here. */}
      {snapshot.changes.map((change, index) => (
        <Box key={`diff-${index}`}><Text wrap="wrap">{`  ${describeChange(change, DIFF_VALUE_MAX)}`}</Text></Box>
      ))}
      <Box flexDirection="row" columnGap={1}>
        <Button key="confirm-apply" label="Confirm" variant="primary" onPress={() => applyPolicy($, rt, snapshot.changes).then(() => undefined)} />
        <Button key="cancel-apply" label="Cancel" onPress={() => update($, confirmAtom, () => false).then(() => undefined)} />
      </Box>
    </Box>
  ) : snapshot.changes.length > 0 ? (
    <Box key="apply-row" flexDirection="row" columnGap={1} marginTop={1}>
      <Button key="apply" label={`Apply ${plural(snapshot.changes.length, 'change')}`} hotkey="a" variant="primary" onPress={() => update($, confirmAtom, () => true).then(() => undefined)} />
      <Text dimColor>review first: nothing is written until you confirm</Text>
    </Box>
  ) : null

  const matrix = (
    <Box key="matrix" flexDirection="column" marginTop={1}>
      <Text bold>{isNarrow ? 'Guards' : `${pad('Guard', 22)}${pad('Protects', 30)}${pad('Status', 20)}Last block`}</Text>
      {rows.map(row => (
        <Box key={`row-${row.name}`} flexDirection="row" columnGap={1}>
          <Text color={row.isInstalled ? 'success' : row.isCoveredByFallback ? 'warning' : 'error'}>{row.isInstalled ? '✓' : row.isCoveredByFallback ? '◐' : '✗'}</Text>
          <Text>
            {isNarrow
              ? `${row.name} · ${rowStatus(row)}${row.lastBlockAt === null ? '' : ` · ${ago(row.lastBlockAt, snapshot.updatedAt)}`}`
              : `${pad(row.name, 20)}${pad(row.title, 30)}${pad(rowStatus(row), 20)}${row.lastBlockAt === null ? '—' : ago(row.lastBlockAt, snapshot.updatedAt)}`}
          </Text>
          {!row.isInstalled && row.isRecommended ? <Button key={`install-${row.name}`} label="Install" onPress={() => installGuard($, rt, row.name).then(() => undefined)} /> : null}
        </Box>
      ))}
      {others > 0 ? <Text dimColor>{`${plural(others, 'more guard')} optional at ${snapshot.base}: /guardian level strict lists them`}</Text> : null}
    </Box>
  )

  const feed = (
    <Box key="feed" flexDirection="column" marginTop={1}>
      <Text bold>Recent blocks</Text>
      {snapshot.blocks.length === 0 ? <Text dimColor>Nothing blocked in the last 7 days.</Text> : null}
      {snapshot.blocks.slice(-FEED_SHOWN).reverse().map(block => (
        <Box key={`block-${block.id}`}>
          <Text>
            <Text dimColor>{`${ago(block.at, snapshot.updatedAt)} `}</Text>
            <Text color={block.severity === 'high' ? 'error' : 'warning'}>{block.guard === 'guardian' && block.for !== undefined ? `guardian→${block.for}` : block.guard}</Text>
            {` ${oneLine(block.command ?? block.path ?? block.reason, Math.max(20, width - 30))}`}
          </Text>
        </Box>
      ))}
    </Box>
  )

  return (
    <Box key="guardian-body" flexDirection="column">
      {chips}
      <Box key="gauge" flexDirection="row" columnGap={1} marginTop={1}>
        <Text bold>Safety</Text>
        <Text color={scoreColor(score.score)}>{gauge(score.score, Math.min(GAUGE_WIDTH, Math.max(8, width - 30)))}</Text>
        <Text bold color={scoreColor(score.score)}>{scoreLine(score)}</Text>
      </Box>
      <Box key="parts" flexDirection="column">
        {score.parts.map(part => (
          <Text dimColor>{`${part.label} ${part.points}/${part.max} — ${part.detail}`}</Text>
        ))}
      </Box>
      {fixes.length > 0 ? (
        <Box key="fixes" flexDirection="column" marginTop={1}>
          <Text bold>Top fixes</Text>
          {fixes}
        </Box>
      ) : null}
      {diff}
      {busy !== null ? <Text color="warning">{busy}</Text> : null}
      {notice !== null && busy === null ? (
        <Box key="notice" flexDirection="row" columnGap={1}>
          <Text color="suggestion">{notice}</Text>
          <Button key="reload" label="Reload plugins" plain hotkey="r" onPress={() => reloadPlugins($)} />
        </Box>
      ) : null}
      {matrix}
      {feed}
    </Box>
  )
}

// ── Registration ────────────────────────────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  const rt = newRuntime({
    level: isPolicyLevel(options.level) ? options.level : 'standard',
    fallback: options.fallback !== false,
    marketplace: typeof options.marketplace === 'string' && options.marketplace.trim() !== '' ? options.marketplace.trim() : 'claude-mods',
  })

  on('session.start', async ($, e, next) => {
    await registerCommand($, { name: 'guardian', description: 'Security level for every guard mod, the project safety score and what to fix', argumentHint: '[level <permissive|standard|strict|custom> | apply | install <guard> | score]' })
    // Waits until session.start has returned (afterStart): with every mod installed, waiting on the hub, the disk
    // or a process here ran session.start past its 10 s budget.
    afterStart($, 'guardian', async () => {
      await hubHello($, { version: VERSION, publishes: ['risk.blocked'], consumes: ['risk.blocked', 'secret.detected'] }, TAB)
    })
    await locate($, rt)
    await loadPolicy($, rt)
    $.clock.after(0, () => void startSession($, rt).catch(() => undefined))
    return next(e)
  })

  on('command.run', { command: 'guardian' }, async ($, e) => ({ text: await runCommand($, rt, e.args, e.origin) }))

  on('tool.call', async ($, e, next) => guardCall($, rt, e, next)).catch(($, e, next) =>
    next.called || !rt.policy.isFallbackOn || criticalFindings(String(e.tool), e as ToolInput).length === 0 ? next(e) : { deny: 'guardian: its strict-level check failed on a critical command; ask the user.' },
  )

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && rt.root !== '') scheduleRefresh($, rt)
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: HUB_PANE }, async ($, e, next) => {
    if (!(await hubTabIs($, TAB.id))) return next(e)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {await next(e)}
        {await drawBody($, e, rt)}
      </Box>
    )
  })
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawBody($, e, rt))
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
