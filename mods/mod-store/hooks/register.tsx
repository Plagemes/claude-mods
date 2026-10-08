import { atom, read, update } from 'claude-code'
import type {
  CommandRunResult,
  EngineInterface,
  ProcessRunResult,
  Register,
  RenderInput,
  RenderSurface,
} from 'claude-code'

import type {
  StoreCatalog,
  StoreConfigRow,
  StoreInstalled,
  StoreJob,
  StoreMod,
  StoreNotice,
  StorePack,
  StorePlan,
  StorePlanRow,
  StoreReadme,
  StoreSync,
  StoreView,
} from '../types'
import {
  buildCatalog,
  CATALOG_PATH,
  categoryOf,
  categoryOptions,
  clip,
  compareVersions,
  countsOf,
  DATA_PATH,
  DEFAULT_BRANCH,
  DEFAULT_MARKETPLACE,
  DEFAULT_REPOSITORY,
  FEATURED,
  FILTER_ALL,
  formatAge,
  installLine,
  isBranch,
  isCatalogOf,
  isNewMod,
  isRepository,
  isStatus,
  MARKETPLACE_PATH,
  matchMods,
  paginate,
  parseArgs,
  parseCatalogMeta,
  parseConfig,
  parseMarketplace,
  plural,
  rawUrl,
  readmeRawUrl,
  readmeUrl,
  relatedOf,
  releaseLabel,
  rowsOf,
  STATUS_NEW,
  statusOf,
  statusOptions,
  STATUSES,
  tierLabel,
  trimReadme,
  updatesOf,
} from './catalog'
import type { CatalogMeta, ModStatus, Row, Source, StatusFilter } from './catalog'
import {
  argv,
  CLAUDE,
  claudeBinary,
  desktopRoots,
  isClaudeFile,
  joinPath,
  parseInstalled,
  pluginId,
  parseMarketplaceNames,
  parseOutcome,
  versionOrder,
} from './cli'
import type { CliOutcome } from './cli'
import { barCells, barSvg, glyphOf, iconSvg, markSvg } from './icons'
import {
  changesOf,
  disabledEntries,
  editEnabledPlugins,
  isDepFile,
  mergeUsage,
  parseDeps,
  parseTranscript,
  projectFolder,
  proposeProfile,
  proposeSlim,
  SKIP_DIRS,
  usesByMod,
  WALK,
} from './profile'
import type { TranscriptUsage, Use } from './profile'
import { paneFailure } from './shared/render-safe'

type Dollar = EngineInterface
type Action = 'install' | 'update' | 'uninstall'
type Bulk = 'install-all' | 'update-all'
/** The jobs of profiles, slims and packs: read a project or the transcripts, apply or undo a plan, enable a pack here. */
type PlanTask = 'profile' | 'slim' | 'apply' | 'undo' | 'reset' | 'enable-pack'
type Task = Action | Bulk | PlanTask
/** What a job does: the task, the mod (or pack) it is on, the mods of a bulk install, the days of a slim, its title. */
type JobSpec = { action: Task; name: string; names?: readonly string[]; days?: number; title?: string }
/** What Undo restores: a settings file's entries as they were, or mods the CLI disabled at user scope. */
type UndoRecord =
  | { kind: 'local'; path: string; previous: Record<string, boolean | null>; label: string }
  | { kind: 'cli'; names: string[]; label: string }
/** The weekly slim tip: when it last looked, and whether the person turned it off. */
type NudgeState = { lastAt?: number; isOff?: boolean }
/** The store's settings, read from userConfig: where the catalog lives, or why it cannot be read. */
type Config = { source: Source; problem: string | undefined }

const PANE = 'mod-store'
const PANE_TITLE = 'Mod Store'
const PANE_ROWS = 26
const ARGUMENT_HINT = '[search <words> | profile [apply|reset] | slim [<days>|apply|off|on] | packs | pack <id> [install|enable] | undo | refresh | install-all | update-all | stop | install|update|uninstall <mod>]'
const CACHE_KEY = 'catalog'
const ANNOUNCED_KEY = 'announced-updates'
const FRESH_MS = 10 * 60_000
const FETCH_TIMEOUT_MS = 15_000
const LIST_TIMEOUT_MS = 30_000
const CHANGE_TIMEOUT_MS = 180_000
const ANNOUNCE_TOAST_MS = 8_000
const ANNOUNCE_NAMES = 3
/** Names a notice lists before `and N more`: it lands in a toast and in the hub's one-line Recent rows. */
const NOTICE_NAMES = 2
const LISTING_LIMIT = 25
const README_LIMIT = 20
const WIDE_COLUMNS = 72
const NAME_COLUMNS_MIN = 14
const NAME_COLUMNS_MAX = 30
const HOTKEY_COLUMNS = 3
const BADGE_COLUMNS = 12
const ACTION_COLUMNS = 9
const MIN_PAGE_ROWS = 4
const DEFAULT_BODY_ROWS = 20
const ROW_HOTKEYS = '123456789'
const RELATED_LIMIT = 5
const PICKS_LIMIT = 4
const BAR_COLUMNS_MAX = 28
const NOTICE_CHARS = 400
/** Where a project's own on/off switches live: local scope, which Claude Code keeps out of git. */
const SETTINGS_LOCAL = '.claude/settings.local.json'
const UNDO_KEY = 'undo'
const NUDGE_KEY = 'slim-nudge'
const USAGE_CACHE_KEY = 'usage-cache'
const ESSENTIALS_PACK = 'essentials'
const SLIM_DAYS = 14
/** The slim tip appears only when at least this many mods are idle, at most once a week, never at start. */
const NUDGE_IDLE = 30
const NUDGE_EVERY_MS = 7 * 24 * 60 * 60_000
const NUDGE_DELAY_MS = 4 * 60_000
const NUDGE_TOAST_MS = 12_000
const DAY_MS = 24 * 60 * 60_000
/** `$.fs.read` refuses files over 4 MiB; a bigger transcript is read as its newest chunk with `tail -c`. */
const READ_CAP_BYTES = 4 * 1024 * 1024
const CHUNK_BYTES = 3 * 1024 * 1024
const TAIL_TIMEOUT_MS = 10_000
/** Bounds of a usage scan: transcript folders listed, files read (newest first), bytes read in all. */
const PROJECT_DIRS_MAX = 200
const TRANSCRIPTS_MAX = 60
const PROJECT_TRANSCRIPTS_MAX = 12
const TRANSCRIPT_BYTES_MAX = 48 * 1024 * 1024
const USAGE_CACHE_LIMIT = 150
const FEED_LIMIT = 500
const DEP_FILES_MAX = 20
const DEP_FILE_DEPTH = 3
/** Many installed mods at once: the outcome recommends a project profile. */
const PROFILE_HINT_MODS = 30
const INSTALL_ALL_WARNING = 50
const PLAN_CHROME_ROWS = 12
const VERBS: Record<Action, string> = { install: 'Installing', update: 'Updating', uninstall: 'Uninstalling' }
const TONE_COLOR: Record<StoreNotice['tone'], string> = { success: 'success', error: 'error', info: 'suggestion' }
const TONE_GLYPH: Record<StoreNotice['tone'], string> = { success: '✓', error: '✗', info: '•' }
const STATUS_LABEL: Record<StatusFilter, string> = { all: 'All', installed: 'Installed', updates: 'Updates', new: 'New' }
const HOME: StoreView = { query: '', category: FILTER_ALL, status: FILTER_ALL, selected: null, page: 0 }
const PLAN_TITLE: Record<StorePlan['kind'], string> = { profile: 'Profile', slim: 'Slim' }

const catalogState = atom({ plugin: 'mod-store', key: 'catalog' } as const, null)
const syncState = atom({ plugin: 'mod-store', key: 'sync' } as const, { phase: 'idle' })
const installedState = atom({ plugin: 'mod-store', key: 'installed' } as const, null)
/** Navigation: written only by the person's presses and typing (and `/mods`), never by a running job. */
const navState = atom({ plugin: 'mod-store', key: 'nav' } as const, HOME)
/** The running job's progress: written only by the job (and the Stop press), never by navigation. */
const jobState = atom({ plugin: 'mod-store', key: 'job' } as const, null)
const noticeState = atom({ plugin: 'mod-store', key: 'notice' } as const, null)
const readmesState = atom({ plugin: 'mod-store', key: 'readmes' } as const, {})
const configsState = atom({ plugin: 'mod-store', key: 'configs' } as const, {})
const picksState = atom({ plugin: 'mod-store', key: 'picks' } as const, [])
/** The plan under review (a profile or a slim): written by the job that reads it and by the person's toggles. */
const planState = atom({ plugin: 'mod-store', key: 'plan' } as const, null)

/** The `claude` executable, resolved once per load. */
let binary: string | undefined
/** The refresh in flight, so overlapping ones share it. */
let refreshing: Promise<void> | null = null
/** The job in flight: one at a time, claimed before anything is awaited so two starts never both run. */
let active: StoreJob | null = null
const readmesLoading = new Set<string>()

/** An error's message, without the `<plugin>: $.<noun>.<event>: ` prefix a refused `$` call carries. */
const describe = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^[\w-]+: \$\.[\w.]+: /, '')
const success = (text: string): StoreNotice => ({ tone: 'success', text, canReload: true })
const failure = (text: string): StoreNotice => ({ tone: 'error', text, canReload: false })
const info = (text: string): StoreNotice => ({ tone: 'info', text, canReload: false })
/** A notice as one line: its glyph, then its text. */
const said = (notice: StoreNotice): string => `${TONE_GLYPH[notice.tone]} ${notice.text}`

function configOf(repository: string, branch: string): Config {
  const source = { repository: repository.trim(), branch: branch.trim() }
  const problem = !isRepository(source.repository)
    ? `the repository setting "${source.repository}" is not owner/repo`
    : !isBranch(source.branch)
      ? `the branch setting "${source.branch}" is not a branch name`
      : undefined

  return { source, problem }
}

// ── Catalog: GitHub first, the $.store cache when offline ───────────────────

function withTimeout<T>($: Dollar, work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = $.clock.after(ms, () => reject(new Error(message)))
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
  const response = await withTimeout($, $.http.fetch(url), FETCH_TIMEOUT_MS, `GitHub did not answer within ${FETCH_TIMEOUT_MS / 1000} s`)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url.replace(/^https:\/\/[^/]+\//, '')}`)
  }

  return response.text
}

async function fetchCatalog($: Dollar, source: Source, now: number): Promise<StoreCatalog> {
  // The site's data carries each mod's commands and release; catalog.json is the fallback for a repository without it.
  const [marketText, metaText] = await Promise.all([
    fetchText($, rawUrl(source, MARKETPLACE_PATH)),
    fetchText($, rawUrl(source, DATA_PATH)).catch(() => fetchText($, rawUrl(source, CATALOG_PATH))).catch(() => undefined),
  ])
  let meta: CatalogMeta | undefined
  try {
    meta = metaText === undefined ? undefined : parseCatalogMeta(metaText)
  } catch {
    meta = undefined
  }

  return buildCatalog(parseMarketplace(marketText), meta, source, now)
}

async function setSync($: Dollar, sync: StoreSync): Promise<void> {
  await update($, syncState, () => sync)
}

/** The catalog on screen, or the cached one put on screen; null when neither is this source's. */
async function currentCatalog($: Dollar, config: Config): Promise<StoreCatalog | null> {
  const shown = await read($, catalogState)
  if (shown !== null && isCatalogOf(shown, config.source)) {
    return shown
  }
  let cached: unknown
  try {
    cached = await $.store.get(CACHE_KEY)
  } catch {
    cached = undefined
  }
  if (!isCatalogOf(cached, config.source)) {
    return null
  }
  await update($, catalogState, () => cached)

  return cached
}

async function syncCatalog($: Dollar, config: Config, isForced: boolean): Promise<StoreCatalog | null> {
  if (config.problem !== undefined) {
    await setSync($, { phase: 'error', message: config.problem })
    return null
  }
  const known = await currentCatalog($, config)
  const now = await $.clock.now()
  if (!isForced && known !== null && now - known.fetchedAt < FRESH_MS) {
    await update($, syncState, (sync): StoreSync => (sync.phase === 'idle' ? { phase: 'live' } : sync))
    return known
  }
  await setSync($, { phase: 'syncing' })
  try {
    const fetched = await fetchCatalog($, config.source, now)
    await update($, catalogState, () => fetched)
    await setSync($, { phase: 'live' })
    await $.store.set(CACHE_KEY, fetched)

    return fetched
  } catch (error) {
    const message = describe(error)
    await setSync($, known === null ? { phase: 'error', message } : { phase: 'offline', message })

    return known
  }
}

// ── Installed mods: the `claude plugin` CLI ──────────────────────────────────

/** The `claude` the desktop app installed, this engine's version first; undefined when there is none. */
async function desktopBinary($: Dollar): Promise<string | undefined> {
  const [appData, home, engine] = await Promise.all([
    $.env.get('APPDATA').catch(() => undefined),
    $.env.get('HOME').catch(() => undefined),
    $.session.version().then(info => info.version, () => ''),
  ])
  for (const root of desktopRoots(appData, home)) {
    const versions = (await $.fs.list(root).catch(() => [])).filter(entry => entry.kind === 'dir')
    for (const version of versionOrder(versions.map(entry => entry.name), engine, compareVersions)) {
      const folder = joinPath(root, version)
      const entries = await $.fs.list(folder).catch(() => [])
      const direct = entries.find(entry => entry.kind === 'file' && isClaudeFile(entry.name))
      if (direct !== undefined) {
        return joinPath(folder, direct.name)
      }
      for (const build of entries.filter(entry => entry.kind === 'dir')) {
        const files = await $.fs.list(joinPath(folder, build.name)).catch(() => [])
        const file = files.find(entry => entry.kind === 'file' && isClaudeFile(entry.name))
        if (file !== undefined) {
          return joinPath(folder, build.name, file.name)
        }
      }
    }
  }

  return undefined
}

/**
 * The `claude` executable: the one CLAUDE_CODE_EXECPATH names (a terminal
 * session), else the desktop app's own, else `claude` from PATH.
 */
async function claudeBin($: Dollar): Promise<string> {
  if (binary === undefined) {
    let execPath: string | undefined
    try {
      execPath = await $.env.get('CLAUDE_CODE_EXECPATH')
    } catch {
      execPath = undefined
    }
    const fromEnv = claudeBinary(execPath)
    binary = fromEnv !== CLAUDE ? fromEnv : (await desktopBinary($)) ?? CLAUDE
  }

  return binary
}

function runCli($: Dollar, args: readonly string[], timeoutMs: number): Promise<ProcessRunResult> {
  return $.process.run(args, { timeoutMs })
}

async function refreshInstalled($: Dollar, marketplace: string): Promise<StoreInstalled> {
  let installed: StoreInstalled
  try {
    const listed = await runCli($, argv.list(await claudeBin($)), LIST_TIMEOUT_MS)
    if (listed.exitCode !== 0) {
      throw new Error(parseOutcome(listed).message)
    }
    installed = { isKnown: true, mods: parseInstalled(listed.stdout, marketplace) }
  } catch (error) {
    installed = { isKnown: false, error: describe(error) }
  }
  await update($, installedState, () => installed)

  return installed
}

async function knownInstalled($: Dollar, catalog: StoreCatalog): Promise<StoreInstalled> {
  const installed = await read($, installedState)
  return installed?.isKnown === true ? installed : refreshInstalled($, catalog.marketplace)
}

async function syncAll($: Dollar, config: Config, isForced: boolean): Promise<void> {
  const guess = (await currentCatalog($, config))?.marketplace ?? DEFAULT_MARKETPLACE
  const [catalog] = await Promise.all([syncCatalog($, config, isForced), refreshInstalled($, guess)])
  if (catalog !== null && catalog.marketplace !== guess) {
    await refreshInstalled($, catalog.marketplace)
  }
}

/** Syncs the catalog and re-reads the installed mods, side by side; never rejects. */
async function refresh($: Dollar, config: Config, isForced: boolean): Promise<void> {
  if (refreshing !== null) {
    await refreshing
    if (!isForced) {
      return
    }
  }
  const run = syncAll($, config, isForced).catch(error =>
    $.ui.log(`refresh failed: ${describe(error)}`, { to: 'debug' }),
  )
  refreshing = run
  try {
    await run
  } finally {
    if (refreshing === run) {
      refreshing = null
    }
  }
}

// ── Jobs: install, update, uninstall, one at a time, in the background ──────

/** One CLI change; a run that could not start or timed out is a failed step, never a throw, so a bulk run goes on. */
async function change($: Dollar, args: readonly string[]): Promise<CliOutcome> {
  try {
    return parseOutcome(await runCli($, args, CHANGE_TIMEOUT_MS))
  } catch (error) {
    return { isOk: false, message: describe(error) }
  }
}

async function ensureMarketplace($: Dollar, catalog: StoreCatalog, bin: string): Promise<string | undefined> {
  let names: string[]
  try {
    const listed = await runCli($, argv.marketplaces(bin), LIST_TIMEOUT_MS)
    names = listed.exitCode === 0 ? parseMarketplaceNames(listed.stdout) : []
  } catch {
    names = []
  }
  if (names.includes(catalog.marketplace)) {
    return undefined
  }
  const added = await change($, argv.addMarketplace(bin, catalog.repository))

  return added.isOk ? undefined : added.message
}

/** Tells mods-hub's bus (`mod.installed`, for mod-advisor and mod-doctor) that a mod was installed or updated; nothing without the hub. */
async function announceInstalled($: Dollar, name: string, version: string): Promise<void> {
  await hubPublish($, { topic: 'mod.installed', data: { name, version: version === '' ? 'unknown' : version } })
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

/** Says hello to mods-hub when it is installed. */
async function greetHub($: Dollar): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: ['mod.installed'], consumes: ['mod.recommended'] })
}

/** Moves the progress bar; a job that already ended is left ended. */
const setJob = ($: Dollar, next: (job: StoreJob) => StoreJob): Promise<StoreJob | null> =>
  update($, jobState, job => (job === null ? null : next(job)))

const isStopping = async ($: Dollar): Promise<boolean> => (await read($, jobState))?.isStopping === true

/** Names as a notice lists them: the first few, then how many more. */
function listed(names: readonly string[]): string {
  const shown = names.slice(0, NOTICE_NAMES).join(', ')
  return names.length > NOTICE_NAMES ? `${shown} and ${names.length - NOTICE_NAMES} more` : shown
}

type StepResult = { name: string; outcome: CliOutcome }

/**
 * Runs `step` for each name in turn, drawing each as the bar's next step, until done or the person presses Stop;
 * resolves the steps run and how many were left when it stopped.
 */
async function eachStep(
  $: Dollar,
  names: readonly string[],
  step: (name: string) => Promise<CliOutcome>,
): Promise<{ results: StepResult[]; left: number }> {
  const results: StepResult[] = []
  await setJob($, job => ({ ...job, done: 0, total: names.length }))
  for (const [index, name] of names.entries()) {
    if (await isStopping($)) {
      return { results, left: names.length - index }
    }
    const failed = results.filter(result => !result.outcome.isOk).length
    await setJob($, job => ({ ...job, current: name, done: index, failed }))
    results.push({ name, outcome: await step(name) })
  }

  return { results, left: 0 }
}

function failuresOf(results: readonly StepResult[]): { names: string[]; text: string } {
  const failed = results.filter(result => !result.outcome.isOk)
  const first = failed.slice(0, NOTICE_NAMES).map(result => `${result.name} (${clip(result.outcome.message, 80)})`).join('; ')
  const more = failed.length > NOTICE_NAMES ? `; and ${failed.length - NOTICE_NAMES} more` : ''
  return { names: failed.map(result => result.name), text: failed.length === 0 ? '' : `Failed: ${first}${more}.` }
}

async function install($: Dollar, catalog: StoreCatalog, bin: string, name: string): Promise<StoreNotice> {
  const mod = catalog.mods.find(one => one.name === name)
  if (mod === undefined) {
    return failure(`There is no mod named ${name} in ${catalog.repository}.`)
  }
  const marketplaceError = await ensureMarketplace($, catalog, bin)
  if (marketplaceError !== undefined) {
    return failure(`Could not add the ${catalog.marketplace} marketplace: ${marketplaceError}`)
  }
  await setJob($, job => ({ ...job, current: name, total: 1 }))
  let outcome = await change($, argv.install(bin, name, catalog.marketplace))
  if (!outcome.isOk && outcome.failureCode === 'not_found') {
    await change($, argv.refreshMarketplace(bin, catalog.marketplace))
    outcome = await change($, argv.install(bin, name, catalog.marketplace))
  }
  await refreshInstalled($, catalog.marketplace)
  if (outcome.isOk) await announceInstalled($, name, mod.version)

  return outcome.isOk
    ? success(`Installed ${name}${mod.version === '' ? '' : ` ${mod.version}`}. Run /reload-plugins to activate it.`)
    : { ...failure(`Could not install ${name}: ${outcome.message}`), retry: { action: 'install', names: [name] } }
}

/**
 * Installs, one after another, every mod of `names` (every mod of the catalog when undefined) that is not
 * installed yet, drawing each as a step of the bar; a failed one is reported and the rest go on.
 */
async function installMods($: Dollar, catalog: StoreCatalog, bin: string, names: readonly string[] | undefined): Promise<StoreNotice> {
  const installed = await knownInstalled($, catalog)
  if (!installed.isKnown) {
    return failure(`Could not read the installed mods: ${installed.error}`)
  }
  const targets = catalog.mods
    .map(mod => mod.name)
    .filter(name => installed.mods[name] === undefined && (names === undefined || names.includes(name)))
  if (targets.length === 0) {
    return info('Every mod is already installed.')
  }
  await setJob($, job => ({ ...job, title: plural(targets.length, 'mod'), total: targets.length }))
  const marketplaceError = await ensureMarketplace($, catalog, bin)
  if (marketplaceError !== undefined) {
    return failure(`Could not add the ${catalog.marketplace} marketplace: ${marketplaceError}`)
  }
  await change($, argv.refreshMarketplace(bin, catalog.marketplace))
  const { results, left } = await eachStep($, targets, async name => {
    const outcome = await change($, argv.install(bin, name, catalog.marketplace))
    if (outcome.isOk) await announceInstalled($, name, catalog.mods.find(mod => mod.name === name)?.version ?? '')
    return outcome
  })
  await refreshInstalled($, catalog.marketplace)
  const added = results.filter(result => result.outcome.isOk).map(result => result.name)
  const failed = failuresOf(results)
  const text = [
    added.length > 0 ? `Installed ${plural(added.length, 'mod')} (${listed(added)}).` : '',
    failed.text,
    left > 0 ? `Stopped with ${plural(left, 'mod')} left.` : '',
    added.length > 0 ? `Run /reload-plugins to activate ${added.length === 1 ? 'it' : 'them'}.` : '',
    added.length >= PROFILE_HINT_MODS ? 'Every enabled mod adds start-up work to each response: a profile keeps only what this project needs.' : '',
  ]
    .filter(part => part !== '')
    .join(' ')
  const retry = failed.names.length > 0 ? { retry: { action: 'install' as const, names: failed.names } } : {}
  const profile = added.length >= PROFILE_HINT_MODS ? { canProfile: true } : {}

  return added.length > 0 ? { ...success(text), ...retry, ...profile }
    : failed.names.length > 0 ? { ...failure(text), ...retry }
    : info(text === '' ? 'Stopped before anything was installed.' : text)
}

async function updateMods($: Dollar, catalog: StoreCatalog, bin: string, names: readonly string[]): Promise<StoreNotice> {
  const installed = await knownInstalled($, catalog)
  if (!installed.isKnown) {
    return failure(`Could not read the installed mods: ${installed.error}`)
  }
  const targets = names.filter(name => installed.mods[name] !== undefined)
  if (targets.length === 0) {
    return info(names.length === 1 ? `${names[0]} is not installed.` : 'Every installed mod is up to date.')
  }
  if (targets.length > 1) {
    await setJob($, job => ({ ...job, title: plural(targets.length, 'mod'), total: targets.length }))
  }
  await change($, argv.refreshMarketplace(bin, catalog.marketplace))
  const { results, left } = await eachStep($, targets, async name => {
    const scope = installed.mods[name]?.scope ?? 'user'
    const outcome = await change($, argv.update(bin, name, catalog.marketplace, scope))
    if (outcome.isOk && outcome.updateOutcome !== 'up_to_date') {
      await announceInstalled($, name, outcome.newVersion ?? catalog.mods.find(mod => mod.name === name)?.version ?? '')
    }
    return outcome
  })
  await refreshInstalled($, catalog.marketplace)
  const updated: string[] = []
  const current: string[] = []
  let versions = ''
  for (const { name, outcome } of results.filter(result => result.outcome.isOk)) {
    if (outcome.updateOutcome === 'up_to_date') {
      current.push(name)
    } else {
      updated.push(name)
      versions = outcome.oldVersion !== undefined && outcome.newVersion !== undefined ? ` ${outcome.oldVersion} → ${outcome.newVersion}` : ''
    }
  }
  const failed = failuresOf(results)
  // One update names its versions; several are counted, with the first names: the notice stays one short line.
  const text = [
    updated.length === 1 ? `Updated ${updated[0]}${versions}.` : updated.length > 1 ? `Updated ${plural(updated.length, 'mod')} (${listed(updated)}).` : '',
    current.length > 0 ? `${listed(current)}: already at the version the marketplace offers.` : '',
    failed.text,
    left > 0 ? `Stopped with ${plural(left, 'mod')} left.` : '',
    updated.length > 0 ? 'Run /reload-plugins to apply.' : '',
  ]
    .filter(part => part !== '')
    .join(' ')
  const retry = failed.names.length > 0 ? { retry: { action: 'update' as const, names: failed.names } } : {}

  return updated.length > 0 ? { ...success(text), ...retry }
    : failed.names.length > 0 ? { ...failure(text), ...retry }
    : info(text === '' ? 'Stopped before anything was updated.' : text)
}

async function uninstall($: Dollar, catalog: StoreCatalog, bin: string, name: string): Promise<StoreNotice> {
  const installed = await knownInstalled($, catalog)
  if (!installed.isKnown) {
    return failure(`Could not read the installed mods: ${installed.error}`)
  }
  const entry = installed.mods[name]
  if (entry === undefined) {
    return info(`${name} is not installed.`)
  }
  if (entry.scope === 'managed') {
    return failure(`${name} is managed by your organization and cannot be uninstalled here.`)
  }
  await setJob($, job => ({ ...job, current: name, total: 1 }))
  const outcome = await change($, argv.uninstall(bin, name, catalog.marketplace, entry.scope))
  await refreshInstalled($, catalog.marketplace)

  return outcome.isOk
    ? success(`Uninstalled ${name}. Run /reload-plugins to unload it.`)
    : failure(`Could not uninstall ${name}: ${outcome.message}`)
}

async function runUpdateAll($: Dollar, catalog: StoreCatalog, bin: string): Promise<StoreNotice> {
  const installed = await knownInstalled($, catalog)
  if (!installed.isKnown) {
    return failure(`Could not read the installed mods: ${installed.error}`)
  }
  const names = updatesOf(catalog, installed).map(mod => mod.name)
  return names.length === 0 ? info('Every installed mod is up to date.') : updateMods($, catalog, bin, names)
}

/** What a job is called while it runs: its verb and what it acts on. */
function jobOf(spec: JobSpec): StoreJob {
  const { action, name, names } = spec
  const [verb, title] =
    action === 'update-all' ? [VERBS.update, 'every mod with an update']
    : action === 'install-all' ? [VERBS.install, spec.title ?? (names === undefined ? 'every mod not yet installed' : plural(names.length, 'mod'))]
    : action === 'profile' ? ['Reading', 'this project']
    : action === 'slim' ? ['Reading', `the last ${spec.days ?? SLIM_DAYS} days of use`]
    : action === 'apply' ? ['Applying', spec.title ?? 'the plan']
    : action === 'undo' ? ['Undoing', 'the last apply']
    : action === 'reset' ? ['Enabling', 'every mod in this project']
    : action === 'enable-pack' ? ['Enabling', spec.title ?? name]
    : [VERBS[action], name]
  return { verb, title, current: '', done: 0, total: 0, failed: 0, isStopping: false }
}

/** Why a new job cannot start now, or undefined when none runs. */
const runningNotice = (): StoreNotice | undefined =>
  active === null ? undefined : info(`${active.verb} ${active.title} is still running. Wait for it, or stop it with s in the store or /mods stop.`)

/** Runs the task of a job; null when it has nothing to say beyond what it drew (a plan read for review). */
async function runTask($: Dollar, config: Config, catalog: StoreCatalog, bin: string, spec: JobSpec): Promise<StoreNotice | null> {
  const { action, name, names } = spec
  switch (action) {
    case 'update-all':
      return runUpdateAll($, catalog, bin)
    case 'install-all':
      return installMods($, catalog, bin, names)
    case 'install':
      return install($, catalog, bin, name)
    case 'update':
      return updateMods($, catalog, bin, [name])
    case 'uninstall':
      return uninstall($, catalog, bin, name)
    case 'profile':
      return readProfile($, catalog)
    case 'slim':
      return readSlim($, catalog, spec.days ?? SLIM_DAYS)
    case 'apply':
      return applyPlan($, catalog, bin)
    case 'undo':
      return undoLast($, catalog, bin)
    case 'reset':
      return resetProject($, catalog)
    case 'enable-pack':
      return enablePack($, catalog, name)
  }
}

/**
 * Runs one job, drawing its progress as the bar and its outcome as the notice, with a toast at the end. The caller
 * has claimed `job` as `active`; this frees it.
 */
async function runJob($: Dollar, config: Config, job: StoreJob, spec: JobSpec): Promise<StoreNotice | null> {
  let notice: StoreNotice | null
  try {
    await update($, jobState, () => job)
    await update($, noticeState, () => null)
    if (spec.action === 'install-all' || spec.action === 'update-all') {
      await refresh($, config, true)
    }
    const catalog = (await currentCatalog($, config)) ?? (await syncCatalog($, config, true))
    const bin = await claudeBin($)
    notice = catalog === null
      ? failure('The catalog is not available: check your connection, then run /mods refresh.')
      : await runTask($, config, catalog, bin, spec)
  } catch (error) {
    notice = failure(`${job.verb} ${job.title} failed: ${describe(error)}`)
  } finally {
    if (active === job) active = null
  }
  await update($, jobState, () => null)
  if (notice !== null) {
    await update($, noticeState, () => notice)
    $.ui.toast(said(notice))
  }

  return notice
}

/**
 * Starts a job in the background, outside the press or command that asked (a timer of its own), so that press
 * settles and the command answers at once; the bar and the notice say the rest. Undefined when it started.
 */
function launch($: Dollar, config: Config, spec: JobSpec): StoreNotice | undefined {
  const busy = runningNotice()
  if (busy !== undefined) return busy
  const job = jobOf(spec)
  active = job
  $.clock.after(0, () => {
    void runJob($, config, job, spec)
  })

  return undefined
}

/** Asks the running job to stop after the mod it is on. */
async function stopJob($: Dollar): Promise<boolean> {
  if (active === null) return false
  const job = await setJob($, current => ({ ...current, isStopping: true }))
  return job !== null
}

// ── Profiles, slims and packs: read, review, apply, undo ─────────────────────

/** Where Claude Code keeps its configuration (transcripts under `projects/`); undefined when no home is known. */
async function configRoot($: Dollar): Promise<string | undefined> {
  const [custom, home, profile] = await Promise.all([
    $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined),
    $.env.get('HOME').catch(() => undefined),
    $.env.get('USERPROFILE').catch(() => undefined),
  ])
  if (custom !== undefined && custom !== '') return custom
  const base = home !== undefined && home !== '' ? home : profile
  return base === undefined || base === '' ? undefined : joinPath(base, '.claude')
}

/**
 * The project's paths, breadth first and bounded (WALK): files as `a/b.ts`, folders as `a/` so a catalog glob such as
 * `k8s/**` matches a folder the walk did not enter. Dependencies, build output and VCS folders are skipped.
 */
async function walkProject($: Dollar, root: string): Promise<string[]> {
  const paths: string[] = []
  const queue: { dir: string; rel: string; depth: number }[] = [{ dir: root, rel: '', depth: 0 }]
  let listed = 0
  while (queue.length > 0 && listed < WALK.dirs && paths.length < WALK.paths) {
    const folder = queue.shift()
    if (folder === undefined) break
    listed += 1
    const entries = await $.fs.list(folder.dir).catch(() => [])
    for (const entry of entries) {
      const rel = folder.rel === '' ? entry.name : `${folder.rel}/${entry.name}`
      if (entry.kind === 'dir' && !SKIP_DIRS.has(entry.name)) {
        paths.push(`${rel}/`)
        if (folder.depth + 1 < WALK.depth) queue.push({ dir: joinPath(folder.dir, entry.name), rel, depth: folder.depth + 1 })
      } else if (entry.kind === 'file') {
        paths.push(rel)
      }
    }
  }
  return paths.slice(0, WALK.paths)
}

/** The dependencies the project's manifests declare (package.json, pyproject.toml, requirements, Gemfile, ...). */
async function readDeps($: Dollar, root: string, paths: readonly string[]): Promise<string[]> {
  const files = paths.filter(path => isDepFile(path) && path.split('/').length <= DEP_FILE_DEPTH).slice(0, DEP_FILES_MAX)
  const texts = await Promise.all(files.map(path => $.fs.read(joinPath(root, ...path.split('/'))).catch(() => '')))
  return [...new Set(files.flatMap((path, index) => parseDeps(path, texts[index] ?? '')))]
}

type TranscriptFile = { path: string; size: number; mtimeMs: number }
type CachedUsage = { size: number; mtimeMs: number; usage: TranscriptUsage }
type UsageScan = { usage: TranscriptUsage; scanned: number; skipped: number }

/** Transcripts written since `since`, newest first and capped: of the named project folders, or of every project. */
async function listTranscripts($: Dollar, projects: string, folders: readonly string[] | undefined, since: number, max: number): Promise<TranscriptFile[]> {
  const names = folders ?? (await $.fs.list(projects).catch(() => []))
    .filter(entry => entry.kind === 'dir')
    .map(entry => entry.name)
    .slice(0, PROJECT_DIRS_MAX)
  const files: TranscriptFile[] = []
  for (const name of names) {
    const folder = joinPath(projects, name)
    for (const entry of await $.fs.list(folder).catch(() => [])) {
      if (entry.kind === 'file' && entry.name.endsWith('.jsonl') && entry.mtimeMs >= since) {
        files.push({ path: joinPath(folder, entry.name), size: entry.size, mtimeMs: entry.mtimeMs })
      }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, max)
}

/** One transcript's usage: read whole up to the 4 MiB cap, else its newest chunk through `tail`; undefined when unreadable. */
async function readTranscript($: Dollar, file: TranscriptFile): Promise<TranscriptUsage | undefined> {
  try {
    if (file.size <= READ_CAP_BYTES) return parseTranscript(await $.fs.read(file.path))
    const tail = await $.process.run(['tail', '-c', String(CHUNK_BYTES), file.path], { timeoutMs: TAIL_TIMEOUT_MS })
    return tail.exitCode === 0 ? parseTranscript(tail.stdout, true) : undefined
  } catch {
    return undefined
  }
}

/**
 * Reads usage from transcripts, newest first, bounded in files and bytes, one file per step of the job's bar (Stop
 * ends it early). Without prompts, each file's result is cached in $.store by path, size and time, so a second
 * scan only reads what changed.
 */
async function scanUsage($: Dollar, files: readonly TranscriptFile[], withPrompts: boolean, isJob: boolean): Promise<UsageScan> {
  const cache = withPrompts ? {} : (((await $.store.get(USAGE_CACHE_KEY).catch(() => undefined)) ?? {}) as Record<string, CachedUsage>)
  const fresh: Record<string, CachedUsage> = {}
  const found: TranscriptUsage[] = []
  let skipped = 0
  let bytes = 0
  if (isJob) await setJob($, job => ({ ...job, done: 0, total: files.length }))
  for (const [index, file] of files.entries()) {
    if (isJob && (await isStopping($))) break
    const known = cache[file.path]
    if (known !== undefined && known.size === file.size && known.mtimeMs === file.mtimeMs) {
      found.push(known.usage)
      fresh[file.path] = known
      continue
    }
    bytes += Math.min(file.size, READ_CAP_BYTES)
    if (bytes > TRANSCRIPT_BYTES_MAX) {
      skipped += files.length - index
      break
    }
    if (isJob) await setJob($, job => ({ ...job, current: `transcript ${index + 1}/${files.length}`, done: index }))
    const usage = await readTranscript($, file)
    if (usage === undefined) {
      skipped += 1
      continue
    }
    found.push(usage)
    if (!withPrompts) fresh[file.path] = { size: file.size, mtimeMs: file.mtimeMs, usage: { ...usage, prompts: [] } }
  }
  if (!withPrompts) {
    const kept = Object.entries(fresh).slice(0, USAGE_CACHE_LIMIT)
    await $.store.set(USAGE_CACHE_KEY, Object.fromEntries(kept)).catch(() => undefined)
  }
  return { usage: mergeUsage(found), scanned: found.length, skipped }
}

/** When each mod last published on the mods-hub feed in this session (`$.mods.recent`); empty without the hub. */
async function feedUses($: Dollar): Promise<Record<string, number>> {
  try {
    const events = await $.mods.recent({ limit: FEED_LIMIT })
    const last: Record<string, number> = {}
    for (const event of events) last[event.source] = Math.max(last[event.source] ?? 0, event.at)
    return last
  } catch {
    return {}
  }
}

const basename = (path: string): string => path.split(/[\\/]/).filter(part => part !== '').pop() ?? path

/** Reads this project (files, dependencies, its own transcripts) and puts the proposed profile up for review. */
async function readProfile($: Dollar, catalog: StoreCatalog): Promise<StoreNotice | null> {
  // A catalog from before profiles has no signals: every mod would read as "not needed", so say so instead.
  if (!catalog.mods.some(mod => mod.signals !== undefined)) {
    return info(`The catalog of ${catalog.repository}@${catalog.branch} has no project signals yet, so a profile cannot tell what this project needs. Run /mods refresh once it is updated.`)
  }
  const installed = await refreshInstalled($, catalog.marketplace)
  if (!installed.isKnown) return failure(`Could not read the installed mods: ${installed.error}`)
  const [root, now, config] = await Promise.all([$.session.root(), $.clock.now(), configRoot($)])
  await setJob($, job => ({ ...job, current: 'project files' }))
  const paths = await walkProject($, root)
  const deps = await readDeps($, root, paths)
  const files = config === undefined
    ? []
    : await listTranscripts($, joinPath(config, 'projects'), [projectFolder(root)], 0, PROJECT_TRANSCRIPTS_MAX)
  const { usage } = await scanUsage($, files, true, true)
  const essentials = catalog.packs?.find(pack => pack.id === ESSENTIALS_PACK)?.mods ?? []
  const rows = proposeProfile({
    mods: catalog.mods,
    installed: installed.mods,
    paths,
    deps,
    used: usesByMod(catalog.mods, usage),
    prompts: usage.prompts,
    essentials,
  })
  await update($, planState, (): StorePlan => ({ kind: 'profile', root, createdAt: now, rows }))
  if (rows.length === 0) return info('No mod of this marketplace is installed, so there is nothing to profile.')
  const kept = rows.filter(row => row.keep).length
  $.ui.toast(`◆ ${basename(root)} needs ${kept} of ${plural(rows.length, 'installed mod')}. Review, then Apply (/mods profile apply).`)
  return null
}

/** Reads the last `days` of use across every project and puts the idle mods up for review. */
async function readSlim($: Dollar, catalog: StoreCatalog, days: number): Promise<StoreNotice | null> {
  const installed = await refreshInstalled($, catalog.marketplace)
  if (!installed.isKnown) return failure(`Could not read the installed mods: ${installed.error}`)
  const [root, now, config] = await Promise.all([$.session.root(), $.clock.now(), configRoot($)])
  const files = config === undefined ? [] : await listTranscripts($, joinPath(config, 'projects'), undefined, now - days * DAY_MS, TRANSCRIPTS_MAX)
  const scan = await scanUsage($, files, false, true)
  const uses = usesByMod(catalog.mods, scan.usage, await feedUses($))
  const rows = proposeSlim({ mods: catalog.mods, installed: installed.mods, uses, now, days })
  const historyDays = scan.usage.first === null ? 0 : Math.max(0, Math.floor((now - scan.usage.first) / DAY_MS))
  await update($, planState, (): StorePlan => ({ kind: 'slim', root, createdAt: now, rows, days, scanned: scan.scanned, skipped: scan.skipped, historyDays }))
  const idle = rows.filter(row => !row.keep).length
  $.ui.toast(idle === 0
    ? `◆ Every enabled mod was used in the last ${days} days.`
    : `◆ ${plural(idle, 'mod')} idle for ${days} days. Review, then Apply (/mods slim apply).`)
  return null
}

/** Brings the plan's "enabled now" up to date with the installed mods (after an apply or an undo), so it shows what is left to change. */
async function syncPlan($: Dollar, installed: StoreInstalled): Promise<void> {
  if (!installed.isKnown) return
  await update($, planState, plan => plan === null ? null : {
    ...plan,
    rows: plan.rows.map(row => ({ ...row, isEnabled: installed.mods[row.name]?.isEnabled ?? row.isEnabled })),
  })
}

/** Applies the plan under review: a profile to this project's settings.local.json, a slim through the CLI. */
async function applyPlan($: Dollar, catalog: StoreCatalog, bin: string): Promise<StoreNotice> {
  const plan = await read($, planState)
  if (plan === null) return info('There is no plan to apply: run /mods profile or /mods slim first.')
  const changes = changesOf(plan.rows)
  if (changes.length === 0) return info('Nothing to change: every mod is already as the plan says.')
  if (plan.kind === 'profile') {
    const edits = Object.fromEntries(changes.map(row => [pluginId(row.name, catalog.marketplace), row.keep]))
    const off = changes.filter(row => !row.keep).length
    const on = changes.length - off
    const what = [off > 0 ? `disabled ${plural(off, 'mod')}` : '', on > 0 ? `enabled ${plural(on, 'mod')}` : ''].filter(part => part !== '').join(' and ')
    return writeLocal($, catalog, plan.root, edits, `the ${basename(plan.root)} profile`, `Profile applied to ${basename(plan.root)}: ${what}.`)
  }
  return slimWithCli($, catalog, bin, changes)
}

/**
 * Writes `edits` to the project's `.claude/settings.local.json` in one go (the file `claude plugin disable --scope
 * local` writes, one CLI run per mod), keeping every other key, and records what it replaced for Undo. A file that
 * cannot be read or is not a JSON object is left untouched.
 */
async function writeLocal($: Dollar, catalog: StoreCatalog, root: string, edits: Record<string, boolean | null>, label: string, done: string): Promise<StoreNotice> {
  const path = joinPath(root, ...SETTINGS_LOCAL.split('/'))
  await setJob($, job => ({ ...job, current: SETTINGS_LOCAL, done: 0, total: 3 }))
  let current: string | undefined
  try {
    current = await $.fs.read(path)
  } catch (error) {
    if (await $.fs.exists(path).catch(() => true)) {
      return failure(`Could not read ${SETTINGS_LOCAL} (${describe(error)}), so nothing was changed.`)
    }
    current = undefined
  }
  const edit = editEnabledPlugins(current, edits)
  if (!edit.isOk) return failure(`Left ${SETTINGS_LOCAL} untouched: ${edit.reason}. Fix or move it, then apply again.`)
  await setJob($, job => ({ ...job, done: 1 }))
  await $.fs.write(path, edit.text)
  const undo: UndoRecord = { kind: 'local', path, previous: edit.previous, label }
  await $.store.set(UNDO_KEY, undo)
  await setJob($, job => ({ ...job, current: 'checking', done: 2 }))
  await syncPlan($, await refreshInstalled($, catalog.marketplace))

  return { ...success(`${done} Written to ${SETTINGS_LOCAL} (this project only, kept out of git). Reload plugins to apply.`), canUndo: true }
}

/** Disables a slim's mods at user scope with `claude plugin disable`, one per step; mods installed in other scopes are left. */
async function slimWithCli($: Dollar, catalog: StoreCatalog, bin: string, changes: readonly StorePlanRow[]): Promise<StoreNotice> {
  const installed = await knownInstalled($, catalog)
  if (!installed.isKnown) return failure(`Could not read the installed mods: ${installed.error}`)
  const targets = changes.filter(row => !row.keep && installed.mods[row.name]?.scope === 'user').map(row => row.name)
  const elsewhere = changes.length - targets.length
  const { results, left } = await eachStep($, targets, name => change($, argv.disable(bin, name, catalog.marketplace, 'user')))
  const disabled = results.filter(result => result.outcome.isOk).map(result => result.name)
  if (disabled.length > 0) {
    const undo: UndoRecord = { kind: 'cli', names: disabled, label: 'the slim' }
    await $.store.set(UNDO_KEY, undo)
  }
  await syncPlan($, await refreshInstalled($, catalog.marketplace))
  const failed = failuresOf(results)
  const text = [
    disabled.length > 0 ? `Disabled ${plural(disabled.length, 'idle mod')} everywhere (${listed(disabled)}).` : '',
    failed.text,
    elsewhere > 0 ? `${plural(elsewhere, 'mod')} installed in a project scope left as they are.` : '',
    left > 0 ? `Stopped with ${plural(left, 'mod')} left.` : '',
    disabled.length > 0 ? 'Reload plugins to apply.' : '',
  ].filter(part => part !== '').join(' ')

  return disabled.length > 0 ? { ...success(text), canUndo: true } : failed.names.length > 0 ? failure(text) : info(text === '' ? 'Nothing was disabled.' : text)
}

/** Undoes the last apply: the settings entries it replaced, or the mods it disabled through the CLI. */
async function undoLast($: Dollar, catalog: StoreCatalog, bin: string): Promise<StoreNotice> {
  const undo = (await $.store.get(UNDO_KEY).catch(() => undefined)) as UndoRecord | undefined
  if (undo === undefined || undo === null) return info('There is nothing to undo.')
  if (undo.kind === 'local') {
    let current: string | undefined
    try {
      current = await $.fs.read(undo.path)
    } catch {
      current = undefined
    }
    const edit = editEnabledPlugins(current, undo.previous)
    if (!edit.isOk) return failure(`Could not undo: ${SETTINGS_LOCAL} ${edit.reason.replace(/^it /, '')}.`)
    await $.fs.write(undo.path, edit.text)
  } else {
    const { results } = await eachStep($, undo.names, name => change($, argv.enable(bin, name, catalog.marketplace, 'user')))
    const failed = failuresOf(results)
    if (failed.names.length > 0) {
      await $.store.set(UNDO_KEY, { ...undo, names: failed.names })
      await refreshInstalled($, catalog.marketplace)
      return failure(`Undo left ${plural(failed.names.length, 'mod')} disabled. ${failed.text}`)
    }
  }
  await $.store.delete(UNDO_KEY)
  await syncPlan($, await refreshInstalled($, catalog.marketplace))
  return success(`Undid ${undo.label}. Reload plugins to apply.`)
}

/** `/mods profile reset`: removes every entry of this marketplace this project's settings.local.json turns off. */
async function resetProject($: Dollar, catalog: StoreCatalog): Promise<StoreNotice> {
  const root = await $.session.root()
  const path = joinPath(root, ...SETTINGS_LOCAL.split('/'))
  const current = await $.fs.read(path).catch(() => undefined)
  const edits = disabledEntries(current, catalog.marketplace)
  const count = Object.keys(edits).length
  return count === 0
    ? info(`No mod is turned off in ${basename(root)}'s ${SETTINGS_LOCAL}.`)
    : writeLocal($, catalog, root, edits, `the reset of ${basename(root)}`, `Enabled ${plural(count, 'mod')} again in ${basename(root)}.`)
}

/** Enables a pack's installed members in this project (local `true` overrides a user-level off). */
async function enablePack($: Dollar, catalog: StoreCatalog, id: string): Promise<StoreNotice> {
  const pack = catalog.packs?.find(one => one.id === id)
  if (pack === undefined) return failure(`There is no pack named ${id}.`)
  const installed = await refreshInstalled($, catalog.marketplace)
  if (!installed.isKnown) return failure(`Could not read the installed mods: ${installed.error}`)
  const off = pack.mods.filter(name => installed.mods[name]?.isEnabled === false)
  const missing = pack.mods.filter(name => installed.mods[name] === undefined).length
  const tail = missing > 0 ? ` ${plural(missing, 'mod')} of it ${missing === 1 ? 'is' : 'are'} not installed: Install pack adds ${missing === 1 ? 'it' : 'them'}.` : ''
  if (off.length === 0) return info(`Every installed mod of ${pack.title} is already enabled here.${tail}`)
  const root = await $.session.root()
  const edits = Object.fromEntries(off.map(name => [pluginId(name, catalog.marketplace), true]))
  return writeLocal($, catalog, root, edits, `enabling ${pack.title}`, `Enabled ${plural(off.length, 'mod')} of ${pack.title} in ${basename(root)}.${tail}`)
}

/**
 * The weekly slim tip, from a timer minutes after start (never inside session.start): at most once a week, only in
 * an interactive session, never in Silent or Night mode, and only when at least NUDGE_IDLE mods are idle.
 */
async function nudgeSlim($: Dollar, config: Config): Promise<void> {
  const state = ((await $.store.get(NUDGE_KEY).catch(() => undefined)) ?? {}) as NudgeState
  const now = await $.clock.now()
  if (state.isOff === true || (state.lastAt ?? 0) > now - NUDGE_EVERY_MS || active !== null) return
  const isQuiet = async () => {
    const mode = await hubMode($)
    return mode?.isSilent === true || mode?.isNight === true
  }
  if (await isQuiet()) return
  await $.store.set(NUDGE_KEY, { ...state, lastAt: now })
  await refresh($, config, false)
  const catalog = await currentCatalog($, config)
  const installed = await read($, installedState)
  if (catalog === null || installed?.isKnown !== true) return
  if (Object.values(installed.mods).filter(mod => mod.isEnabled).length < NUDGE_IDLE) return
  const root = await configRoot($)
  const files = root === undefined ? [] : await listTranscripts($, joinPath(root, 'projects'), undefined, now - SLIM_DAYS * DAY_MS, TRANSCRIPTS_MAX)
  const scan = await scanUsage($, files, false, false)
  const uses = usesByMod(catalog.mods, scan.usage, await feedUses($))
  const idle = proposeSlim({ mods: catalog.mods, installed: installed.mods, uses, now, days: SLIM_DAYS }).filter(row => !row.keep).length
  if (idle < NUDGE_IDLE || (await isQuiet())) return
  $.ui.toast(`◆ ${idle} mods unused for ${SLIM_DAYS} days still load on every response · /mods slim to review · /mods slim off hides this tip`, {
    timeoutMs: NUDGE_TOAST_MS,
  })
}

/** Turns the weekly slim tip off or on. */
async function setNudge($: Dollar, isOff: boolean): Promise<string> {
  const state = ((await $.store.get(NUDGE_KEY).catch(() => undefined)) ?? {}) as NudgeState
  await $.store.set(NUDGE_KEY, { ...state, isOff })
  return isOff ? '◆ The weekly slim tip is off. /mods slim on brings it back.' : '◆ The weekly slim tip is on (at most once a week, never in Silent or Night).'
}

// ── Pane helpers ─────────────────────────────────────────────────────────────

async function setReadme($: Dollar, name: string, readme: StoreReadme): Promise<void> {
  await update($, readmesState, all =>
    Object.fromEntries([...Object.entries(all).filter(([key]) => key !== name), [name, readme]].slice(-README_LIMIT)),
  )
}

/** Fetches a mod's README and its settings (`userConfig`) for its page, once each. */
async function loadDetail($: Dollar, catalog: StoreCatalog, mod: StoreMod): Promise<void> {
  const known = (await read($, readmesState))[mod.name]
  if (known?.phase === 'ready' || readmesLoading.has(mod.name)) {
    return
  }
  readmesLoading.add(mod.name)
  try {
    await setReadme($, mod.name, { phase: 'loading', text: '' })
    const folder = mod.path ?? `mods/${mod.name}`
    const [text, manifest] = await Promise.all([
      fetchText($, readmeRawUrl(catalog, mod)).catch(() => undefined),
      fetchText($, rawUrl(catalog, `${folder}/.claude-plugin/plugin.json`)).catch(() => ''),
    ])
    const rows: StoreConfigRow[] = parseConfig(manifest)
    const readme: StoreReadme = text === undefined ? { phase: 'missing', text: '' } : { phase: 'ready', text: trimReadme(text, mod, rows.length > 0) }
    await update($, configsState, all =>
      Object.fromEntries([...Object.entries(all).filter(([key]) => key !== mod.name), [mod.name, rows]].slice(-README_LIMIT)),
    )
    await setReadme($, mod.name, readme)
  } finally {
    readmesLoading.delete(mod.name)
  }
}

const setNav = ($: Dollar, next: (nav: StoreView) => StoreView): Promise<StoreView> => update($, navState, next)

async function openDetail($: Dollar, config: Config, name: string): Promise<void> {
  await setNav($, nav => ({ ...nav, selected: name }))
  const catalog = await currentCatalog($, config)
  const mod = catalog?.mods.find(one => one.name === name)
  if (catalog !== null && mod !== undefined) {
    await loadDetail($, catalog, mod)
  }
}

async function copy($: Dollar, text: string, what: string, surface: RenderSurface): Promise<void> {
  const copied = await $.ui.copy({ text, surface })
  if (copied.isCopied) {
    $.ui.toast(`✓ Copied the ${what}`)
  } else {
    await update($, noticeState, () => info(`No clipboard here (${copied.reason}). The ${what}: ${text}`))
  }
}

async function reloadPlugins($: Dollar): Promise<void> {
  await update($, noticeState, () => null)
  try {
    await $.command.run({ command: 'reload-plugins' })
  } catch {
    $.ui.toast('Run /reload-plugins to apply the change')
  }
}

/** What mod-advisor recommended in this session (`mod.recommended` on the hub's bus); nothing without the hub. */
async function refreshPicks($: Dollar): Promise<void> {
  let names: string[]
  try {
    const events = await $.mods.recent({ topic: 'mod.recommended', limit: 20 })
    names = events
      .map(event => {
        const data = event.data
        return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as { name?: unknown }).name : undefined
      })
      .filter((name): name is string => typeof name === 'string')
  } catch {
    return
  }
  const unique = [...new Set(names.reverse())].slice(0, PICKS_LIMIT * 2)
  await update($, picksState, () => unique)
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function listingText($: Dollar, config: Config, query: string): Promise<string> {
  const catalog = await currentCatalog($, config)
  if (catalog === null) {
    return `✗ The catalog is not available (${(await read($, syncState)).message ?? 'not loaded yet'}).`
  }
  const installed = await read($, installedState)
  const mods = matchMods(catalog, installed, query, FILTER_ALL)
  const lines = mods.slice(0, LISTING_LIMIT).map(mod => {
    const status = statusOf(mod, installed)
    const mark = status.kind === 'update' ? ` [update ${mod.version}]` : status.kind === 'installed' ? ' [installed]' : ''
    return `- ${mod.name}${mark}: ${mod.description}`
  })
  const more = mods.length > LISTING_LIMIT ? [`…and ${mods.length - LISTING_LIMIT} more.`] : []
  const title = query === '' ? plural(mods.length, 'mod') : `${plural(mods.length, 'mod')} match "${query}"`

  return [`◆ ${title} (the store pane could not be shown here).`, ...lines, ...more].join('\n')
}

async function refreshReport($: Dollar, config: Config): Promise<string> {
  await refresh($, config, true)
  const catalog = await currentCatalog($, config)
  const sync = await read($, syncState)
  if (catalog === null) {
    return `✗ Could not load the catalog: ${sync.message ?? 'unknown error'}.`
  }
  const installed = await read($, installedState)
  const counts = countsOf(catalog, installed)
  const categories = plural(catalog.categories.length, 'category', 'categories')
  const offline = sync.phase === 'offline'
    ? ` Offline (${sync.message ?? 'no answer'}): showing the catalog cached ${formatAge((await $.clock.now()) - catalog.fetchedAt)}.`
    : ''
  const status = installed?.isKnown === false
    ? `install status unavailable (${installed.error})`
    : `${counts.installed} installed, ${plural(counts.updates, 'update')} available`

  return `◆ ${plural(counts.mods, 'mod')} in ${categories}, ${status}.${offline}`
}

const openPane = ($: Dollar) => $.ui.open({ id: PANE, title: PANE_TITLE, focus: true, closeOnEscape: true, rows: PANE_ROWS })

async function openStore($: Dollar, config: Config, query: string | undefined): Promise<CommandRunResult> {
  await update($, navState, () => ({ ...HOME, query: query ?? '' }))
  await currentCatalog($, config)
  const opened = await openPane($)
  if (!opened.isPlaced) {
    await refresh($, config, false)
    return { text: await listingText($, config, query ?? '') }
  }
  void refresh($, config, false).then(() => refreshPicks($))

  return {
    text: query === undefined || query === ''
      ? '◆ Opened the mod store.'
      : `◆ Opened the mod store, searching for "${query}".`,
  }
}

/** How many mods a bulk command would act on, when the store already knows; undefined when it has to look. */
async function bulkCount($: Dollar, config: Config, action: Bulk): Promise<number | undefined> {
  const catalog = await currentCatalog($, config)
  const installed = await read($, installedState)
  if (catalog === null || installed?.isKnown !== true) return undefined
  return action === 'update-all'
    ? updatesOf(catalog, installed).length
    : catalog.mods.filter(mod => installed.mods[mod.name] === undefined).length
}

/**
 * Starts a change from the prompt and answers at once: the job runs in the background, the store opens on its
 * progress bar (where one can be placed), and the outcome arrives as the store's notice and a toast.
 */
async function startFromCommand($: Dollar, config: Config, action: Action | Bulk, name: string): Promise<CommandRunResult> {
  const count = action === 'install-all' || action === 'update-all' ? await bulkCount($, config, action) : undefined
  const catalog = await currentCatalog($, config)
  if (action === 'install' && catalog !== null && !catalog.mods.some(mod => mod.name === name)) {
    return { text: said(failure(`There is no mod named ${name} in ${catalog.repository}.`)) }
  }
  const busy = launch($, config, { action, name })
  if (busy !== undefined) {
    return { text: said(busy) }
  }
  const opened = await openPane($).catch(() => ({ isPlaced: false as const }))
  const what = action === 'install-all'
    ? count === undefined ? 'Installing every mod not yet installed' : `Installing ${plural(count, 'mod')}`
    : action === 'update-all'
      ? count === undefined ? 'Updating every mod with an update' : `Updating ${plural(count, 'mod')}`
      : `${VERBS[action]} ${name}`
  const where = opened.isPlaced ? 'Progress is in the store; s stops it.' : 'A toast says when it is done; /mods stop stops it.'

  return { text: `◆ ${what} in the background. ${where}` }
}

/** Where the plan screen is: the person's typing of `/mods profile` or `/mods slim`, or a press of Profile or Slim. */
const showPlan = ($: Dollar): Promise<StoreView> =>
  setNav($, nav => ({ ...nav, selected: null, screen: 'plan', planTab: 'disable', planPage: 0 }))

/**
 * Starts reading a profile or a slim in the background and opens the store on the plan screen, where the bar shows
 * the reading and the lists appear when it is done; nothing is written until Apply.
 */
async function startPlan($: Dollar, config: Config, kind: StorePlan['kind'], days?: number): Promise<CommandRunResult> {
  const busy = launch($, config, { action: kind, name: '', ...(days === undefined ? {} : { days }) })
  if (busy !== undefined) return { text: said(busy) }
  await update($, planState, () => null)
  await showPlan($)
  const opened = await openPane($).catch(() => ({ isPlaced: false as const }))
  const what = kind === 'profile' ? 'Reading this project to see which mods it needs' : `Reading the last ${days ?? SLIM_DAYS} days of use`
  const where = opened.isPlaced
    ? 'The lists open in the store; nothing changes until you press Apply.'
    : `A toast gives the count; /mods ${kind} apply applies it.`
  return { text: `◆ ${what}. ${where}` }
}

/** `/mods profile apply` and `/mods slim apply`: applies the plan already read, never one the person has not seen. */
async function applyFromCommand($: Dollar, config: Config, kind: StorePlan['kind']): Promise<CommandRunResult> {
  const plan = await read($, planState)
  if (plan === null || plan.kind !== kind) return { text: `• Nothing to apply yet: run /mods ${kind} to read the plan first.` }
  const changes = changesOf(plan.rows)
  if (changes.length === 0) return { text: '• Nothing to change: every mod is already as the plan says.' }
  const busy = launch($, config, { action: 'apply', name: '', title: kind === 'profile' ? `the ${basename(plan.root)} profile` : 'the slim' })
  return { text: busy === undefined ? `◆ Applying ${plural(changes.length, 'change')} in the background.` : said(busy) }
}

/** `/mods packs`: every pack with how much of it is installed. */
async function packsText($: Dollar, config: Config): Promise<string> {
  const catalog = await currentCatalog($, config) ?? await syncCatalog($, config, false)
  if (catalog === null) return '✗ The catalog is not available: check your connection, then run /mods refresh.'
  const packs = catalog.packs ?? []
  if (packs.length === 0) return `• ${catalog.repository} defines no packs.`
  const installed = await knownInstalled($, catalog)
  const have = (pack: StorePack) => installed.isKnown ? pack.mods.filter(name => installed.mods[name] !== undefined).length : 0
  return [
    '◆ Packs: curated bundles, lighter than installing everything.',
    ...packs.map(pack => `- ${pack.id}: ${pack.title}, ${plural(pack.mods.length, 'mod')} (${have(pack)} installed). ${pack.tagline}`),
    'Install one with /mods pack <id> install, or enable its installed mods here with /mods pack <id> enable.',
  ].join('\n')
}

/** `/mods pack <id> [install|enable]`: opens the pack, or starts its install or enable in the background. */
async function packCommand($: Dollar, config: Config, id: string, step: 'show' | 'install' | 'enable'): Promise<CommandRunResult> {
  const catalog = await currentCatalog($, config) ?? await syncCatalog($, config, false)
  const pack = catalog?.packs?.find(one => one.id === id)
  if (catalog === null || pack === undefined) {
    return { text: `✗ There is no pack named ${id}. /mods packs lists them.` }
  }
  if (step === 'show') {
    await setNav($, nav => ({ ...nav, selected: null, screen: 'pack', pack: pack.id }))
    const opened = await openPane($).catch(() => ({ isPlaced: false as const }))
    return { text: opened.isPlaced ? `◆ Opened the ${pack.title} pack.` : `◆ ${pack.title}: ${pack.mods.join(', ')}.` }
  }
  const busy = launch($, config, step === 'install'
    ? { action: 'install-all', name: '', names: pack.mods, title: `the ${pack.title} pack` }
    : { action: 'enable-pack', name: pack.id, title: `the ${pack.title} pack` })
  return { text: busy === undefined ? `◆ ${step === 'install' ? 'Installing' : 'Enabling'} the ${pack.title} pack in the background.` : said(busy) }
}

async function announceUpdates($: Dollar, config: Config): Promise<void> {
  await refresh($, config, false)
  const catalog = await currentCatalog($, config)
  if (catalog === null) {
    return
  }
  const updates = updatesOf(catalog, await read($, installedState))
  const fingerprint = updates.map(mod => `${mod.name}@${mod.version}`).sort().join(' ')
  if (updates.length === 0 || (await $.store.get(ANNOUNCED_KEY)) === fingerprint) {
    return
  }
  await $.store.set(ANNOUNCED_KEY, fingerprint)
  const names = updates.slice(0, ANNOUNCE_NAMES).map(mod => mod.name).join(', ')
  const more = updates.length > ANNOUNCE_NAMES ? ', …' : ''
  $.ui.toast(`↑ ${plural(updates.length, 'mod update')} available (${names}${more}) · /mods update-all`, {
    timeoutMs: ANNOUNCE_TOAST_MS,
  })
}

/** Starts a job from the prompt and answers at once with `text`, or why it cannot start. */
function launchText($: Dollar, config: Config, spec: JobSpec, text: string): CommandRunResult {
  const busy = launch($, config, spec)
  return { text: busy === undefined ? text : said(busy) }
}

/** Registers a slash command. A refused name is reported as a notice, never thrown, so the rest of session.start still runs. */
async function registerCommand($: Dollar, spec: Parameters<Dollar['command']['register']>[0]): Promise<boolean> {
  try {
    await $.command.register(spec)
    return true
  } catch (error) {
    $.ui.log(`/${spec.name} was not registered (${describe(error)}).`)
    return false
  }
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  const config = configOf(String(options.repository ?? DEFAULT_REPOSITORY), String(options.branch ?? DEFAULT_BRANCH))
  const shouldAnnounce = options.checkForUpdates !== false

  on('session.start', async ($, e, next) => {
    await registerCommand($, {
      name: 'mods',
      description: 'Browse, install and update Claude Mods; profile a project, slim idle mods, install packs',
      argumentHint: ARGUMENT_HINT,
    })
    // Never awaited inside session.start: ~200 mods share one hooks worker (shared/hub-client.ts afterStart).
    afterStart($, 'mod-store', () => greetHub($))
    if (e.isInteractive && shouldAnnounce) {
      void announceUpdates($, config).catch(error =>
        $.ui.log(`update check failed: ${describe(error)}`, { to: 'debug' }),
      )
    }
    if (e.isInteractive) {
      // The weekly slim tip reads transcripts: minutes after start, on a timer, never on the start path.
      $.clock.after(NUDGE_DELAY_MS, () => {
        void nudgeSlim($, config).catch(error => $.ui.log(`slim tip failed: ${describe(error)}`, { to: 'debug' }))
      })
    }

    return next(e)
  })

  on('command.run', { command: 'mods' }, async ($, e) => {
    const command = parseArgs(e.args)
    switch (command.kind) {
      case 'open':
        return openStore($, config, command.query)
      case 'refresh':
        return { text: await refreshReport($, config) }
      case 'stop':
        return { text: (await stopJob($)) ? '◆ Stopping after the mod it is on.' : '• Nothing is running.' }
      case 'install-all':
      case 'update-all':
        return startFromCommand($, config, command.kind, '')
      case 'install':
      case 'update':
      case 'uninstall':
        return startFromCommand($, config, command.kind, command.name)
      case 'profile':
        return command.step === 'show' ? startPlan($, config, 'profile')
          : command.step === 'apply' ? applyFromCommand($, config, 'profile')
          : launchText($, config, { action: 'reset', name: '' }, '◆ Enabling every mod in this project again, in the background.')
      case 'slim':
        return command.step === 'show' ? startPlan($, config, 'slim', command.days ?? SLIM_DAYS)
          : command.step === 'apply' ? applyFromCommand($, config, 'slim')
          : { text: await setNudge($, command.step === 'off') }
      case 'undo':
        return launchText($, config, { action: 'undo', name: '' }, '◆ Undoing the last apply in the background.')
      case 'packs':
        return { text: await packsText($, config) }
      case 'pack':
        return packCommand($, config, command.id, command.step)
      case 'usage':
        return { text: `✗ ${command.reason} Usage: /mods ${ARGUMENT_HINT}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawStore($, e, config)).catch(async ($, e, next) =>
    next.error.kind === 're-entry'
      ? next(e)
      : paneFailure($.ui.resolve(e), { title: 'mod-store', failure: next.error, below: await next(e).catch(() => null), onRetry: () => $.ui.invalidate('ui.render') }),
  )
}

// ── The pane ─────────────────────────────────────────────────────────────────

/** The badge a mod's row and page carry: its status, or that it is new, or its version. */
function badgeOf(catalog: StoreCatalog, mod: StoreMod, status: ModStatus): { text: string; color: string; isDim: boolean } {
  return status.kind === 'update' ? { text: `↑ Update ${mod.version}`, color: 'warning', isDim: false }
    : status.kind === 'installed'
      ? status.install.isEnabled ? { text: '✓ Installed', color: 'success', isDim: false } : { text: '✓ Disabled', color: 'inactive', isDim: false }
    : isNewMod(catalog, mod) ? { text: '● New', color: 'claude', isDim: false }
    : { text: mod.version === '' ? '' : `v${mod.version}`, color: 'inactive', isDim: true }
}

/**
 * Draws the store: the list (home) or a mod's page. Navigation lives in `nav`, progress in `job`: the two are
 * written by different hands, so a job moving its bar never undoes a press of Back, and every press settles at once
 * (the work it starts runs on a timer of its own).
 */
async function drawStore($: Dollar, e: RenderInput<'Pane'>, config: Config) {
  const { Box, Text, Button, Link, Markdown } = $.ui.resolve(e)
  const fields = e.surface === 'mobile' ? undefined : $.ui.resolve(e)
  const Svg = e.surface === 'terminal' ? undefined : $.ui.resolve(e).Svg
  const Raster = e.surface === 'terminal' ? $.ui.resolve(e).Raster : undefined
  const isTerminal = e.surface === 'terminal'
  const [shown, sync, installed, nav, held, notice, readmes, configs, picks, plan, now] = await Promise.all([
    read($, catalogState),
    read($, syncState),
    read($, installedState),
    read($, navState),
    read($, jobState),
    read($, noticeState),
    read($, readmesState),
    read($, configsState),
    read($, picksState),
    read($, planState),
    $.clock.now(),
  ])
  const catalog = shown !== null && isCatalogOf(shown, config.source) ? shown : null
  // A job this copy of the store is not running died with an older copy (a hot reload): neither drawn nor blocking.
  const job = active === null ? null : held
  const width = e.props.bodyColumns
  const isWide = width >= WIDE_COLUMNS
  const where = `${config.source.repository}@${config.source.branch}`
  const isIdle = job === null
  const run = (spec: JobSpec) => {
    const busy = launch($, config, spec)
    return busy === undefined ? undefined : update($, noticeState, () => busy)
  }
  const start = (action: Action | Bulk, name: string, names?: readonly string[]) => run({ action, name, ...(names === undefined ? {} : { names }) })
  /** Profile or Slim pressed: the plan screen, with the reading on its bar. */
  const startPlanPress = (kind: StorePlan['kind']) => {
    const busy = launch($, config, { action: kind, name: '', ...(kind === 'slim' ? { days: SLIM_DAYS } : {}) })
    if (busy !== undefined) return update($, noticeState, () => busy)
    return update($, planState, () => null).then(() => showPlan($))
  }

  const icon = (category: string, size = 16) =>
    Svg === undefined
      ? <Text color="claude">{glyphOf(category)}</Text>
      : <Svg source={iconSvg(category, size)} alt={category} width={size} height={size} />
  const pill = (text: string, color: string, isDim = false) =>
    text === '' ? null
    : isTerminal ? <Text color={color} dimColor={isDim}>{text}</Text>
    : (
      <Box borderStyle="round" borderColor={isDim ? 'subtle' : color} paddingX={1} flexShrink={0}>
        <Text color={color} dimColor={isDim}>{text}</Text>
      </Box>
    )

  // Header: the mark and name, then the counts; the source and its age on the line below.
  const counts = catalog === null ? undefined : countsOf(catalog, installed)
  const mark = Svg === undefined
    ? <Text><Text dimColor>▪▪</Text><Text color="claude">▪</Text></Text>
    : <Svg source={markSvg(18)} alt="Claude Mods" width={18} height={18} />
  const header = (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={2}>
        <Box flexDirection="row" columnGap={1}>
          {mark}
          <Text><Text bold>Claude </Text><Text bold italic color="claude">Mods</Text></Text>
        </Box>
        {counts === undefined ? null : (
          <Text wrap="truncate-end">
            <Text>{counts.mods} available</Text>
            <Text dimColor> · </Text>
            {installed?.isKnown === false
              ? <Text color="warning">install status unknown</Text>
              : (
                <Text>
                  <Text color={counts.installed > 0 ? 'success' : 'inactive'}>{counts.installed} installed</Text>
                  <Text dimColor> · </Text>
                  <Text color={counts.updates > 0 ? 'warning' : 'inactive'}>{plural(counts.updates, 'update')}</Text>
                </Text>
              )}
          </Text>
        )}
      </Box>
      {sync.phase === 'syncing'
        ? <Text color="suggestion" wrap="truncate-end">⟳ Syncing with {where}…</Text>
        : catalog === null ? null
        : sync.phase === 'offline'
          ? <Text color="warning" wrap="truncate-end">● Offline · catalog cached {formatAge(now - catalog.fetchedAt)} · {sync.message ?? ''}</Text>
          : <Text dimColor wrap="truncate-end">{where} · synced {formatAge(now - catalog.fetchedAt)}</Text>}
    </Box>
  )

  // Progress: one line that never changes height while the job moves, so nothing below it jumps.
  const barColumns = Math.max(8, Math.min(BAR_COLUMNS_MAX, Math.floor(width / 4)))
  const progress = job === null ? null : (() => {
    const isBulk = job.total > 1
    const fraction = job.total === 0 ? 0 : job.done / job.total
    const step = isBulk ? `${job.current === '' ? job.title : job.current} · ${Math.min(job.done + 1, job.total)}/${job.total}` : job.current === '' ? job.title : job.current
    const failed = job.failed > 0 ? ` · ${job.failed} failed` : ''
    return (
      <Box flexDirection="row" columnGap={1}>
        {!isBulk ? <Text color="claude">⟳</Text>
          : Raster !== undefined
            ? <Raster key="progress" columns={barColumns} rows={1} cells={barCells(fraction, barColumns)} />
            : Svg !== undefined ? <Svg source={barSvg(fraction, barColumns * 8)} alt={`${Math.round(fraction * 100)}%`} width={barColumns * 8} height={6} /> : null}
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">
            <Text color="claude">{job.verb}</Text> {step}{job.isStopping ? ' · stopping after this one' : ''}<Text color="error">{failed}</Text>
          </Text>
        </Box>
        {job.isStopping ? null : <Button key="stop" label="Stop" plain hotkey="s" onPress={() => stopJob($)} />}
      </Box>
    )
  })()

  const noticeLine = notice === null ? null : (
    <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
      <Text color={TONE_COLOR[notice.tone]} wrap="wrap">{TONE_GLYPH[notice.tone]} {clip(notice.text, NOTICE_CHARS)}</Text>
      {notice.retry !== undefined && isIdle
        ? <Button key="retry-failed" label={`Retry ${plural(notice.retry.names.length, 'failed mod')}`} plain hotkey="t" onPress={() => notice.retry === undefined ? undefined : start(notice.retry.action === 'install' ? 'install-all' : notice.retry.names.length === 1 ? 'update' : 'update-all', notice.retry.names[0] ?? '', notice.retry.names)} />
        : null}
      {notice.canReload
        ? <Button key="reload" label="Reload plugins" plain hotkey="l" variant="primary" onPress={() => reloadPlugins($)} />
        : null}
      {notice.canUndo === true && isIdle
        ? <Button key="undo" label="Undo" plain hotkey="z" onPress={() => run({ action: 'undo', name: '' })} />
        : null}
      {notice.canProfile === true && isIdle
        ? <Button key="profile-now" label="Profile this project" plain hotkey="f" onPress={() => startPlanPress('profile')} />
        : null}
      <Button key="dismiss" label="Dismiss" plain hotkey="d" onPress={() => update($, noticeState, () => null)} />
    </Box>
  )
  const installWarning = installed?.isKnown === false
    ? <Text color="warning" wrap="wrap">▲ Install status unavailable: {installed.error}</Text>
    : null
  const statusLines = (
    <Box flexDirection="column">
      {installWarning}
      {progress}
      {noticeLine}
    </Box>
  )
  const statusRows =
    (installed?.isKnown === false ? Math.ceil((installed.error.length + 30) / Math.max(20, width)) : 0) +
    (job === null ? 0 : 1) +
    (notice === null ? 0 : Math.ceil((Math.min(NOTICE_CHARS, notice.text.length) + 50) / Math.max(20, width)))

  if (catalog === null) {
    const body = sync.phase === 'error'
      ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="error">✗ Could not load the catalog</Text>
          <Text dimColor wrap="wrap">{sync.message ?? ''}</Text>
          <Text dimColor wrap="wrap">Check your connection or the repository setting, then try again.</Text>
          <Box marginTop={1}>
            <Button key="retry" label="Try again" plain hotkey="r" variant="primary" autoFocus onPress={() => refresh($, config, true)} />
          </Box>
        </Box>
      )
      : <Text color="suggestion">⟳ Loading the catalog from {where}…</Text>
    return (
      <Box flexDirection="column">
        {header}
        {body}
        {statusLines}
      </Box>
    )
  }

  const selected = nav.selected === null ? undefined : catalog.mods.find(mod => mod.name === nav.selected)
  if (selected !== undefined) {
    const mod = selected
    const status = statusOf(mod, installed)
    const category = categoryOf(catalog, mod.category)
    const line = installLine(mod.name, catalog.marketplace)
    const url = readmeUrl(catalog, mod)
    const readme = readmes[mod.name]
    const settings = configs[mod.name] ?? []
    const related = relatedOf(catalog, installed, mod, RELATED_LIMIT)
    const meta = [tierLabel(mod.tier), mod.author === undefined ? undefined : `by ${mod.author}`]
      .filter((part): part is string => part !== undefined)
      .join(' · ')
    const state =
      installed?.isKnown === false ? pill('install status unknown', 'warning')
      : status.kind === 'update' ? pill(`↑ ${status.install.version} → ${mod.version}`, 'warning')
      : status.kind === 'installed'
        ? pill(`✓ Installed${status.install.version === mod.version ? '' : ` ${status.install.version}`} · ${status.install.scope}${status.install.isEnabled ? '' : ' · disabled'}`, status.install.isEnabled ? 'success' : 'inactive')
        : isNewMod(catalog, mod) && mod.since !== undefined ? pill(`● New in ${releaseLabel(mod.since)}`, 'claude')
        : null
    const canUninstall = status.kind !== 'available' && status.install.scope !== 'managed'
    const primary = !isIdle || installed?.isKnown !== true ? null
      : status.kind === 'available'
        ? <Button key="install" label="Install" plain={isTerminal ? true : undefined} hotkey="i" variant="primary" autoFocus onPress={() => start('install', mod.name)} />
        : status.kind === 'update'
          ? <Button key="update" label={`Update to ${mod.version}`} plain={isTerminal ? true : undefined} hotkey="u" variant="primary" autoFocus onPress={() => start('update', mod.name)} />
          : null
    const keyColumns = Math.min(24, Math.max(8, ...settings.map(row => row.key.length + 2)))
    const defaultColumns = Math.min(18, Math.max(9, ...settings.map(row => row.default.length + 2)))

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1} flexWrap="wrap">
          <Button key="back" label="← Mods" hotkey="b" plain onPress={() => setNav($, current => ({ ...current, selected: null }))} />
          <Text dimColor>›</Text>
          <Button key="crumb-category" label={category.title} hotkey="g" plain dimColor onPress={() => setNav($, current => ({ ...current, selected: null, screen: 'list', query: '', category: category.id, page: 0 }))} />
          <Text dimColor>›</Text>
          <Text wrap="truncate-end">{mod.name}</Text>
        </Box>
        <Box flexDirection="row" justifyContent="space-between" columnGap={2} marginTop={1} flexWrap="wrap">
          <Box flexDirection="row" columnGap={1} alignItems="center" flexWrap="wrap">
            {icon(mod.category, 22)}
            <Text bold color="claude">{mod.name}</Text>
            {mod.version === '' ? null : <Text dimColor>v{mod.version}</Text>}
            {state}
          </Box>
          {primary}
        </Box>
        <Text wrap="wrap">{mod.description}</Text>
        {meta === '' ? null : <Text dimColor wrap="truncate-end">{meta}</Text>}
        {mod.commands === undefined || mod.commands.length === 0 ? null : (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {mod.commands.map(command => pill(command, 'claude'))}
          </Box>
        )}
        {statusLines}
        <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
          {isIdle && canUninstall
            ? <Button key="uninstall" label="Uninstall" plain hotkey="x" onPress={() => start('uninstall', mod.name)} />
            : null}
          <Button key="copy-install" label="Copy install line" plain hotkey="c" onPress={press => copy($, line, 'install line', press.surface)} />
          <Button key="copy-readme" label="Copy README link" plain hotkey="o" onPress={press => copy($, url, 'README link', press.surface)} />
          <Link href={url} label="README on GitHub ↗" />
        </Box>
        <Text dimColor wrap="truncate-end">In a terminal session: <Text color="suggestion">{line}</Text></Text>
        {settings.length === 0 ? null : (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Settings</Text>
            {settings.map(row => (
              <Box key={`config:${row.key}`} flexDirection="row">
                <Box width={keyColumns} flexShrink={0}><Text color="suggestion">{row.key}</Text></Box>
                <Box width={defaultColumns} flexShrink={0}><Text dimColor wrap="truncate-end">{row.default === '' ? '—' : row.default}</Text></Box>
                <Box flexGrow={1} flexShrink={1}><Text dimColor wrap="truncate-end">{row.description}</Text></Box>
              </Box>
            ))}
          </Box>
        )}
        <Box flexDirection="column" marginTop={1}>
          {readme?.phase === 'ready' && readme.text !== ''
            ? <Markdown text={readme.text} />
            : readme?.phase === 'missing'
              ? <Text dimColor>The README could not be loaded{sync.phase === 'offline' ? ' while offline' : ''}.</Text>
              : readme?.phase === 'loading' && readmesLoading.has(mod.name)
                ? <Text dimColor>Loading the README…</Text>
                : <Button key="readme" label="Show README" plain hotkey="m" onPress={() => loadDetail($, catalog, mod)} />}
        </Box>
        {related.length === 0 ? null : (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>More in {category.title}</Text>
            <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
              {related.map(other => (
                <Button key={`related:${other.name}`} label={other.name} plain onPress={() => openDetail($, config, other.name)} />
              ))}
            </Box>
          </Box>
        )}
      </Box>
    )
  }

  const bodyRowsAll = e.props.scroll.bodyRows > 0 ? e.props.scroll.bodyRows : DEFAULT_BODY_ROWS
  const backToList = () => setNav($, current => ({ ...current, selected: null, screen: 'list' }))
  const crumb = (title: string, detail: string) => (
    <Box flexDirection="row" columnGap={1} flexWrap="wrap">
      <Button key="back" label="← Mods" hotkey="b" plain onPress={backToList} />
      <Text dimColor>›</Text>
      <Text>{title}</Text>
      {detail === '' ? null : <Text dimColor wrap="truncate-end">· {detail}</Text>}
    </Box>
  )

  // The plan screen: a profile or a slim under review, two tabs (what goes off, what stays), a toggle per mod, Apply.
  if (nav.screen === 'plan') {
    if (plan === null) {
      return (
        <Box flexDirection="column">
          {header}
          {crumb('Plan', '')}
          <Box flexDirection="column" marginTop={1}>
            {active === null
              ? <Text dimColor wrap="wrap">No plan yet. Profile reads this project and keeps the mods it needs; Slim finds mods you have not used lately.</Text>
              : <Text color="suggestion" wrap="wrap">Reading… the lists appear here when it is done. Nothing changes until you press Apply.</Text>}
          </Box>
          {statusLines}
          <Box flexDirection="row" columnGap={2} marginTop={1}>
            {isIdle ? <Button key="plan-profile" label="Profile this project" plain hotkey="f" variant="primary" autoFocus onPress={() => startPlanPress('profile')} /> : null}
            {isIdle ? <Button key="plan-slim" label={`Slim (idle ${SLIM_DAYS} d)`} plain hotkey="w" onPress={() => startPlanPress('slim')} /> : null}
          </Box>
        </Box>
      )
    }
    const tab = nav.planTab ?? 'disable'
    const tabRows = plan.rows.filter(row => (tab === 'disable' ? !row.proposed : row.proposed))
    const changes = changesOf(plan.rows)
    const turningOff = changes.filter(row => !row.keep).length
    const turningOn = changes.length - turningOff
    const keptCount = plan.rows.filter(row => row.keep).length
    const room = Math.max(MIN_PAGE_ROWS, bodyRowsAll - PLAN_CHROME_ROWS - statusRows)
    const planPages = Math.max(1, Math.ceil(tabRows.length / room))
    const planPage = Math.min(Math.max(0, nav.planPage ?? 0), planPages - 1)
    const shown = tabRows.slice(planPage * room, (planPage + 1) * room)
    const nameWidth = Math.min(NAME_COLUMNS_MAX, Math.max(NAME_COLUMNS_MIN, ...shown.map(row => row.name.length + 3)))
    const flip = (name: string) => update($, planState, current => current === null ? null : {
      ...current,
      rows: current.rows.map(row => (row.name === name ? { ...row, keep: !row.keep } : row)),
    })
    const setAll = (keep: boolean) => update($, planState, current => current === null ? null : {
      ...current,
      rows: current.rows.map(row => ((tab === 'disable' ? !row.proposed : row.proposed) ? { ...row, keep } : row)),
    })
    const headline = plan.kind === 'profile'
      ? `${basename(plan.root)} needs ${keptCount} of ${plural(plan.rows.length, 'mod')}`
      : `${plural(plan.rows.length - keptCount, 'mod')} idle for ${plan.days ?? SLIM_DAYS} days, of ${plan.rows.length} enabled`
    const evidence = plan.kind === 'profile'
      ? `From its files, dependencies and what you ran here. Apply writes ${SETTINGS_LOCAL} (this project only, kept out of git).`
      : `From ${plural(plan.scanned ?? 0, 'transcript')} covering ${plural(plan.historyDays ?? 0, 'day')}${(plan.skipped ?? 0) > 0 ? ` (${plan.skipped} skipped)` : ''}, and the hub's feed. Apply disables them everywhere with claude plugin disable.`
    const applyLabel = [turningOff > 0 ? `disable ${turningOff}` : '', turningOn > 0 ? `enable ${turningOn}` : ''].filter(part => part !== '').join(', ')
    const tabButton = (id: 'disable' | 'keep', label: string, hotkey: string) => (
      <Button key={`tab:${id}`} label={label} plain hotkey={hotkey} dimColor={tab !== id} onPress={() => setNav($, current => ({ ...current, planTab: id, planPage: 0 }))} />
    )

    return (
      <Box flexDirection="column">
        {header}
        {crumb(PLAN_TITLE[plan.kind], plan.kind === 'profile' ? basename(plan.root) : `unused for ${plan.days ?? SLIM_DAYS} days`)}
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="claude" wrap="wrap">{headline}</Text>
          <Text dimColor wrap="wrap">{evidence}</Text>
        </Box>
        {statusLines}
        <Box flexDirection="row" columnGap={2} marginTop={1} flexWrap="wrap">
          {tabButton('disable', `${plan.kind === 'profile' ? 'Not needed' : 'Idle'} (${plan.rows.filter(row => !row.proposed).length})`, 'x')}
          {tabButton('keep', `Keep (${plan.rows.filter(row => row.proposed).length})`, 'k')}
          <Text dimColor>☑ stays on · ☐ goes off</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {shown.length === 0
            ? <Text dimColor>{tab === 'disable' ? 'Nothing to turn off: every installed mod has a reason to stay.' : 'Nothing is kept.'}</Text>
            : shown.map(row => (
              <Box key={`plan-row:${row.name}`} flexDirection="row" columnGap={1}>
                <Box width={nameWidth} flexShrink={0}>
                  <Button key={`plan:${row.name}`} label={`${row.keep ? '☑' : '☐'} ${row.name}`} plain dimColor={!row.keep} onPress={() => flip(row.name)} />
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text wrap="truncate-end">
                    {row.isProtected ? <Text color="suggestion">◆ </Text> : null}
                    <Text dimColor>{row.reason}</Text>
                    {row.keep !== row.isEnabled ? <Text color={row.keep ? 'success' : 'warning'}>{row.keep ? ' · turns on' : ' · turns off'}</Text> : null}
                  </Text>
                </Box>
              </Box>
            ))}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
          {planPage > 0 ? <Button key="plan-prev" label="‹ Prev" plain hotkey="p" onPress={() => setNav($, current => ({ ...current, planPage: planPage - 1 }))} /> : null}
          {planPages > 1 ? <Text dimColor>Page {planPage + 1}/{planPages}</Text> : null}
          {planPage < planPages - 1 ? <Button key="plan-next" label="Next ›" plain hotkey="n" onPress={() => setNav($, current => ({ ...current, planPage: planPage + 1 }))} /> : null}
          {isIdle && changes.length > 0
            ? <Button key="apply" label={`Apply (${applyLabel})`} plain={isTerminal ? true : undefined} hotkey="a" variant="primary" onPress={() => run({ action: 'apply', name: '', title: plan.kind === 'profile' ? `the ${basename(plan.root)} profile` : 'the slim' })} />
            : null}
          {tabRows.length > 0 ? <Button key="plan-all-on" label="All on" plain hotkey="o" onPress={() => setAll(true)} /> : null}
          {tabRows.length > 0 && tab === 'disable' ? <Button key="plan-all-off" label="All off" plain hotkey="v" onPress={() => setAll(false)} /> : null}
          {isIdle ? <Button key="plan-reread" label="Read again" plain hotkey="r" onPress={() => startPlanPress(plan.kind)} /> : null}
        </Box>
        <Text dimColor wrap="wrap">◆ kept unless you untick it (always-on, core, safety) · Undo after Apply · /mods profile reset turns every mod back on here</Text>
      </Box>
    )
  }

  // A pack: its mods with their status, and the pack's two actions.
  const openPack = nav.screen === 'pack' && nav.selected === null ? catalog.packs?.find(one => one.id === nav.pack) : undefined
  if (openPack !== undefined) {
    const members = openPack.mods.map(name => catalog.mods.find(mod => mod.name === name)).filter((mod): mod is StoreMod => mod !== undefined)
    const known = installed?.isKnown === true ? installed : undefined
    const missing = known === undefined ? [] : members.filter(mod => known.mods[mod.name] === undefined).map(mod => mod.name)
    const off = known === undefined ? [] : members.filter(mod => known.mods[mod.name]?.isEnabled === false)
    const nameWidth = Math.min(NAME_COLUMNS_MAX, Math.max(NAME_COLUMNS_MIN, ...members.map(mod => mod.name.length + 2)))
    return (
      <Box flexDirection="column">
        {header}
        {crumb('Packs', openPack.title)}
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="claude">{openPack.title}</Text>
          <Text dimColor wrap="wrap">{openPack.tagline}</Text>
          {known === undefined ? null : (
            <Text wrap="truncate-end">
              <Text color={missing.length === 0 ? 'success' : 'inactive'}>{members.length - missing.length}/{members.length} installed</Text>
              {off.length > 0 ? <Text color="warning"> · {off.length} off here</Text> : null}
            </Text>
          )}
        </Box>
        {statusLines}
        <Box flexDirection="column" marginTop={1}>
          {members.slice(0, Math.max(MIN_PAGE_ROWS, bodyRowsAll - PLAN_CHROME_ROWS - statusRows)).map(mod => {
            const badge = badgeOf(catalog, mod, statusOf(mod, installed))
            return (
              <Box key={`pack-row:${mod.name}`} flexDirection="row" columnGap={1}>
                <Box width={nameWidth} flexShrink={0} flexDirection="row" columnGap={1}>
                  {icon(mod.category, 14)}
                  <Button key={`member:${mod.name}`} label={mod.name} plain onPress={() => openDetail($, config, mod.name)} />
                </Box>
                <Box width={BADGE_COLUMNS} flexShrink={0}><Text color={badge.color} dimColor={badge.isDim}>{badge.text}</Text></Box>
                {isWide ? <Box flexGrow={1} flexShrink={1}><Text dimColor wrap="truncate-end">{mod.description}</Text></Box> : null}
              </Box>
            )
          })}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
          {isIdle && missing.length > 0
            ? <Button key="pack-install" label={`Install ${missing.length} missing`} plain={isTerminal ? true : undefined} hotkey="i" variant="primary" autoFocus onPress={() => run({ action: 'install-all', name: '', names: missing, title: `the ${openPack.title} pack` })} />
            : null}
          {isIdle && off.length > 0
            ? <Button key="pack-enable" label={`Enable ${off.length} here`} plain hotkey="e" onPress={() => run({ action: 'enable-pack', name: openPack.id, title: `the ${openPack.title} pack` })} />
            : null}
          <Button key="close" label="Close" plain hotkey="q" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  }

  // Home: pickers, the featured shelf, the list and the action bar.
  const status: StatusFilter = isStatus(nav.status) && (nav.status !== STATUS_NEW || catalog.newest !== undefined) ? nav.status : FILTER_ALL
  const cats = categoryOptions(catalog, installed, status)
  const category = cats.some(option => option.value === nav.category) ? nav.category : FILTER_ALL
  const mods = matchMods(catalog, installed, nav.query, category, status)
  const isHome = nav.query.trim() === '' && category === FILTER_ALL && status === FILTER_ALL
  // Install all follows the search and the pickers: it installs what the list shows.
  const installable = installed?.isKnown === true
    ? mods.filter(mod => statusOf(mod, installed).kind === 'available').map(mod => mod.name)
    : []
  const updatable = installed?.isKnown === true ? updatesOf(catalog, installed).length : 0
  const shelf = (names: readonly string[]) => names.map(name => catalog.mods.find(mod => mod.name === name)).filter((mod): mod is StoreMod => mod !== undefined)
  const featured = isHome && nav.page === 0 && catalog.newest !== undefined ? shelf(FEATURED) : []
  const recommended = nav.page === 0 && nav.query.trim() === ''
    ? shelf(picks).filter(mod => statusOf(mod, installed).kind === 'available').slice(0, PICKS_LIMIT)
    : []
  const packs = isHome && nav.page === 0 ? catalog.packs ?? [] : []
  const packStrip = packs.length === 0 ? null : (
    <Box flexDirection="column" marginTop={1}>
      <Text><Text color="claude">▪</Text><Text dimColor> PACKS · START HERE INSTEAD OF INSTALLING EVERYTHING</Text></Text>
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {packs.map(pack => {
          const have = installed?.isKnown === true ? pack.mods.filter(name => installed.mods[name] !== undefined).length : 0
          return (
            <Button
              key={`pack:${pack.id}`}
              label={`${pack.title} ${have === pack.mods.length ? '✓' : `${have}/${pack.mods.length}`}`}
              plain
              onPress={() => setNav($, current => ({ ...current, selected: null, screen: 'pack', pack: pack.id }))}
            />
          )
        })}
      </Box>
    </Box>
  )
  const strip = (kicker: string, list: readonly StoreMod[], prefix: string) => list.length === 0 ? null : (
    <Box flexDirection="column" marginTop={1}>
      <Text><Text color="claude">▪</Text><Text dimColor> {kicker}</Text></Text>
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {list.map(mod => (
          <Box key={`${prefix}-box:${mod.name}`} flexDirection="row" columnGap={1}>
            {icon(mod.category, 14)}
            <Button key={`${prefix}:${mod.name}`} label={mod.name} plain onPress={() => openDetail($, config, mod.name)} />
          </Box>
        ))}
      </Box>
    </Box>
  )

  const filterRows = fields === undefined ? 1 : isWide ? 1 : 3
  const isInstallAllHeavy = isIdle && installable.length >= INSTALL_ALL_WARNING
  const stripRows = (featured.length > 0 ? 3 : 0) + (recommended.length > 0 ? 3 : 0) + (packs.length > 0 ? 3 : 0) + (isInstallAllHeavy ? 2 : 0)
  const chromeRows = 2 + filterRows + statusRows + stripRows + 1 + (isWide ? 2 : 3)
  const pages = paginate(rowsOf(mods, catalog, nav.query.trim() === ''), Math.max(MIN_PAGE_ROWS, bodyRowsAll - chromeRows))
  const last = Math.max(0, pages.length - 1)
  const pageIndex = Math.min(Math.max(0, nav.page), last)
  const page = pages[pageIndex] ?? []
  const pageMods = page.flatMap(row => (row.kind === 'mod' ? [row.mod] : []))
  const nameColumns = Math.min(NAME_COLUMNS_MAX, Math.max(NAME_COLUMNS_MIN, ...pageMods.map(mod => mod.name.length + HOTKEY_COLUMNS + 1)))
  const badgeColumns = BADGE_COLUMNS + Math.max(0, ...pageMods.map(mod => (statusOf(mod, installed).kind === 'update' ? mod.version.length + 3 : 0)))
  const turnPage = (delta: number) =>
    setNav($, current => ({ ...current, page: Math.min(last, Math.max(0, Math.min(current.page, last) + delta)) }))

  const pickers = fields === undefined
    ? (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {STATUSES.filter(one => one !== STATUS_NEW || catalog.newest !== undefined).map(one => (
          <Button key={`status:${one}`} label={one === STATUS_NEW && catalog.newest !== undefined ? `New in ${releaseLabel(catalog.newest)}` : STATUS_LABEL[one]} plain dimColor={one !== status} onPress={() => setNav($, current => ({ ...current, status: one, page: 0 }))} />
        ))}
      </Box>
    )
    : (() => {
      const { Input, Select } = fields
      const search = (query: string) => setNav($, current => ({ ...current, query, page: 0 }))
      return (
        <Box flexDirection={isWide ? 'row' : 'column'} columnGap={2}>
          <Box flexGrow={1}>
            <Input key="search" label="Search" placeholder="name, keyword or description" value={nav.query} submitLabel="search" onInput={search} onSubmit={search} />
          </Box>
          <Select key="category" label="Category" options={cats} value={category} onSelect={value => setNav($, current => ({ ...current, category: value, page: 0 }))} />
          <Select key="status" label="Show" options={statusOptions(catalog, installed, category)} value={status} onSelect={value => setNav($, current => ({ ...current, status: value, page: 0 }))} />
        </Box>
      )
    })()

  const drawRow = (row: Row) => {
    if (row.kind === 'heading') {
      const tail = row.isContinued
        ? '(continued)'
        : row.category.tagline === '' ? `${row.count}` : `${row.count} · ${row.category.tagline}`
      return (
        <Box key={`heading:${row.category.id}`} flexDirection="row" columnGap={1}>
          {/* The title keeps its one line (the page counts one per heading); the tagline is cut instead. */}
          <Box flexShrink={0} flexDirection="row" columnGap={1}>{icon(row.category.id, 14)}<Text bold>{row.category.title}</Text></Box>
          <Text dimColor wrap="truncate-end">{tail}</Text>
        </Box>
      )
    }
    const mod = row.mod
    const index = pageMods.indexOf(mod)
    const hotkey = ROW_HOTKEYS[index]
    const modStatus = statusOf(mod, installed)
    const badge = badgeOf(catalog, mod, modStatus)
    const action = !isIdle || installed?.isKnown !== true ? null
      : modStatus.kind === 'available'
        ? <Button key={`act:${mod.name}`} label="Install" plain={isTerminal ? true : undefined} variant="secondary" onPress={() => start('install', mod.name)} />
        : modStatus.kind === 'update'
          ? <Button key={`act:${mod.name}`} label="Update" plain={isTerminal ? true : undefined} variant="primary" onPress={() => start('update', mod.name)} />
          : null
    return (
      <Box key={`row:${mod.name}`} flexDirection="row" columnGap={isTerminal ? 0 : 1} alignItems="center">
        <Box width={nameColumns} flexShrink={0} paddingLeft={hotkey === undefined ? HOTKEY_COLUMNS : 0}>
          <Button
            key={`open:${mod.name}`}
            label={mod.name}
            plain
            {...(hotkey === undefined ? {} : { hotkey })}
            {...(index === 0 ? { autoFocus: true as const } : {})}
            onPress={() => openDetail($, config, mod.name)}
          />
        </Box>
        <Box width={badgeColumns} flexShrink={0}>{isTerminal ? <Text color={badge.color} dimColor={badge.isDim}>{badge.text}</Text> : pill(badge.text, badge.color, badge.isDim)}</Box>
        {isWide || !isTerminal
          ? <Box flexGrow={1} flexShrink={1}><Text dimColor wrap="truncate-end">{mod.description}</Text></Box>
          : <Box flexGrow={1} />}
        <Box width={ACTION_COLUMNS} flexShrink={0} justifyContent="flex-end">{action}</Box>
      </Box>
    )
  }

  const list = mods.length === 0
    ? (
      <Box flexDirection="column" marginTop={1}>
        <Text>Nothing matches {nav.query.trim() === '' ? 'these filters' : `“${nav.query.trim()}”`}.</Text>
        <Box marginTop={1}>
          <Button key="clear" label="Show every mod" plain hotkey="a" autoFocus onPress={() => setNav($, current => ({ ...HOME, page: 0, selected: current.selected }))} />
        </Box>
      </Box>
    )
    : <Box flexDirection="column" marginTop={1}>{page.map(drawRow)}</Box>

  return (
    <Box flexDirection="column">
      {header}
      {pickers}
      {statusLines}
      {strip(`NEW IN ${releaseLabel(catalog.newest ?? '').toUpperCase()} · PICKS`, featured, 'feat')}
      {strip('RECOMMENDED FOR THIS PROJECT', recommended, 'pick')}
      {packStrip}
      {list}
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
        {pageIndex > 0 ? <Button key="prev" label="‹ Prev" plain hotkey="p" onPress={() => turnPage(-1)} /> : null}
        {pages.length > 1 ? <Text dimColor>Page {pageIndex + 1}/{pages.length}</Text> : null}
        {pageIndex < last ? <Button key="next" label="Next ›" plain hotkey="n" onPress={() => turnPage(1)} /> : null}
        {updatable > 0 && isIdle
          ? <Button key="update-all" label={`Update all (${updatable})`} plain hotkey="u" variant="primary" onPress={() => start('update-all', '')} />
          : null}
        {isIdle ? <Button key="profile" label="Profile" plain hotkey="f" onPress={() => startPlanPress('profile')} /> : null}
        {isIdle ? <Button key="slim" label="Slim" plain hotkey="w" onPress={() => startPlanPress('slim')} /> : null}
        {installable.length > 0 && isIdle
          ? <Button key="install-all" label={`Install all (${installable.length})`} plain dimColor onPress={() => start('install-all', '', installable)} />
          : null}
        <Button key="refresh" label={sync.phase === 'offline' ? 'Retry' : 'Refresh'} plain hotkey="r" onPress={() => refresh($, config, true).then(() => refreshPicks($))} />
        <Button key="close" label="Close" plain hotkey="q" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
      </Box>
      {isInstallAllHeavy
        ? <Text color="warning" wrap="wrap">▲ Every enabled mod adds start-up work to each response (219 enabled: about 15 s; 33: about 5 s). Prefer a pack, and after installing run Profile to keep only what a project needs.</Text>
        : null}
    </Box>
  )
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
