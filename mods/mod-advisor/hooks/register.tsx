import { atom, read, update } from 'claude-code'
import type { CommandRunResult, EngineInterface, FsEntry, ProcessRunResult, PromptOrigin, Register, RenderElement, RenderInput, Timer } from 'claude-code'

import type {
  AdvisorBand,
  AdvisorCatalog,
  AdvisorFit,
  AdvisorFresh,
  AdvisorInstalled,
  AdvisorMod,
  AdvisorNotice,
  AdvisorPick,
  AdvisorSync,
  AdvisorUsage,
} from '../types'
import {
  argv,
  CATALOG_PATH,
  claudeBinary,
  commandsOf,
  DEFAULT_BRANCH,
  DEFAULT_MARKETPLACE,
  DEFAULT_REPOSITORY,
  formatAge,
  installLine,
  isBranch,
  isCatalogOf,
  isRepository,
  MARKETPLACE_PATH,
  marketplaceOf,
  parseArgs,
  parseCatalog,
  parseInstalled,
  parseMarketplaceCatalog,
  parseMarketplaces,
  parseOutcome,
  plural,
  rawUrl,
  readmeRawUrl,
  readmeUrl,
  tipLine,
  usageOf,
} from './catalog'
import type { KnownMarketplace, Source } from './catalog'
import { baseName, changesOf, depsOf, isManifest, isSkipped, joinPath, relativeTo, SKIP_DIRS } from './project'
import {
  buildIndex,
  DECAY,
  describeEvidence,
  detectStack,
  NOW_MIN,
  PROJECT_MIN,
  projectScore,
  rankIntent,
  rankProject,
  reasonOf,
  recommendable,
  rollIntent,
  stackLabels,
  TIP_MIN,
} from './score'
import type { Evidence, IntentIndex, IntentScored, ProjectFacts, Scored } from './score'
import { hasInstallSignal, SIGNAL_TOPICS, signalPicks } from './signals'
import type { Signal } from './signals'

type Dollar = EngineInterface

/** The advisor's settings, from userConfig. */
type Config = {
  source: Source
  problem: string | undefined
  autoOpen: boolean
  useModel: boolean
  tellClaude: boolean
}

/** What the advisor keeps per project in $.store: the last fit announced, a snooze, the mods dismissed. */
type ProjectPrefs = { shownVersion?: string; shownNames?: string[]; snoozedUntil?: number; dismissed?: string[] }

/** What a scan found: paths relative to the root, and each manifest's dependencies. */
type Facts = { root: string; files: Set<string>; dirs: Set<string>; manifests: Map<string, string[]> }

/** Changes seen since the last rescan, waiting for the debounce. */
type Pending = { paths: Set<string>; manifests: Set<string>; installs: boolean; isFull: boolean }

/** The facts as they stood before a change, to tell what is new. */
type Before = { files: ReadonlySet<string>; dirs: ReadonlySet<string>; deps: ReadonlySet<string> }

/** This load's working memory: mirrors of the state the hooks read without waiting, and the session's counters. */
type Runtime = {
  config: Config
  /** False for a `-p` run or an SDK session: no pane, no tips, no scans. */
  isInteractive: boolean
  started: Promise<void> | undefined
  marketplace: string
  catalog: AdvisorCatalog | undefined
  index: { key: string; value: IntentIndex } | undefined
  installed: Set<string> | undefined
  live: Record<string, string[]>
  facts: Facts | undefined
  prefs: ProjectPrefs
  isQuiet: boolean
  pending: Pending
  debounce: Timer | undefined
  fullTimer: Timer | undefined
  lastFullScan: number
  prompts: IntentScored[][]
  tipped: Set<string>
  told: Set<string>
  surfaced: Set<string>
  lastTipAt: number
  lastNotifyAt: number
  bandPrompts: number
  isWorking: boolean
  refreshing: Promise<void> | undefined
  binary: string | undefined
  usagesLoading: Set<string>
  /** Whether mods-hub answered this session's hello: the Advisor is then a tab of its panel. */
  hasHub: boolean
  /** The newest hub event already read for signals. */
  lastSignalAt: number
  /** The stack last shared on the hub's blackboard, to share it only when it changes. */
  sharedStack: string
}

const SELF = 'mod-advisor'
const PANE = 'mod-advisor'
const PANE_TITLE = 'Advisor'
/** The hub's shared panel, and the Advisor's tab in it (order 10: the first tab). */
const HUB_PANE = 'claude-mods'
const TAB = { id: 'advisor', title: 'Advisor', order: 10, command: 'mods-advisor' } as const
const COMMAND = 'mods-advisor'
const ARGUMENT_HINT = '[refresh | quiet [on|off] | why <mod> | reset | <search words>]'
const CATALOG_KEY = 'catalog'
const QUIET_KEY = 'quiet'
const PROJECTS_KEY = 'projects'
const USAGE_KEY = 'usage:'
const MINUTE_MS = 60_000
const CATALOG_TTL_MS = 12 * 60 * MINUTE_MS
const FETCH_TIMEOUT_MS = 10_000
const LIST_TIMEOUT_MS = 30_000
const CHANGE_TIMEOUT_MS = 180_000
const MODEL_TIMEOUT_MS = 8_000
const MODEL = 'haiku'
const RERANK_CANDIDATES = 10
const DEBOUNCE_MS = 5_000
const FULL_SCAN_GAP_MS = 10 * MINUTE_MS
const TIP_GAP_MS = 10 * MINUTE_MS
const NOTIFY_GAP_MS = 15 * MINUTE_MS
const SNOOZE_MS = 7 * 24 * 60 * MINUTE_MS
const FRESH_HIGHLIGHT_MS = 15 * MINUTE_MS
const BAND_PROMPTS = 3
const TOAST_MS = 8_000
const SCAN_DEPTH = 3
const SCAN_MAX_DIRS = 150
const SCAN_SUBTREE_DEPTH = 2
const MANIFESTS_READ = 12
const PROJECTS_KEPT = 100
const FRESH_KEPT = 8
const NEW_PER_PROMPT = 2
const NOW_SHOWN = 4
const FIT_FOLDED = 5
const CONTEXT_MODS = 3
const BAND_NAMES = 3
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const TONE_COLOR: Record<AdvisorNotice['tone'], string> = { success: 'success', error: 'error', info: 'suggestion' }
const TONE_GLYPH: Record<AdvisorNotice['tone'], string> = { success: '✓', error: '✗', info: '•' }

const catalogState = atom({ plugin: 'mod-advisor', key: 'catalog' } as const, null)
const syncState = atom({ plugin: 'mod-advisor', key: 'sync' } as const, { phase: 'idle' })
const installedState = atom({ plugin: 'mod-advisor', key: 'installed' } as const, null)
const fitState = atom({ plugin: 'mod-advisor', key: 'fit' } as const, null)
const nowState = atom({ plugin: 'mod-advisor', key: 'now' } as const, null)
const freshState = atom({ plugin: 'mod-advisor', key: 'fresh' } as const, [])
const bandState = atom({ plugin: 'mod-advisor', key: 'band' } as const, null)
const viewState = atom({ plugin: 'mod-advisor', key: 'view' } as const, { query: '', howTo: null, isFitUnfolded: false })
const busyState = atom({ plugin: 'mod-advisor', key: 'busy' } as const, null)
const noticeState = atom({ plugin: 'mod-advisor', key: 'notice' } as const, null)
const usagesState = atom({ plugin: 'mod-advisor', key: 'usages' } as const, {})
const commandsState = atom({ plugin: 'mod-advisor', key: 'commands' } as const, {})
const dismissedState = atom({ plugin: 'mod-advisor', key: 'dismissed' } as const, [])
const quietState = atom({ plugin: 'mod-advisor', key: 'quiet' } as const, false)
const paneState = atom({ plugin: 'mod-advisor', key: 'pane' } as const, { isOpen: false, isPlaced: false })
/** Whether this session already opened the panel by itself: host state outlives a hot reload, so a reload does not steal the visible tab again. */
const autoShownState = atom({ plugin: 'mod-advisor', key: 'autoShown' } as const, false)

const emptyPending = (): Pending => ({ paths: new Set(), manifests: new Set(), installs: false, isFull: false })

const isPerson = (origin: PromptOrigin): boolean =>
  PERSON_ORIGINS.has(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)

/** An error's message, without the `<plugin>: $.<noun>.<event>: ` prefix a refused `$` call carries. */
const describe = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^[\w-]+: \$\.[\w.]+: /, '')

const success = (text: string): AdvisorNotice => ({ tone: 'success', text, canReload: true })
const failure = (text: string): AdvisorNotice => ({ tone: 'error', text, canReload: false })
const info = (text: string): AdvisorNotice => ({ tone: 'info', text, canReload: false })

function configOf(options: Record<string, unknown>): Config {
  const source = {
    repository: String(options.repository ?? DEFAULT_REPOSITORY).trim(),
    branch: String(options.branch ?? DEFAULT_BRANCH).trim(),
  }
  const problem = !isRepository(source.repository)
    ? `the repository setting "${source.repository}" is not owner/repo`
    : !isBranch(source.branch) ? `the branch setting "${source.branch}" is not a branch name` : undefined

  return {
    source,
    problem,
    autoOpen: options.autoOpen !== false,
    useModel: options.useModel === true,
    tellClaude: options.tellClaude !== false,
  }
}

function newRuntime(config: Config): Runtime {
  return {
    config,
    isInteractive: true,
    started: undefined,
    marketplace: DEFAULT_MARKETPLACE,
    catalog: undefined,
    index: undefined,
    installed: undefined,
    live: {},
    facts: undefined,
    prefs: {},
    isQuiet: false,
    pending: emptyPending(),
    debounce: undefined,
    fullTimer: undefined,
    lastFullScan: 0,
    prompts: [],
    tipped: new Set(),
    told: new Set(),
    surfaced: new Set(),
    lastTipAt: Number.NEGATIVE_INFINITY,
    lastNotifyAt: Number.NEGATIVE_INFINITY,
    bandPrompts: 0,
    isWorking: false,
    refreshing: undefined,
    binary: undefined,
    usagesLoading: new Set(),
    hasHub: false,
    lastSignalAt: 0,
    sharedStack: '',
  }
}

/** Forgets what one session saw: a new session starts its tips, notes and "new" list afresh. */
function forgetSession(rt: Runtime): void {
  rt.debounce?.cancel()
  rt.fullTimer?.cancel()
  Object.assign(rt, {
    started: undefined,
    facts: undefined,
    pending: emptyPending(),
    debounce: undefined,
    fullTimer: undefined,
    prompts: [],
    tipped: new Set(),
    told: new Set(),
    surfaced: new Set(),
    lastTipAt: Number.NEGATIVE_INFINITY,
    lastNotifyAt: Number.NEGATIVE_INFINITY,
    bandPrompts: 0,
  })
}

const modOf = (rt: Runtime, name: string): AdvisorMod | undefined => rt.catalog?.mods.find(mod => mod.name === name)

const commandsFor = (rt: Runtime, mod: AdvisorMod): string[] => commandsOf(mod, rt.live[mod.name])

function indexOf(rt: Runtime, catalog: AdvisorCatalog): IntentIndex {
  const key = `${catalog.repository}@${catalog.branch}#${catalog.fetchedAt}#${catalog.mods.length}`
  if (rt.index?.key !== key) {
    rt.index = { key, value: buildIndex(catalog.mods) }
  }

  return rt.index.value
}

const isSnoozed = (rt: Runtime, now: number): boolean => (rt.prefs.snoozedUntil ?? 0) > now

const pickOf = (scored: Scored, reason = reasonOf(scored)): AdvisorPick => ({ name: scored.name, score: scored.score, reason })

// ── Catalog: GitHub first, then the cache, then the marketplace's local copy ──

function withTimeout<T>($: Dollar, work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = $.clock.after(ms, () => reject(new Error(`no answer within ${ms / 1000} s`)))
    work.then(
      value => {
        timer.cancel()
        resolve(value)
      },
      (error: unknown) => {
        timer.cancel()
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

async function fetchText($: Dollar, url: string): Promise<string> {
  const response = await withTimeout($, $.http.fetch(url), FETCH_TIMEOUT_MS)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url.replace(/^https:\/\/[^/]+\//, '')}`)
  }

  return response.text
}

async function claudeBin($: Dollar, rt: Runtime): Promise<string> {
  if (rt.binary === undefined) {
    let execPath: string | undefined
    try {
      execPath = await $.env.get('CLAUDE_CODE_EXECPATH')
    } catch {
      execPath = undefined
    }
    rt.binary = claudeBinary(execPath)
  }

  return rt.binary
}

function runCli($: Dollar, args: readonly string[], timeoutMs: number): Promise<ProcessRunResult> {
  return $.process.run(args, { timeoutMs })
}

/** The marketplaces the CLI knows; the one serving our repository names our mods' ids. */
async function knownMarketplaces($: Dollar, rt: Runtime): Promise<KnownMarketplace[]> {
  try {
    const listed = await runCli($, argv.marketplaces(await claudeBin($, rt)), LIST_TIMEOUT_MS)
    const known = listed.exitCode === 0 ? parseMarketplaces(listed.stdout) : []
    rt.marketplace = marketplaceOf(known, rt.config.source.repository)?.name ?? rt.marketplace
    return known
  } catch {
    return []
  }
}

/** The catalog of the marketplace already on disk (catalog.json beside it, else its marketplace file). */
async function localCatalog($: Dollar, rt: Runtime, now: number): Promise<AdvisorCatalog | undefined> {
  const location = marketplaceOf(await knownMarketplaces($, rt), rt.config.source.repository)?.installLocation
  if (location === undefined) {
    return undefined
  }
  try {
    return parseCatalog(await $.fs.read(joinPath(location, CATALOG_PATH)), rt.config.source, now, 'local')
  } catch {
    try {
      return parseMarketplaceCatalog(await $.fs.read(joinPath(location, MARKETPLACE_PATH)), rt.config.source, now)
    } catch {
      return undefined
    }
  }
}

async function showCatalog($: Dollar, rt: Runtime, catalog: AdvisorCatalog, sync: AdvisorSync): Promise<AdvisorCatalog> {
  rt.catalog = catalog
  await update($, catalogState, () => catalog)
  await update($, syncState, () => sync)

  return catalog
}

/**
 * The catalog: the cached copy while it is under 12 hours old (unless
 * forced), else a fresh fetch; offline, the cache, then the marketplace's
 * local copy. Never rejects; undefined when there is none at all.
 */
async function loadCatalog($: Dollar, rt: Runtime, isForced: boolean): Promise<AdvisorCatalog | undefined> {
  const { source, problem } = rt.config
  if (problem !== undefined) {
    await update($, syncState, (): AdvisorSync => ({ phase: 'error', message: problem }))
    return undefined
  }
  const now = await $.clock.now()
  let cached = rt.catalog
  if (cached === undefined) {
    const stored = await $.store.get(CATALOG_KEY).catch(() => undefined)
    cached = isCatalogOf(stored, source) ? stored : undefined
  }
  if (!isForced && cached !== undefined && cached.origin === 'github' && now - cached.fetchedAt < CATALOG_TTL_MS) {
    return showCatalog($, rt, cached, { phase: 'live' })
  }
  await update($, syncState, (): AdvisorSync => ({ phase: 'syncing' }))
  try {
    const fetched = parseCatalog(await fetchText($, rawUrl(source, CATALOG_PATH)), source, now, 'github')
    await $.store.set(CATALOG_KEY, fetched).catch(() => undefined)
    return await showCatalog($, rt, fetched, { phase: 'live' })
  } catch (error) {
    const message = describe(error)
    if (cached !== undefined) {
      return showCatalog($, rt, cached, { phase: 'offline', message })
    }
    const local = await localCatalog($, rt, now)
    if (local !== undefined) {
      return showCatalog($, rt, local, { phase: 'offline', message: `${message}; using the marketplace's local copy` })
    }
    await update($, syncState, (): AdvisorSync => ({ phase: 'error', message }))
    return undefined
  }
}

// ── Installed mods and their commands ────────────────────────────────────────

async function refreshInstalled($: Dollar, rt: Runtime): Promise<AdvisorInstalled> {
  let installed: AdvisorInstalled
  try {
    const listed = await runCli($, argv.list(await claudeBin($, rt)), LIST_TIMEOUT_MS)
    if (listed.exitCode !== 0) {
      throw new Error(parseOutcome(listed).message)
    }
    installed = { isKnown: true, mods: parseInstalled(listed.stdout, rt.marketplace) }
    rt.installed = new Set(Object.keys(installed.mods))
  } catch (error) {
    installed = { isKnown: false, error: describe(error) }
  }
  await update($, installedState, () => installed)

  return installed
}

/** The slash commands each plugin registered in this session: what an installed mod really answers to. */
async function refreshLiveCommands($: Dollar, rt: Runtime): Promise<void> {
  try {
    const live: Record<string, string[]> = {}
    for (const command of await $.command.list()) {
      const owner = command.source === 'plugin' ? command.plugin?.split('@')[0] : undefined
      if (owner !== undefined && owner !== '') {
        live[owner] = [...(live[owner] ?? []), `/${command.name}`]
      }
    }
    rt.live = live
    await update($, commandsState, () => live)
  } catch {
    // Without the live list, the catalog's commands and the descriptions still answer.
  }
}

// ── Per-project preferences ──────────────────────────────────────────────────

async function readProjects($: Dollar): Promise<Record<string, ProjectPrefs>> {
  const stored = await $.store.get(PROJECTS_KEY).catch(() => undefined)
  return typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? (stored as Record<string, ProjectPrefs>) : {}
}

async function savePrefs($: Dollar, rt: Runtime): Promise<void> {
  const root = rt.facts?.root
  if (root === undefined) {
    return
  }
  const projects = await readProjects($)
  delete projects[root]
  const kept = Object.entries(projects).slice(-(PROJECTS_KEPT - 1))
  await $.store.set(PROJECTS_KEY, Object.fromEntries([...kept, [root, rt.prefs]])).catch(() => undefined)
  await update($, dismissedState, () => rt.prefs.dismissed ?? [])
}

// ── The project: one full scan, then only what changed ───────────────────────

async function listDir($: Dollar, root: string, rel: string): Promise<{ rel: string; entries: FsEntry[] }> {
  try {
    return { rel, entries: await $.fs.list(joinPath(root, rel)) }
  } catch {
    return { rel, entries: [] }
  }
}

/** Walks `start` down to `depth` levels, breadth first, recording files and folders; skips heavy folders. */
async function walk($: Dollar, facts: Facts, start: string, depth: number): Promise<void> {
  let level = [start]
  let listed = 0
  for (let at = 0; at <= depth && level.length > 0 && listed < SCAN_MAX_DIRS; at += 1) {
    const batch = level.slice(0, SCAN_MAX_DIRS - listed)
    listed += batch.length
    const deeper: string[] = []
    for (const { rel, entries } of await Promise.all(batch.map(dir => listDir($, facts.root, dir)))) {
      for (const entry of entries) {
        const path = rel === '' ? entry.name : `${rel}/${entry.name}`
        if (entry.kind === 'dir') {
          facts.dirs.add(path)
          if (!SKIP_DIRS.has(entry.name)) deeper.push(path)
        } else {
          facts.files.add(path)
        }
      }
    }
    level = deeper
  }
}

/** Reads the manifests named (relative paths) into the facts; a manifest gone is forgotten. */
async function readManifests($: Dollar, facts: Facts, paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map(async path => {
    try {
      facts.manifests.set(path, depsOf(baseName(path), await $.fs.read(joinPath(facts.root, path))))
    } catch {
      facts.manifests.delete(path)
    }
  }))
}

const depthOf = (path: string): number => path.split('/').length

async function scanProject($: Dollar, root: string): Promise<Facts> {
  const facts: Facts = { root, files: new Set(), dirs: new Set(), manifests: new Map() }
  await walk($, facts, '', SCAN_DEPTH)
  const manifests = [...facts.files].filter(isManifest).sort((a, b) => depthOf(a) - depthOf(b)).slice(0, MANIFESTS_READ)
  await readManifests($, facts, manifests)

  return facts
}

const projectFacts = (facts: Facts): ProjectFacts => ({
  files: [...facts.files],
  dirs: [...facts.dirs],
  deps: [...new Set([...facts.manifests.values()].flat())],
})

const snapshot = (facts: Facts): Before => ({
  files: new Set(facts.files),
  dirs: new Set(facts.dirs),
  deps: new Set([...facts.manifests.values()].flat()),
})

/** Re-reads one changed path: a new file, a new folder (walked shallowly), or a path gone. */
async function notePath($: Dollar, facts: Facts, rel: string): Promise<void> {
  let kind: string | undefined
  try {
    kind = (await $.fs.stat(joinPath(facts.root, rel))).kind
  } catch {
    kind = undefined
  }
  if (kind === undefined) {
    for (const set of [facts.files, facts.dirs]) {
      for (const path of [...set]) {
        if (path === rel || path.startsWith(`${rel}/`)) set.delete(path)
      }
    }
    for (const path of [...facts.manifests.keys()]) {
      if (path === rel || path.startsWith(`${rel}/`)) facts.manifests.delete(path)
    }
    return
  }
  // Its folders exist too (a Write into `k8s/` made `k8s`).
  const parts = rel.split('/')
  for (let end = 1; end < parts.length; end += 1) {
    facts.dirs.add(parts.slice(0, end).join('/'))
  }
  if (kind === 'dir') {
    facts.dirs.add(rel)
    await walk($, facts, rel, SCAN_SUBTREE_DEPTH)
    return
  }
  facts.files.add(rel)
}

function queueChange($: Dollar, rt: Runtime, change: Partial<{ paths: string[]; manifests: string[]; installs: boolean; isFull: boolean }>): void {
  change.paths?.forEach(path => rt.pending.paths.add(path))
  change.manifests?.forEach(path => rt.pending.manifests.add(path))
  rt.pending.installs ||= change.installs === true
  rt.pending.isFull ||= change.isFull === true
  rt.debounce?.cancel()
  rt.debounce = $.clock.after(DEBOUNCE_MS, () => void flushChanges($, rt).catch(error =>
    $.ui.log(`rescan failed: ${describe(error)}`, { to: 'debug' })))
}

/** The rescan after the debounce: the paths and manifests that changed, or the whole project at most every 10 minutes. */
async function flushChanges($: Dollar, rt: Runtime): Promise<void> {
  rt.debounce = undefined
  const pending = rt.pending
  rt.pending = emptyPending()
  const facts = rt.facts
  if (facts === undefined) {
    return
  }
  const before = snapshot(facts)
  const now = await $.clock.now()
  if (pending.isFull && now - rt.lastFullScan >= FULL_SCAN_GAP_MS) {
    // A mod installed or removed from another terminal shows up here too.
    const [scanned] = await Promise.all([scanProject($, facts.root), refreshInstalled($, rt), refreshLiveCommands($, rt)])
    rt.facts = scanned
    rt.lastFullScan = now
    await reevaluate($, rt, before)
    return
  }
  if (pending.isFull && rt.fullTimer === undefined) {
    rt.fullTimer = $.clock.after(rt.lastFullScan + FULL_SCAN_GAP_MS - now, () => {
      rt.fullTimer = undefined
      queueChange($, rt, { isFull: true })
    })
  }
  for (const rel of pending.paths) {
    await notePath($, facts, rel)
  }
  const manifests = new Set([...pending.manifests, ...[...pending.paths].filter(isManifest)])
  if (pending.installs) {
    // An install may have created the first manifest too: look at the root again.
    const { entries } = await listDir($, facts.root, '')
    entries.filter(entry => entry.kind !== 'dir').forEach(entry => facts.files.add(entry.name))
    ;[...facts.files].filter(isManifest).forEach(path => manifests.add(path))
  }
  await readManifests($, facts, [...manifests].filter(path => facts.files.has(path)))
  await reevaluate($, rt, before)
}

// ── Judging: the project, the conversation ───────────────────────────────────

/** Never offered: what is installed, what was dismissed here, and the advisor itself. */
const excluded = (rt: Runtime): Set<string> => new Set([...(rt.installed ?? []), ...(rt.prefs.dismissed ?? []), SELF])

/** The first evidence whose cause is new since `before`: why a mod appeared now. */
function newReason(scored: Scored, before: Before): string | undefined {
  const isNew = (evidence: Evidence): boolean => {
    const cause = evidence.kind === 'stack' ? evidence.cause : evidence
    return cause.kind === 'file' ? !before.files.has(cause.detail) && !before.dirs.has(cause.detail)
      : cause.kind === 'dep' ? !before.deps.has(cause.detail)
      : false
  }
  const evidence = scored.evidence.find(isNew)
  return evidence === undefined ? undefined : describeEvidence(evidence, true)
}

/**
 * Scores the project again and draws "For this project"; with `before` (a
 * change mid-session), a mod that fits only now goes to "New for you".
 */
async function reevaluate($: Dollar, rt: Runtime, before?: Before): Promise<Scored[]> {
  const { catalog, facts } = rt
  if (catalog === undefined || facts === undefined) {
    return []
  }
  const { picks, stack } = rankProject(catalog.mods, projectFacts(facts), excluded(rt))
  const fit: AdvisorFit = { root: facts.root, stack: stackLabels(stack, 4), picks: picks.map(one => pickOf(one)) }
  await update($, fitState, () => fit)
  await shareStack($, rt, facts.root, stackLabels(stack, 8))
  if (before === undefined) {
    picks.forEach(one => rt.surfaced.add(one.name))
    return picks
  }
  const added = picks.filter(one => !rt.surfaced.has(one.name))
  added.forEach(one => rt.surfaced.add(one.name))
  if (added.length > 0) {
    await addFresh($, rt, added.map(one => ({ name: one.name, reason: newReason(one, before) ?? reasonOf(one) })))
  }

  return picks
}

/** Puts recommendations under "New for you" and, gently, says so. */
async function addFresh($: Dollar, rt: Runtime, items: readonly Omit<AdvisorFresh, 'at'>[]): Promise<void> {
  const at = await $.clock.now()
  await update($, freshState, list =>
    [...items.map(item => ({ ...item, at })), ...list.filter(old => !items.some(item => item.name === old.name))].slice(0, FRESH_KEPT))
  if (rt.hasHub) {
    for (const item of items) await hubPublish($, { topic: 'mod.recommended', data: { name: item.name, reason: item.reason } })
  }
  await notifyNew($, rt, items, at)
}

/** The fact `mod-advisor.stack` on the hub's blackboard (what the project is made of), when it changed. */
async function shareStack($: Dollar, rt: Runtime, root: string, stack: readonly string[]): Promise<void> {
  const key = JSON.stringify([root, stack])
  if (!rt.hasHub || key === rt.sharedStack) {
    return
  }
  rt.sharedStack = key
  try {
    await $.mods.share({ name: 'stack', value: { root, stack: [...stack] } })
  } catch {
    rt.sharedStack = ''
  }
}

/**
 * Terminal chatter (a new fit, a tip): through mods-hub's notifications, terminal only, when it is installed
 * (it holds them while Silent and keeps them in its panel), this mod's own toast otherwise.
 */
async function tell($: Dollar, text: string): Promise<void> {
  try {
    await $.mods.notify({ level: 'info', title: text, audience: 'terminal', topic: 'mod.recommended' })
  } catch {
    $.ui.toast(text, { timeoutMs: TOAST_MS })
  }
}

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: Dollar): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** With mods-hub installed: hello, and the Advisor tab in its panel. */
async function greetHub($: Dollar, rt: Runtime): Promise<void> {
  rt.hasHub = (await hubMode($)) !== undefined
  if (rt.hasHub) {
    rt.lastSignalAt = await $.clock.now()
    await hubHello($, { version: await ownVersion($), publishes: ['mod.recommended'], consumes: ['mod.installed', 'test.result', 'ci.result'] }, TAB)
  }
}

/** After a turn: what the hub's bus says happened (mods installed, tests or CI failing) since the last look. */
async function readSignals($: Dollar, rt: Runtime): Promise<void> {
  let signals: Signal[]
  try {
    signals = (await $.mods.recent({ since: rt.lastSignalAt }))
      .filter(event => SIGNAL_TOPICS.includes(event.topic))
      .map(event => ({ topic: event.topic, data: event.data, at: event.at }))
  } catch {
    return
  }
  if (signals.length === 0) {
    return
  }
  rt.lastSignalAt = Math.max(rt.lastSignalAt, ...signals.map(signal => signal.at))
  await ensureStarted($, rt)
  if (hasInstallSignal(signals)) {
    await Promise.all([refreshInstalled($, rt), refreshLiveCommands($, rt)])
    await reevaluate($, rt)
  }
  const known = new Set(rt.catalog?.mods.map(mod => mod.name) ?? [])
  const picks = signalPicks(signals, new Set([...excluded(rt), ...rt.surfaced])).filter(pick => known.has(pick.name)).slice(0, NEW_PER_PROMPT)
  picks.forEach(pick => rt.surfaced.add(pick.name))
  if (picks.length > 0) {
    await addFresh($, rt, picks)
  }
}

async function isPaneVisible($: Dollar): Promise<boolean> {
  try {
    const panes = await $.ui.panes()
    const isShown = (id: string) => panes.some(pane => pane.id === id && pane.isPlaced && pane.isShown)
    return isShown(PANE) || (isShown(HUB_PANE) && (await hubTabIs($, TAB.id)))
  } catch {
    return false
  }
}

/** One toast per 15 minutes at most, and the band while the pane is not on screen; never when quiet or snoozed. */
async function notifyNew($: Dollar, rt: Runtime, items: readonly Omit<AdvisorFresh, 'at'>[], now: number): Promise<void> {
  const first = items[0]
  if (first === undefined || rt.isQuiet || isSnoozed(rt, now) || now - rt.lastNotifyAt < NOTIFY_GAP_MS) {
    return
  }
  rt.lastNotifyAt = now
  await tell(
    $,
    items.length === 1
      ? `🧭 ${first.name} would help here (${first.reason}) · /${COMMAND}`
      : `🧭 ${items.length} new mods fit what you're doing · /${COMMAND}`,
  )
  if (!(await isPaneVisible($))) {
    await update($, bandState, (): AdvisorBand => ({ kind: 'new', names: items.map(item => item.name), stack: [] }))
  }
}

/** Once per project and catalog version: the fit, announced by the band while the pane is not on screen. */
async function announceFit($: Dollar, rt: Runtime, picks: readonly Scored[], stack: readonly string[]): Promise<void> {
  const catalog = rt.catalog
  const now = await $.clock.now()
  if (catalog === undefined || picks.length === 0 || rt.isQuiet || isSnoozed(rt, now)) {
    return
  }
  const names = picks.map(one => one.name)
  const shown = new Set(rt.prefs.shownNames ?? [])
  const isSeen = rt.prefs.shownVersion === catalog.version && names.every(name => shown.has(name))
  if (isSeen) {
    return
  }
  rt.prefs = { ...rt.prefs, shownVersion: catalog.version, shownNames: [...new Set([...shown, ...names])] }
  await savePrefs($, rt)
  if (!(await isPaneVisible($))) {
    await update($, bandState, (): AdvisorBand => ({ kind: 'fit', names, stack: [...stack] }))
  }
}

/** Re-ranks the best local matches with a small model; the local ranking stands when it does not answer. */
async function rerank($: Dollar, catalog: AdvisorCatalog, text: string, scores: readonly IntentScored[]): Promise<IntentScored[]> {
  const candidates = scores.slice(0, RERANK_CANDIDATES)
  const lines = candidates.map(one => `- ${one.name}: ${catalog.mods.find(mod => mod.name === one.name)?.description ?? ''}`)
  const prompt = [
    'A developer using Claude Code just wrote this request:',
    `"""${text.slice(0, 2000)}"""`,
    '',
    'Which of these Claude Code mods would genuinely help with it? Answer with their names only, best first, comma-separated, or "none".',
    ...lines,
  ].join('\n')
  const result = await $.model.complete({ model: MODEL, prompt, maxTokens: 100, effort: 'low', timeoutMs: MODEL_TIMEOUT_MS }).catch(() => undefined)
  if (result === undefined || !result.isAnswered) {
    return [...scores]
  }
  const named = candidates
    .map(one => ({ one, at: result.text.indexOf(one.name) }))
    .filter(({ at }) => at >= 0)
    .sort((a, b) => a.at - b.at)
    .map(({ one }) => one)

  return named.map((one, rank) => ({
    ...one,
    score: Math.max(one.score, TIP_MIN + 4 + named.length - rank),
    matches: Math.max(one.matches, 2),
    isStrong: true,
  }))
}

/** The note for Claude: installed mods that fit this prompt and what the person types to use them, each once per conversation. */
function contextNote(rt: Runtime, text: string): string | undefined {
  const { catalog, installed } = rt
  if (!rt.config.tellClaude || catalog === undefined || installed === undefined) {
    return undefined
  }
  const relevant = rankIntent(indexOf(rt, catalog), text)
    .filter(one => one.score >= TIP_MIN && installed.has(one.name) && !rt.told.has(one.name))
    .map(one => ({ one, mod: modOf(rt, one.name) }))
    .filter((item): item is { one: IntentScored; mod: AdvisorMod } => item.mod !== undefined && commandsFor(rt, item.mod).length > 0)
    .slice(0, CONTEXT_MODS)
  if (relevant.length === 0) {
    return undefined
  }
  relevant.forEach(({ one }) => rt.told.add(one.name))
  const lines = relevant.map(({ mod }) => `${commandsFor(rt, mod).join(', ')} (${mod.name}: ${mod.description})`)

  return `Installed Claude Code mods that fit this request, as slash commands the user can type: ${lines.join('; ')}. If one would help, tell the user they can type it; you cannot run it yourself.`
}

/** The tip toast: an installed mod's command that fits the prompt, once per mod per session, once per 10 minutes. */
async function tipInstalled($: Dollar, rt: Runtime, scores: readonly IntentScored[]): Promise<void> {
  const now = await $.clock.now()
  if (rt.isQuiet || isSnoozed(rt, now) || rt.installed === undefined || now - rt.lastTipAt < TIP_GAP_MS) {
    return
  }
  for (const one of scores) {
    const mod = modOf(rt, one.name)
    const command = mod === undefined ? undefined : commandsFor(rt, mod)[0]
    if (one.score < TIP_MIN || mod === undefined || command === undefined || !rt.installed.has(one.name) || rt.tipped.has(one.name)) {
      continue
    }
    rt.tipped.add(one.name)
    rt.lastTipAt = now
    await tell($, `Tip: ${tipLine(mod, command)}`)
    return
  }
}

/** After a person's prompt: the rolling picture of what they are doing, a tip, and mods worth installing. */
async function adviseIntent($: Dollar, rt: Runtime, text: string): Promise<void> {
  await ensureStarted($, rt)
  const catalog = rt.catalog
  if (catalog === undefined) {
    return
  }
  let scores = rankIntent(indexOf(rt, catalog), text)
  if (rt.config.useModel && scores.length > 0) {
    scores = await rerank($, catalog, text, scores)
  }
  rt.prompts = [scores, ...rt.prompts].slice(0, DECAY.length)
  rt.bandPrompts += 1
  if (rt.bandPrompts >= BAND_PROMPTS) {
    await update($, bandState, band => (band?.kind === 'fit' ? null : band))
  }
  const dismissed = new Set([...(rt.prefs.dismissed ?? []), SELF])
  const rolled = rollIntent(rt.prompts).filter(one => !dismissed.has(one.name))
  await update($, nowState, () => ({ picks: rolled.filter(one => one.score >= NOW_MIN).slice(0, NOW_SHOWN).map(one => pickOf(one)) }))
  await tipInstalled($, rt, scores)
  const added = recommendable(rolled)
    .filter(one => !(rt.installed?.has(one.name) ?? false) && !rt.surfaced.has(one.name))
    .slice(0, NEW_PER_PROMPT)
  added.forEach(one => rt.surfaced.add(one.name))
  if (added.length > 0) {
    await addFresh($, rt, added.map(one => ({ name: one.name, reason: reasonOf(one) })))
  }
}

// ── Session start ────────────────────────────────────────────────────────────

/** The Advisor tab of the hub's panel when the hub is installed, this mod's own pane otherwise. */
async function openPane($: Dollar, rt: Runtime, isAsked: boolean): Promise<boolean> {
  const isPlaced = rt.hasHub
    ? await hubShowTab($, TAB.id)
    : (await $.ui.open({ id: PANE, title: PANE_TITLE, ...(isAsked ? { focus: true } : {}) })).isPlaced
  await update($, paneState, () => ({ isOpen: true, isPlaced }))
  if (isPlaced) {
    await update($, bandState, () => null)
  }

  return isPlaced
}

/** Loads everything once per session: the catalog, the installed mods, the project; then the fit. */
async function startSession($: Dollar, rt: Runtime): Promise<void> {
  rt.isQuiet = (await $.store.get(QUIET_KEY).catch(() => undefined)) === true
  await update($, quietState, () => rt.isQuiet)
  const root = (await $.session.repo().catch(() => null))?.root ?? (await $.session.root())
  rt.prefs = (await readProjects($))[root] ?? {}
  await update($, dismissedState, () => rt.prefs.dismissed ?? [])
  await knownMarketplaces($, rt)
  const [catalog, facts] = await Promise.all([
    loadCatalog($, rt, false),
    scanProject($, root),
    refreshInstalled($, rt),
    refreshLiveCommands($, rt),
  ])
  rt.facts = facts
  rt.lastFullScan = await $.clock.now()
  if (catalog === undefined) {
    return
  }
  const picks = await reevaluate($, rt)
  // The pane (or the hub's Advisor tab) opens by itself only when something new fits: with every mod installed it
  // stayed open at each start to say "Nothing more fits", taking the side of the screen unasked.
  if (rt.config.autoOpen && rt.isInteractive && picks.length > 0 && !rt.isQuiet && !(await read($, autoShownState))) {
    await update($, autoShownState, () => true)
    await openPane($, rt, false).catch(() => false)
  }
  if (rt.isInteractive) {
    await announceFit($, rt, picks, (await read($, fitState))?.stack.slice(0, BAND_NAMES) ?? [])
  }
}

/** The session's start, run once; every hook that needs it waits for it. */
function ensureStarted($: Dollar, rt: Runtime): Promise<void> {
  rt.started ??= startSession($, rt).catch(error => {
    $.ui.log(`start failed: ${describe(error)}`, { to: 'debug' })
  })
  return rt.started
}

/** /mods-advisor refresh: everything again, now. */
async function refreshAll($: Dollar, rt: Runtime): Promise<void> {
  await ensureStarted($, rt)
  rt.refreshing ??= (async () => {
    await knownMarketplaces($, rt)
    await Promise.all([loadCatalog($, rt, true), refreshInstalled($, rt), refreshLiveCommands($, rt)])
    const root = rt.facts?.root ?? (await $.session.root())
    rt.facts = await scanProject($, root)
    rt.lastFullScan = await $.clock.now()
    await reevaluate($, rt)
  })().finally(() => {
    rt.refreshing = undefined
  })
  await rt.refreshing
}

// ── Actions: install, uninstall, dismiss ─────────────────────────────────────

async function ensureMarketplace($: Dollar, rt: Runtime, bin: string): Promise<string | undefined> {
  const known = await knownMarketplaces($, rt)
  if (marketplaceOf(known, rt.config.source.repository) !== undefined) {
    return undefined
  }
  const added = parseOutcome(await runCli($, argv.addMarketplace(bin, rt.config.source.repository), CHANGE_TIMEOUT_MS))
  if (!added.isOk) {
    return added.message
  }
  await knownMarketplaces($, rt)

  return undefined
}

async function installNames($: Dollar, rt: Runtime, names: readonly string[]): Promise<AdvisorNotice> {
  const bin = await claudeBin($, rt)
  const marketplaceError = await ensureMarketplace($, rt, bin)
  if (marketplaceError !== undefined) {
    return failure(`Could not add the ${rt.config.source.repository} marketplace: ${marketplaceError}`)
  }
  const added: string[] = []
  const failed: string[] = []
  let isRefreshed = false
  for (const [index, name] of names.entries()) {
    await update($, busyState, () => ({ verb: 'Installing', name: names.length === 1 ? name : `${name} (${index + 1}/${names.length})` }))
    let outcome = parseOutcome(await runCli($, argv.install(bin, name, rt.marketplace), CHANGE_TIMEOUT_MS))
    if (!outcome.isOk && outcome.failureCode === 'not_found' && !isRefreshed) {
      isRefreshed = true
      await runCli($, argv.refreshMarketplace(bin, rt.marketplace), CHANGE_TIMEOUT_MS)
      outcome = parseOutcome(await runCli($, argv.install(bin, name, rt.marketplace), CHANGE_TIMEOUT_MS))
    }
    if (outcome.isOk) {
      added.push(name)
    } else {
      failed.push(`${name} (${outcome.message})`)
    }
  }
  await refreshInstalled($, rt)
  await reevaluate($, rt)
  const text = [
    added.length === 0 ? '' : added.length === 1 ? `Installed ${added[0]}.` : `Installed ${plural(added.length, 'mod')}.`,
    failed.length === 0 ? '' : `Failed: ${failed.join('; ')}.`,
    added.length === 0 ? '' : 'Reload plugins to use them.',
  ].filter(part => part !== '').join(' ')

  return added.length > 0 ? success(text) : failure(text)
}

async function uninstallName($: Dollar, rt: Runtime, name: string): Promise<AdvisorNotice> {
  const installed = await refreshInstalled($, rt)
  const entry = installed.isKnown ? installed.mods[name] : undefined
  if (entry === undefined) {
    return info(installed.isKnown ? `${name} is not installed.` : `Could not read the installed mods: ${installed.isKnown ? '' : installed.error}`)
  }
  if (entry.scope === 'managed') {
    return failure(`${name} is managed by your organization.`)
  }
  await update($, busyState, () => ({ verb: 'Uninstalling', name }))
  const outcome = parseOutcome(await runCli($, argv.uninstall(await claudeBin($, rt), name, rt.marketplace, entry.scope), CHANGE_TIMEOUT_MS))
  await refreshInstalled($, rt)
  await reevaluate($, rt)

  return outcome.isOk ? success(`Uninstalled ${name}. Reload plugins to unload it.`) : failure(`Could not uninstall ${name}: ${outcome.message}`)
}

/** One action at a time, drawn as busy, its outcome as the notice (in the pane and the band). */
async function act($: Dollar, rt: Runtime, verb: 'install' | 'uninstall', names: readonly string[]): Promise<AdvisorNotice> {
  if (rt.isWorking) {
    return info('Another install is still running; try again when it is done.')
  }
  rt.isWorking = true
  let notice: AdvisorNotice
  try {
    await update($, noticeState, () => null)
    await update($, busyState, () => ({ verb: verb === 'install' ? 'Installing' : 'Uninstalling', name: names.join(', ') }))
    notice = names.length === 0 ? info('Nothing to install.')
      : verb === 'install' ? await installNames($, rt, names)
      : await uninstallName($, rt, names[0] ?? '')
  } catch (error) {
    notice = failure(`${verb === 'install' ? 'Installing' : 'Uninstalling'} failed: ${describe(error)}`)
  } finally {
    rt.isWorking = false
  }
  await update($, busyState, () => null)
  await update($, noticeState, () => notice)

  return notice
}

async function reloadPlugins($: Dollar): Promise<void> {
  await update($, noticeState, () => null)
  await update($, bandState, () => null)
  try {
    await $.command.run({ command: 'reload-plugins' })
  } catch {
    $.ui.toast('Run /reload-plugins to use the new mods')
  }
}

async function dismissMod($: Dollar, rt: Runtime, name: string): Promise<void> {
  rt.prefs = { ...rt.prefs, dismissed: [...new Set([...(rt.prefs.dismissed ?? []), name])] }
  await savePrefs($, rt)
  await update($, freshState, list => list.filter(item => item.name !== name))
  await update($, nowState, current => (current === null ? null : { picks: current.picks.filter(pick => pick.name !== name) }))
  await update($, bandState, band => {
    const names = band?.names.filter(one => one !== name) ?? []
    return band === null || names.length === 0 ? null : { ...band, names }
  })
  await update($, viewState, view => (view.howTo === name ? { ...view, howTo: null } : view))
  await reevaluate($, rt)
}

async function snoozeProject($: Dollar, rt: Runtime): Promise<void> {
  rt.prefs = { ...rt.prefs, snoozedUntil: (await $.clock.now()) + SNOOZE_MS }
  await savePrefs($, rt)
  await update($, bandState, () => null)
}

async function setQuiet($: Dollar, rt: Runtime, isQuiet: boolean): Promise<void> {
  rt.isQuiet = isQuiet
  await $.store.set(QUIET_KEY, isQuiet).catch(() => undefined)
  await update($, quietState, () => isQuiet)
  if (isQuiet) {
    await update($, bandState, () => null)
  }
}

/** A mod's README Usage section, from the store's copy when fresh, else GitHub. */
async function loadUsage($: Dollar, rt: Runtime, name: string): Promise<void> {
  const known = (await read($, usagesState))[name]
  if (known?.phase === 'ready' || rt.usagesLoading.has(name)) {
    return
  }
  rt.usagesLoading.add(name)
  const setUsage = (usage: AdvisorUsage) => update($, usagesState, all => ({ ...all, [name]: usage }))
  try {
    await setUsage({ phase: 'loading', text: '' })
    const now = await $.clock.now()
    const stored = (await $.store.get(`${USAGE_KEY}${name}`).catch(() => undefined)) as { at?: number; text?: string } | undefined
    if (typeof stored?.text === 'string' && now - (stored.at ?? 0) < CATALOG_TTL_MS) {
      await setUsage({ phase: 'ready', text: stored.text })
      return
    }
    try {
      const text = usageOf(await fetchText($, readmeRawUrl(rt.config.source, name)))
      await $.store.set(`${USAGE_KEY}${name}`, { at: now, text }).catch(() => undefined)
      await setUsage({ phase: text === '' ? 'missing' : 'ready', text })
    } catch {
      await setUsage(typeof stored?.text === 'string' && stored.text !== '' ? { phase: 'ready', text: stored.text } : { phase: 'missing', text: '' })
    }
  } finally {
    rt.usagesLoading.delete(name)
  }
}

async function showHowTo($: Dollar, rt: Runtime, name: string): Promise<void> {
  await update($, viewState, view => ({ ...view, howTo: name }))
  await loadUsage($, rt, name)
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function openAdvisor($: Dollar, rt: Runtime, query: string): Promise<CommandRunResult> {
  await update($, viewState, view => ({ ...view, query, howTo: null }))
  const isPlaced = await openPane($, rt, true)
  void ensureStarted($, rt)
  if (isPlaced) {
    return { text: query === '' ? '🧭 Opened the Advisor.' : `🧭 Opened the Advisor, searching for "${query}".` }
  }
  await ensureStarted($, rt)

  return { text: await listingText($, rt) }
}

/** The advisor as text, where no pane can be shown. */
async function listingText($: Dollar, rt: Runtime): Promise<string> {
  const [fit, now] = await Promise.all([read($, fitState), read($, nowState)])
  if (rt.catalog === undefined) {
    return `✗ The catalog is not available (${(await read($, syncState)).message ?? 'not loaded yet'}).`
  }
  const lines = [`🧭 Advisor (the pane could not be shown here)`]
  const picks = fit?.picks ?? []
  lines.push(picks.length === 0 ? 'Nothing new fits this project.' : `For this project${fit?.stack.length ? ` (${fit.stack.join(', ')})` : ''}:`)
  picks.forEach(pick => lines.push(`- ${pick.name}: ${pick.reason} · ${installLine(pick.name, rt.marketplace)}`))
  ;(now?.picks ?? []).forEach((pick, index) => {
    if (index === 0) lines.push("For what you're doing now:")
    const mod = modOf(rt, pick.name)
    const commands = mod === undefined ? [] : commandsFor(rt, mod)
    lines.push(`- ${pick.name}${commands.length > 0 ? ` (${commands.join(', ')})` : ''}: ${pick.reason}`)
  })

  return lines.join('\n')
}

async function whyText($: Dollar, rt: Runtime, name: string): Promise<string> {
  await ensureStarted($, rt)
  const mod = modOf(rt, name)
  if (mod === undefined) {
    return rt.catalog === undefined ? '✗ The catalog is not available.' : `✗ There is no mod named ${name} in the catalog.`
  }
  const lines = [`🧭 ${name}: ${mod.description}`]
  const status = rt.installed?.has(name) === true ? 'installed' : (rt.prefs.dismissed ?? []).includes(name) ? 'dismissed here' : 'not installed'
  lines.push(`Status: ${status}. Judged by ${mod.signals === undefined ? 'its description (the catalog gives it no signals)' : 'its catalog signals'}.`)
  if (rt.facts !== undefined) {
    const facts = projectFacts(rt.facts)
    const stack = detectStack(facts)
    const scored = projectScore(mod, facts, stack)
    const found = stack.map(one => one.tech.label)
    lines.push(found.length === 0 ? 'Project: no known technology found.' : `Project: ${found.join(', ')}.`)
    lines.push(scored.evidence.length === 0
      ? 'Project fit: nothing in the project matches it.'
      : `Project fit: score ${scored.score}${scored.score >= PROJECT_MIN ? '' : ` (below ${PROJECT_MIN})`} — ${scored.evidence.map(evidence => describeEvidence(evidence)).join('; ')}.`)
  }
  const rolled = rollIntent(rt.prompts).find(one => one.name === name)
  lines.push(rolled === undefined
    ? 'Recent prompts: no match.'
    : `Recent prompts: score ${rolled.score} — words: ${rolled.evidence.map(evidence => `"${evidence.detail}"`).join(', ')}.`)
  const commands = commandsFor(rt, mod)
  lines.push(commands.length === 0 ? 'Commands: none, it works on its own once installed.' : `Commands: ${commands.join(', ')}.`)

  return lines.join('\n')
}

async function refreshReport($: Dollar, rt: Runtime): Promise<string> {
  await refreshAll($, rt)
  const [sync, fit, installed] = await Promise.all([read($, syncState), read($, fitState), read($, installedState)])
  const catalog = rt.catalog
  if (catalog === undefined) {
    return `✗ Could not load the catalog: ${sync.message ?? 'unknown error'}.`
  }
  const age = formatAge((await $.clock.now()) - catalog.fetchedAt)
  const where = sync.phase === 'offline' ? ` Offline (${sync.message ?? 'no answer'}): catalog from ${age}.` : ''
  const count = installed?.isKnown === true ? `${Object.keys(installed.mods).length} installed` : 'install status unknown'
  const stack = fit === null || fit.stack.length === 0 ? '' : ` (${fit.stack.join(', ')})`

  return `🧭 ${plural(catalog.mods.length, 'mod')} in the catalog${catalog.version === '' ? '' : ` ${catalog.version}`}, ${count}; ${plural(fit?.picks.length ?? 0, 'mod')} fit this project${stack}.${where}`
}

/** The Advisor: this mod's own pane, or its tab in the hub's panel (`isTab`, no Close button). */
async function drawAdvisor($: Dollar, e: RenderInput<'Pane'>, rt: Runtime, isTab: boolean): Promise<RenderElement> {
  const { Box, Button, Link, Markdown, Text } = $.ui.resolve(e)
  const fields = e.surface === 'mobile' ? undefined : $.ui.resolve(e)
  const [catalog, sync, installed, fit, current, fresh, view, busy, notice, usages, isQuiet, now, live, dismissed] = await Promise.all([
    read($, catalogState),
    read($, syncState),
    read($, installedState),
    read($, fitState),
    read($, nowState),
    read($, freshState),
    read($, viewState),
    read($, busyState),
    read($, noticeState),
    read($, usagesState),
    read($, quietState),
    $.clock.now(),
    read($, commandsState),
    read($, dismissedState),
  ])
  const installedMods = installed?.isKnown === true ? installed.mods : {}
  const isInstalled = (name: string): boolean => installedMods[name] !== undefined
  const mods = catalog?.mods ?? []
  const findMod = (name: string): AdvisorMod | undefined => mods.find(mod => mod.name === name)
  const isIdle = busy === null

  const header = (
    <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={1}>
      <Text bold color="claude">🧭 Advisor</Text>
      {catalog === null ? null : (
        <Text dimColor>
          {plural(mods.length, 'mod')} · {Object.keys(installedMods).length} installed{isQuiet ? ' · quiet' : ''}
        </Text>
      )}
    </Box>
  )
  const syncLine = sync.phase === 'syncing'
    ? <Text color="suggestion" wrap="truncate-end">⟳ Reading the catalog…</Text>
    : sync.phase === 'offline' && catalog !== null
      ? <Text color="warning" wrap="truncate-end">● Offline · catalog from {formatAge(now - catalog.fetchedAt)}</Text>
      : sync.phase === 'error' && catalog === null
        ? <Text color="error" wrap="wrap">✗ No catalog: {sync.message ?? 'unknown error'}</Text>
        : null
  const status = (
    <Box flexDirection="column">
      {installed?.isKnown === false ? <Text color="warning" wrap="truncate-end">▲ Install status unknown: {installed.error}</Text> : null}
      {busy === null ? null : <Text color="suggestion" wrap="wrap">⟳ {busy.verb} {busy.name}…</Text>}
      {notice === null ? null : (
        <Box flexDirection="column">
          <Text color={TONE_COLOR[notice.tone]} wrap="wrap">{TONE_GLYPH[notice.tone]} {notice.text}</Text>
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {notice.canReload
              ? <Button key="reload" label="Reload plugins" plain hotkey="l" variant="primary" onPress={() => reloadPlugins($)} />
              : null}
            <Button key="dismiss-notice" label="OK" plain onPress={() => update($, noticeState, () => null)} />
          </Box>
        </Box>
      )}
    </Box>
  )
  const search = fields === undefined ? null : (() => {
    const { Input } = fields
    const onSearch = (query: string) => update($, viewState, view => ({ ...view, query, howTo: null }))
    return <Input key="search" label="Search" placeholder="what do you need?" value={view.query} onInput={onSearch} onSubmit={onSearch} />
  })()

  /** One mod: its name and badge, the reason or its commands, and its buttons. */
  const row = (section: string, name: string, line: string, isNew = false) => {
    const mod = findMod(name)
    const has = isInstalled(name)
    const commands = mod === undefined ? [] : commandsOf(mod, live[name])
    return (
      <Box key={`row:${section}:${name}`} flexDirection="column" marginTop={1}>
        <Text wrap="truncate-end">
          {isNew ? <Text color="suggestion">● </Text> : null}
          <Text bold>{name}</Text>
          {has ? <Text color="success"> ✓</Text> : null}
          {has && commands.length > 0 ? <Text color="suggestion"> {commands.join(' ')}</Text> : null}
        </Text>
        {line === '' ? null : <Text dimColor wrap="truncate-end">{line}</Text>}
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {!has && isIdle && installed?.isKnown === true
            ? <Button key={`install:${section}:${name}`} label="Install" plain onPress={() => act($, rt, 'install', [name])} />
            : null}
          <Button key={`how:${section}:${name}`} label="How to use" plain dimColor onPress={() => showHowTo($, rt, name)} />
          {section === 'installed'
            ? (isIdle && installedMods[name]?.scope !== 'managed'
              ? <Button key={`uninstall:${section}:${name}`} label="Uninstall" plain dimColor onPress={() => act($, rt, 'uninstall', [name])} />
              : null)
            : <Button key={`dismiss:${section}:${name}`} label="Dismiss" plain dimColor onPress={() => dismissMod($, rt, name)} />}
        </Box>
      </Box>
    )
  }
  const heading = (title: string, detail = '') => (
    <Box flexDirection="row" marginTop={1}>
      <Text wrap="truncate-end">
        <Text bold color="claude">{title}</Text>
        {detail === '' ? null : <Text dimColor> · {detail}</Text>}
      </Text>
    </Box>
  )
  const installAll = (key: string, names: readonly string[]) => {
    const missing = names.filter(name => !isInstalled(name))
    return missing.length > 1 && isIdle && installed?.isKnown === true
      ? <Box marginTop={1}><Button key={key} label={`Install all (${missing.length})`} plain variant="primary" onPress={() => act($, rt, 'install', missing)} /></Box>
      : null
  }
  const footer = (
    <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
      {dismissed.length === 0 ? null : <Text dimColor>{dismissed.length} dismissed</Text>}
      <Button key="refresh" label="Refresh" plain hotkey="r" onPress={() => refreshAll($, rt)} />
      <Button key="quiet" label={isQuiet ? 'Tips on' : 'Quiet'} plain onPress={() => setQuiet($, rt, !isQuiet)} />
      {isTab ? null : <Button key="close" label="Close" plain role="dismiss" onPress={() => $.ui.close({ id: PANE })} />}
    </Box>
  )

  // How to use one mod.
  const open = view.howTo === null ? undefined : findMod(view.howTo)
  if (open !== undefined) {
    const usage = usages[open.name]
    const commands = commandsOf(open, live[open.name])
    const has = isInstalled(open.name)
    return (
      <Box flexDirection="column">
        <Button key="back" label="← Back" plain hotkey="b" onPress={() => update($, viewState, view => ({ ...view, howTo: null }))} />
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
          <Text bold color="claude">{open.name}</Text>
          <Text color={has ? 'success' : 'inactive'}>{has ? '✓ installed' : 'not installed'}</Text>
        </Box>
        <Text wrap="wrap">{open.description}</Text>
        <Text color="suggestion" wrap="wrap">
          {commands.length === 0 ? 'No command to type: it works on its own once installed.' : `Type ${commands.join(' · ')}`}
        </Text>
        {status}
        <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
          {!has && isIdle && installed?.isKnown === true
            ? <Button key="install-open" label="Install" plain hotkey="i" variant="primary" onPress={() => act($, rt, 'install', [open.name])} />
            : null}
          {has && isIdle && installedMods[open.name]?.scope !== 'managed'
            ? <Button key="uninstall-open" label="Uninstall" plain hotkey="x" onPress={() => act($, rt, 'uninstall', [open.name])} />
            : null}
          {has ? null : <Button key="dismiss-open" label="Dismiss" plain onPress={() => dismissMod($, rt, open.name)} />}
        </Box>
        {has ? null : <Text dimColor wrap="wrap">Or type: {installLine(open.name, rt.marketplace)}</Text>}
        <Link href={readmeUrl(rt.config.source, open.name)} label="README on GitHub ↗" />
        <Box flexDirection="column" marginTop={1}>
          {usage?.phase === 'ready'
            ? <Markdown text={usage.text} />
            : usage?.phase === 'missing'
              ? <Text dimColor wrap="wrap">The README's usage could not be loaded.</Text>
              : <Text dimColor>Loading the usage…</Text>}
        </Box>
      </Box>
    )
  }

  if (catalog === null) {
    return (
      <Box flexDirection="column">
        {header}
        {syncLine ?? <Text color="suggestion">⟳ Reading the catalog…</Text>}
        {sync.phase === 'error'
          ? <Button key="retry" label="Try again" plain hotkey="r" variant="primary" onPress={() => refreshAll($, rt)} />
          : null}
      </Box>
    )
  }

  // A search: the catalog ranked against what was typed.
  const query = view.query.trim()
  if (query !== '') {
    const index = rt.catalog === undefined ? buildIndex(mods) : indexOf(rt, rt.catalog)
    const lower = query.toLowerCase()
    const byName = mods.filter(mod => mod.name.includes(lower)).map(mod => mod.name)
    const ranked = rankIntent(index, query).map(one => one.name)
    const results = [...new Set([...byName, ...ranked])].slice(0, NOW_SHOWN * 2)
    return (
      <Box flexDirection="column">
        {header}
        {search}
        {status}
        {heading('Results', `"${query}"`)}
        {results.length === 0
          ? <Text dimColor wrap="wrap">No mod matches. Try other words.</Text>
          : results.map(name => row('search', name, findMod(name)?.description ?? ''))}
        {footer}
      </Box>
    )
  }

  const fitPicks = fit?.picks ?? []
  const shownFit = view.isFitUnfolded ? fitPicks : fitPicks.slice(0, FIT_FOLDED)
  const nowPicks = current?.picks ?? []
  const installedNames = Object.keys(installedMods).filter(name => findMod(name) !== undefined)
  return (
    <Box flexDirection="column">
      {header}
      {syncLine}
      {search}
      {status}
      {fresh.length === 0 ? null : (
        <Box key="section:new" flexDirection="column">
          {heading('New for you')}
          {fresh.map(item => row('new', item.name, item.reason, now - item.at < FRESH_HIGHLIGHT_MS))}
          {installAll('install-new', fresh.map(item => item.name))}
        </Box>
      )}
      <Box key="section:project" flexDirection="column">
        {heading('For this project', fit === null ? '' : fit.stack.join(', '))}
        {fit === null
          ? <Text dimColor>Looking at the project…</Text>
          : fitPicks.length === 0
            ? <Text dimColor wrap="wrap">Nothing more fits this project right now.</Text>
            : shownFit.map(pick => row('project', pick.name, pick.reason))}
        {fitPicks.length > FIT_FOLDED
          ? <Button key="unfold" label={view.isFitUnfolded ? 'Show fewer' : `Show ${fitPicks.length - FIT_FOLDED} more`} plain dimColor
              onPress={() => update($, viewState, view => ({ ...view, isFitUnfolded: !view.isFitUnfolded }))} />
          : null}
        {installAll('install-project', fitPicks.map(pick => pick.name))}
      </Box>
      <Box key="section:now" flexDirection="column">
        {heading("For what you're doing now")}
        {nowPicks.length === 0
          ? <Text dimColor wrap="wrap">Ask Claude something: the mods that fit show up here.</Text>
          : nowPicks.map(pick => row('now', pick.name, pick.reason))}
      </Box>
      <Box key="section:installed" flexDirection="column">
        {heading('Installed — how to use')}
        {installedNames.length === 0
          ? <Text dimColor wrap="wrap">{installed?.isKnown === false ? 'Unknown.' : 'No mod of this collection is installed yet.'}</Text>
          : installedNames.map(name => {
            const mod = findMod(name)
            const commands = mod === undefined ? [] : commandsOf(mod, live[name])
            return row('installed', name, commands.length > 0 ? (mod?.description ?? '') : `works on its own · ${mod?.description ?? ''}`)
          })}
      </Box>
      {footer}
    </Box>
  )
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  const rt = newRuntime(configOf(options))

  on('session.start', async ($, e, next) => {
    forgetSession(rt)
    rt.isInteractive = e.isInteractive
    await registerCommand($, {
      name: 'mods-advisor',
      description: 'Mods that fit this project and what you are doing, with the commands to type',
      argumentHint: ARGUMENT_HINT,
      immediate: true,
    })
    // After session.start has returned: the hello first, so the first look knows whether the Advisor lives in the
    // hub's panel, then the first look (the scan and the catalog), all off the start-up chain.
    $.clock.after(0, () => {
      void (async () => {
        await greetHub($, rt)
        if (e.isInteractive) await ensureStarted($, rt)
      })().catch(error => $.ui.log(`mod-advisor: start-up failed: ${String(error)}`, { to: 'debug' }))
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await update($, autoShownState, () => false)
    if (e.reason === 'clear') {
      rt.told.clear()
      rt.prompts = []
      await update($, nowState, () => null)
    }
    return next(e)
  })

  on('command.run', { command: 'mods-advisor' }, async ($, e) => {
    const command = parseArgs(e.args)
    switch (command.kind) {
      case 'open':
        return openAdvisor($, rt, command.query)
      case 'refresh':
        return { text: await refreshReport($, rt) }
      case 'quiet': {
        const isQuiet = command.value ?? !rt.isQuiet
        await setQuiet($, rt, isQuiet)
        return { text: isQuiet ? '🧭 Quiet: no tips, toasts or band until /mods-advisor quiet off.' : '🧭 Tips are back on.' }
      }
      case 'why':
        return { text: await whyText($, rt, command.name) }
      case 'reset': {
        await ensureStarted($, rt)
        rt.prefs = {}
        await savePrefs($, rt)
        await reevaluate($, rt)
        return { text: '🧭 Dismissed mods, the snooze and what was announced are cleared for this project.' }
      }
      case 'usage':
        return { text: `✗ ${command.reason} Usage: /mods-advisor ${ARGUMENT_HINT}` }
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!rt.isInteractive || !isPerson(e.origin) || e.text.trimStart().startsWith('/')) {
      return next(e)
    }
    const note = contextNote(rt, e.text)
    const submitted = await next(note === undefined ? e : { ...e, context: [...(e.context ?? []), note] })
    const text = e.text
    $.clock.after(0, () => void adviseIntent($, rt, text).catch(error => $.ui.log(`advice failed: ${describe(error)}`, { to: 'debug' })))

    return submitted
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const facts = rt.facts
    if (facts === undefined || ran.deny !== undefined || ran.isError === true) {
      return ran
    }
    const tool = String(e.tool)
    if (EDIT_TOOLS.has(tool)) {
      const path = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path
        : 'notebook_path' in e && typeof e.notebook_path === 'string' ? e.notebook_path : undefined
      const rel = path === undefined ? undefined : relativeTo(facts.root, path)
      if (rel !== undefined && !isSkipped(rel) && (isManifest(rel) || !facts.files.has(rel))) {
        queueChange($, rt, isManifest(rel) ? { paths: [rel], manifests: [rel] } : { paths: [rel] })
      }
    } else if (tool === 'Bash' && 'command' in e && typeof e.command === 'string') {
      const change = changesOf(e.command)
      const paths = change.paths.map(path => relativeTo(facts.root, path)).filter((rel): rel is string => rel !== undefined && !isSkipped(rel))
      if (change.installs || change.isFull || paths.length > 0) {
        queueChange($, rt, { paths, installs: change.installs, isFull: change.isFull })
      }
    }

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    if (rt.hasHub && rt.isInteractive && e.agentId === undefined) {
      $.clock.after(0, () => void readSignals($, rt).catch(error => $.ui.log(`signals failed: ${describe(error)}`, { to: 'debug' })))
    }
    if (rt.facts !== undefined && e.agentId === undefined && (await $.clock.now()) - rt.lastFullScan >= FULL_SCAN_GAP_MS) {
      // Changes made outside Claude (another terminal, the editor) show up at most every 10 minutes.
      queueChange($, rt, { isFull: true })
    }

    return completed
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    await update($, paneState, () => ({ isOpen: false, isPlaced: false }))

    return closed
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [band, isQuiet, pane] = await Promise.all([read($, bandState), read($, quietState), read($, paneState)])
    if (band === null || isQuiet || e.props.hasSurvey || (pane.isOpen && (await isPaneVisible($)))) {
      return next(e)
    }
    const [busy, notice] = await Promise.all([read($, busyState), read($, noticeState)])
    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const shown = band.names.slice(0, BAND_NAMES).join(', ') + (band.names.length > BAND_NAMES ? ', …' : '')
    const title = band.kind === 'fit'
      ? `🧭 ${plural(band.names.length, 'mod')} fit this project`
      : `🧭 ${band.names.length === 1 ? 'A new mod fits' : `${band.names.length} new mods fit`} what you're doing`
    const detail = band.kind === 'fit' && band.stack.length > 0 ? ` (${band.stack.join(', ')})` : ` (${shown})`
    const toInstall = band.names.filter(name => !(rt.installed?.has(name) ?? false))
    const actions = busy !== null
      ? <Text color="suggestion">⟳ {busy.verb} {busy.name}…</Text>
      : notice !== null
        ? (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Text color={TONE_COLOR[notice.tone]}>{TONE_GLYPH[notice.tone]} {notice.text}</Text>
            {notice.canReload ? <Button key="band-reload" label="Reload plugins" variant="primary" onPress={() => reloadPlugins($)} /> : null}
            <Button key="band-close" label="Close" role="dismiss" onPress={() => update($, bandState, () => null)} />
          </Box>
        )
        : (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Button key="band-show" label="Show" variant="primary" onPress={() => openAdvisor($, rt, '')} />
            {toInstall.length > 0
              ? <Button key="band-install" label={band.kind === 'fit' ? 'Install all recommended' : 'Install'} onPress={() => act($, rt, 'install', toInstall)} />
              : null}
            <Button key="band-later" label="Not now" role="dismiss" onPress={() => snoozeProject($, rt)} />
          </Box>
        )

    return (
      <Box flexDirection="column">
        <Box key="advisor-band" flexDirection="column">
          <Text wrap="truncate-end">
            <Text bold color="claude">{title}</Text>
            <Text dimColor>{detail}</Text>
          </Text>
          {actions}
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawAdvisor($, e, rt, false))

  // The Advisor tab: drawn beneath the hub's tab strip when it is the tab shown; any other tab passes through.
  on('ui.render', { component: 'Pane', requestId: HUB_PANE }, async ($, e, next) => {
    if (!(await hubTabIs($, TAB.id))) {
      return next(e)
    }
    const { Box } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {await next(e)}
        {await drawAdvisor($, e, rt, true)}
      </Box>
    )
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
