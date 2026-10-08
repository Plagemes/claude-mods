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
  parseMarketplaceNames,
  parseOutcome,
  versionOrder,
} from './cli'
import type { CliOutcome } from './cli'
import { barCells, barSvg, glyphOf, iconSvg, markSvg } from './icons'

type Dollar = EngineInterface
type Action = 'install' | 'update' | 'uninstall'
type Bulk = 'install-all' | 'update-all'
/** The store's settings, read from userConfig: where the catalog lives, or why it cannot be read. */
type Config = { source: Source; problem: string | undefined }

const PANE = 'mod-store'
const PANE_TITLE = 'Mod Store'
const PANE_ROWS = 26
const ARGUMENT_HINT = '[search <words> | refresh | install-all | update-all | stop | install|update|uninstall <mod>]'
const CACHE_KEY = 'catalog'
const ANNOUNCED_KEY = 'announced-updates'
const FRESH_MS = 10 * 60_000
const FETCH_TIMEOUT_MS = 15_000
const LIST_TIMEOUT_MS = 30_000
const CHANGE_TIMEOUT_MS = 180_000
const ANNOUNCE_TOAST_MS = 8_000
const ANNOUNCE_NAMES = 3
const NOTICE_NAMES = 3
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
const VERBS: Record<Action, string> = { install: 'Installing', update: 'Updating', uninstall: 'Uninstalling' }
const TONE_COLOR: Record<StoreNotice['tone'], string> = { success: 'success', error: 'error', info: 'suggestion' }
const TONE_GLYPH: Record<StoreNotice['tone'], string> = { success: '✓', error: '✗', info: '•' }
const STATUS_LABEL: Record<StatusFilter, string> = { all: 'All', installed: 'Installed', updates: 'Updates', new: 'New' }
const HOME: StoreView = { query: '', category: FILTER_ALL, status: FILTER_ALL, selected: null, page: 0 }

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
  ]
    .filter(part => part !== '')
    .join(' ')
  const retry = failed.names.length > 0 ? { retry: { action: 'install' as const, names: failed.names } } : {}

  return added.length > 0 ? { ...success(text), ...retry }
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
  for (const { name, outcome } of results.filter(result => result.outcome.isOk)) {
    if (outcome.updateOutcome === 'up_to_date') {
      current.push(name)
    } else {
      const versions = outcome.oldVersion !== undefined && outcome.newVersion !== undefined
        ? ` ${outcome.oldVersion} → ${outcome.newVersion}`
        : ''
      updated.push(`${name}${versions}`)
    }
  }
  const failed = failuresOf(results)
  const text = [
    updated.length > 0 ? `Updated ${listed(updated)}.` : '',
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
function jobOf(action: Action | Bulk, name: string, names: readonly string[] | undefined): StoreJob {
  const [verb, title] = action === 'update-all'
    ? [VERBS.update, 'every mod with an update']
    : action === 'install-all'
      ? [VERBS.install, names === undefined ? 'every mod not yet installed' : plural(names.length, 'mod')]
      : [VERBS[action], name]
  return { verb, title, current: '', done: 0, total: 0, failed: 0, isStopping: false }
}

/** Why a new job cannot start now, or undefined when none runs. */
const runningNotice = (): StoreNotice | undefined =>
  active === null ? undefined : info(`${active.verb} ${active.title} is still running. Wait for it, or stop it with s in the store or /mods stop.`)

/**
 * Runs one job (`name` a mod, every mod with an update, or every mod of `names` not yet installed), drawing its
 * progress as the bar and its outcome as the notice, with a toast at the end. The caller has claimed `job` as
 * `active`; this frees it.
 */
async function runJob($: Dollar, config: Config, job: StoreJob, action: Action | Bulk, name: string, names?: readonly string[]): Promise<StoreNotice> {
  let notice: StoreNotice
  try {
    await update($, jobState, () => job)
    await update($, noticeState, () => null)
    if (action === 'install-all' || action === 'update-all') {
      await refresh($, config, true)
    }
    const catalog = (await currentCatalog($, config)) ?? (await syncCatalog($, config, true))
    const bin = await claudeBin($)
    notice = catalog === null
      ? failure('The catalog is not available: check your connection, then run /mods refresh.')
      : action === 'update-all' ? await runUpdateAll($, catalog, bin)
      : action === 'install-all' ? await installMods($, catalog, bin, names)
      : action === 'install' ? await install($, catalog, bin, name)
      : action === 'update' ? await updateMods($, catalog, bin, [name])
      : await uninstall($, catalog, bin, name)
  } catch (error) {
    notice = failure(`${job.verb} ${job.title} failed: ${describe(error)}`)
  } finally {
    if (active === job) active = null
  }
  await update($, jobState, () => null)
  await update($, noticeState, () => notice)
  $.ui.toast(said(notice))

  return notice
}

/**
 * Starts a job in the background, outside the press or command that asked (a timer of its own), so that press
 * settles and the command answers at once; the bar and the notice say the rest. Undefined when it started.
 */
function launch($: Dollar, config: Config, action: Action | Bulk, name: string, names?: readonly string[]): StoreNotice | undefined {
  const busy = runningNotice()
  if (busy !== undefined) return busy
  const job = jobOf(action, name, names)
  active = job
  $.clock.after(0, () => {
    void runJob($, config, job, action, name, names)
  })

  return undefined
}

/** Asks the running job to stop after the mod it is on. */
async function stopJob($: Dollar): Promise<boolean> {
  if (active === null) return false
  const job = await setJob($, current => ({ ...current, isStopping: true }))
  return job !== null
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
  const busy = launch($, config, action, name)
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

// ── Hooks ────────────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  const config = configOf(String(options.repository ?? DEFAULT_REPOSITORY), String(options.branch ?? DEFAULT_BRANCH))
  const shouldAnnounce = options.checkForUpdates !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mods',
      description: 'Browse, search, install and update Claude Mods',
      argumentHint: ARGUMENT_HINT,
    })
    // Never awaited inside session.start: ~200 mods share one hooks worker (shared/hub-client.ts afterStart).
    afterStart($, 'mod-store', () => greetHub($))
    if (e.isInteractive && shouldAnnounce) {
      void announceUpdates($, config).catch(error =>
        $.ui.log(`update check failed: ${describe(error)}`, { to: 'debug' }),
      )
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
      case 'usage':
        return { text: `✗ ${command.reason} Usage: /mods ${ARGUMENT_HINT}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawStore($, e, config))
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
  const [shown, sync, installed, nav, held, notice, readmes, configs, picks, now] = await Promise.all([
    read($, catalogState),
    read($, syncState),
    read($, installedState),
    read($, navState),
    read($, jobState),
    read($, noticeState),
    read($, readmesState),
    read($, configsState),
    read($, picksState),
    $.clock.now(),
  ])
  const catalog = shown !== null && isCatalogOf(shown, config.source) ? shown : null
  // A job this copy of the store is not running died with an older copy (a hot reload): neither drawn nor blocking.
  const job = active === null ? null : held
  const width = e.props.bodyColumns
  const isWide = width >= WIDE_COLUMNS
  const where = `${config.source.repository}@${config.source.branch}`
  const isIdle = job === null
  const start = (action: Action | Bulk, name: string, names?: readonly string[]) => {
    const busy = launch($, config, action, name, names)
    return busy === undefined ? undefined : update($, noticeState, () => busy)
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
          <Button key="crumb-category" label={category.title} hotkey="g" plain dimColor onPress={() => setNav($, current => ({ ...current, selected: null, query: '', category: category.id, page: 0 }))} />
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

  const bodyRows = e.props.scroll.bodyRows > 0 ? e.props.scroll.bodyRows : DEFAULT_BODY_ROWS
  const filterRows = fields === undefined ? 1 : isWide ? 1 : 3
  const stripRows = (featured.length > 0 ? 3 : 0) + (recommended.length > 0 ? 3 : 0)
  const chromeRows = 2 + filterRows + statusRows + stripRows + 1 + (isWide ? 2 : 3)
  const pages = paginate(rowsOf(mods, catalog, nav.query.trim() === ''), Math.max(MIN_PAGE_ROWS, bodyRows - chromeRows))
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
      {list}
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
        {pageIndex > 0 ? <Button key="prev" label="‹ Prev" plain hotkey="p" onPress={() => turnPage(-1)} /> : null}
        {pages.length > 1 ? <Text dimColor>Page {pageIndex + 1}/{pages.length}</Text> : null}
        {pageIndex < last ? <Button key="next" label="Next ›" plain hotkey="n" onPress={() => turnPage(1)} /> : null}
        {installable.length > 0 && isIdle
          ? <Button key="install-all" label={`Install all (${installable.length})`} plain onPress={() => start('install-all', '', installable)} />
          : null}
        {updatable > 0 && isIdle
          ? <Button key="update-all" label={`Update all (${updatable})`} plain hotkey="u" variant="primary" onPress={() => start('update-all', '')} />
          : null}
        <Button key="refresh" label={sync.phase === 'offline' ? 'Retry' : 'Refresh'} plain hotkey="r" onPress={() => refresh($, config, true).then(() => refreshPicks($))} />
        <Button key="close" label="Close" plain hotkey="q" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
      </Box>
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
