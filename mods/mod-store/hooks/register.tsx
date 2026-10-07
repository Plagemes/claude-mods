import { atom, read, update } from 'claude-code'
import type {
  CommandRunResult,
  EngineInterface,
  ProcessRunResult,
  Register,
  RenderSurface,
} from 'claude-code'

import type {
  StoreBusy,
  StoreCatalog,
  StoreInstalled,
  StoreMod,
  StoreNotice,
  StoreReadme,
  StoreSync,
} from '../types'
import {
  buildCatalog,
  CATALOG_PATH,
  categoryOf,
  countsOf,
  DEFAULT_BRANCH,
  DEFAULT_MARKETPLACE,
  DEFAULT_REPOSITORY,
  FILTER_ALL,
  filterOptions,
  formatAge,
  installLine,
  isBranch,
  isCatalogOf,
  isRepository,
  MARKETPLACE_PATH,
  matchMods,
  paginate,
  parseArgs,
  parseCatalogMeta,
  parseMarketplace,
  plural,
  rawUrl,
  readmeRawUrl,
  readmeUrl,
  rowsOf,
  statusOf,
  trimReadme,
  updatesOf,
} from './catalog'
import type { CatalogMeta, ModStatus, Row, Source } from './catalog'
import { argv, claudeBinary, parseInstalled, parseMarketplaceNames, parseOutcome } from './cli'

type Dollar = EngineInterface
type Action = 'install' | 'update' | 'uninstall'
/** The store's settings, read from userConfig: where the catalog lives, or why it cannot be read. */
type Config = { source: Source; problem: string | undefined }

const PANE = 'mod-store'
const PANE_TITLE = 'Mod Store'
const PANE_ROWS = 26
const ARGUMENT_HINT = '[search <words> | refresh | update-all | install|update|uninstall <mod>]'
const CACHE_KEY = 'catalog'
const ANNOUNCED_KEY = 'announced-updates'
const FRESH_MS = 10 * 60_000
const FETCH_TIMEOUT_MS = 15_000
const LIST_TIMEOUT_MS = 30_000
const CHANGE_TIMEOUT_MS = 180_000
const ANNOUNCE_TOAST_MS = 8_000
const ANNOUNCE_NAMES = 3
const LISTING_LIMIT = 25
const README_LIMIT = 20
const WIDE_COLUMNS = 64
const NAME_COLUMNS_MIN = 12
const NAME_COLUMNS_MAX = 34
const HOTKEY_COLUMNS = 3
const BADGE_COLUMNS = 13
const MIN_PAGE_ROWS = 4
const DEFAULT_BODY_ROWS = 20
const ROW_HOTKEYS = '123456789'
const VERBS: Record<Action, string> = { install: 'Installing', update: 'Updating', uninstall: 'Uninstalling' }
const TONE_COLOR: Record<StoreNotice['tone'], string> = { success: 'success', error: 'error', info: 'suggestion' }
const TONE_GLYPH: Record<StoreNotice['tone'], string> = { success: '✓', error: '✗', info: '•' }

const catalogState = atom({ plugin: 'mod-store', key: 'catalog' } as const, null)
const syncState = atom({ plugin: 'mod-store', key: 'sync' } as const, { phase: 'idle' })
const installedState = atom({ plugin: 'mod-store', key: 'installed' } as const, null)
const viewState = atom({ plugin: 'mod-store', key: 'view' } as const, {
  query: '',
  filter: FILTER_ALL,
  selected: null,
  page: 0,
})
const busyState = atom({ plugin: 'mod-store', key: 'busy' } as const, null)
const noticeState = atom({ plugin: 'mod-store', key: 'notice' } as const, null)
const readmesState = atom({ plugin: 'mod-store', key: 'readmes' } as const, {})

/** The `claude` executable, resolved once per load. */
let binary: string | undefined
/** The refresh in flight, so overlapping ones share it. */
let refreshing: Promise<void> | null = null
/** The action in flight: one at a time. */
let active: StoreBusy | null = null
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
  const [marketText, metaText] = await Promise.all([
    fetchText($, rawUrl(source, MARKETPLACE_PATH)),
    fetchText($, rawUrl(source, CATALOG_PATH)).catch(() => undefined),
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

async function claudeBin($: Dollar): Promise<string> {
  if (binary === undefined) {
    let execPath: string | undefined
    try {
      execPath = await $.env.get('CLAUDE_CODE_EXECPATH')
    } catch {
      execPath = undefined
    }
    binary = claudeBinary(execPath)
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

// ── Actions: install, update, uninstall ──────────────────────────────────────

async function ensureMarketplace($: Dollar, catalog: StoreCatalog, bin: string): Promise<string | undefined> {
  const listed = await runCli($, argv.marketplaces(bin), LIST_TIMEOUT_MS)
  let names: string[]
  try {
    names = listed.exitCode === 0 ? parseMarketplaceNames(listed.stdout) : []
  } catch {
    names = []
  }
  if (names.includes(catalog.marketplace)) {
    return undefined
  }
  const added = parseOutcome(await runCli($, argv.addMarketplace(bin, catalog.repository), CHANGE_TIMEOUT_MS))

  return added.isOk ? undefined : added.message
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
  let outcome = parseOutcome(await runCli($, argv.install(bin, name, catalog.marketplace), CHANGE_TIMEOUT_MS))
  if (!outcome.isOk && outcome.failureCode === 'not_found') {
    await runCli($, argv.refreshMarketplace(bin, catalog.marketplace), CHANGE_TIMEOUT_MS)
    outcome = parseOutcome(await runCli($, argv.install(bin, name, catalog.marketplace), CHANGE_TIMEOUT_MS))
  }
  await refreshInstalled($, catalog.marketplace)

  return outcome.isOk
    ? success(`Installed ${name}${mod.version === '' ? '' : ` ${mod.version}`}. Run /reload-plugins to activate it.`)
    : failure(`Could not install ${name}: ${outcome.message}`)
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
  await runCli($, argv.refreshMarketplace(bin, catalog.marketplace), CHANGE_TIMEOUT_MS)
  const updated: string[] = []
  const current: string[] = []
  const failed: string[] = []
  for (const name of targets) {
    const scope = installed.mods[name]?.scope ?? 'user'
    const outcome = parseOutcome(await runCli($, argv.update(bin, name, catalog.marketplace, scope), CHANGE_TIMEOUT_MS))
    if (!outcome.isOk) {
      failed.push(`${name} (${outcome.message})`)
    } else if (outcome.updateOutcome === 'up_to_date') {
      current.push(name)
    } else {
      const versions = outcome.oldVersion !== undefined && outcome.newVersion !== undefined
        ? ` ${outcome.oldVersion} → ${outcome.newVersion}`
        : ''
      updated.push(`${name}${versions}`)
    }
  }
  await refreshInstalled($, catalog.marketplace)
  const text = [
    updated.length > 0 ? `Updated ${updated.join(', ')}.` : '',
    current.length > 0 ? `${current.join(', ')}: already at the version the marketplace offers.` : '',
    failed.length > 0 ? `Failed: ${failed.join('; ')}.` : '',
    updated.length > 0 ? 'Run /reload-plugins to apply.' : '',
  ]
    .filter(part => part !== '')
    .join(' ')

  return updated.length > 0 ? success(text) : failed.length > 0 ? failure(text) : info(text)
}

async function uninstall($: Dollar, catalog: StoreCatalog, bin: string, name: string): Promise<StoreNotice> {
  const installed = await knownInstalled($, catalog)
  if (!installed.isKnown) {
    return failure(`Could not read the installed mods: ${installed.error}`)
  }
  const install = installed.mods[name]
  if (install === undefined) {
    return info(`${name} is not installed.`)
  }
  if (install.scope === 'managed') {
    return failure(`${name} is managed by your organization and cannot be uninstalled here.`)
  }
  const outcome = parseOutcome(await runCli($, argv.uninstall(bin, name, catalog.marketplace, install.scope), CHANGE_TIMEOUT_MS))
  await refreshInstalled($, catalog.marketplace)

  return outcome.isOk
    ? success(`Uninstalled ${name}. Run /reload-plugins to unload it.`)
    : failure(`Could not uninstall ${name}: ${outcome.message}`)
}

async function runAction($: Dollar, catalog: StoreCatalog, bin: string, action: Action, name: string): Promise<StoreNotice> {
  return action === 'install'
    ? install($, catalog, bin, name)
    : action === 'update'
      ? updateMods($, catalog, bin, [name])
      : uninstall($, catalog, bin, name)
}

async function runUpdateAll($: Dollar, catalog: StoreCatalog, bin: string): Promise<StoreNotice> {
  const names = updatesOf(catalog, await knownInstalled($, catalog)).map(mod => mod.name)
  return names.length === 0 ? info('Every installed mod is up to date.') : updateMods($, catalog, bin, names)
}

/**
 * Runs one action at a time (`name` a mod, or every mod with an update),
 * drawing it as busy and its outcome as the notice; a change toasts the
 * reminder to run /reload-plugins.
 */
async function perform($: Dollar, config: Config, action: Action | 'update-all', name: string): Promise<StoreNotice> {
  if (active !== null) {
    return info(`${active.verb} ${active.name} is still running; try again when it is done.`)
  }
  const busy: StoreBusy = action === 'update-all'
    ? { verb: VERBS.update, name: 'every mod with an update' }
    : { verb: VERBS[action], name }
  active = busy
  let notice: StoreNotice
  try {
    await update($, busyState, () => busy)
    await update($, noticeState, () => null)
    const catalog = (await currentCatalog($, config)) ?? (await syncCatalog($, config, true))
    const bin = await claudeBin($)
    notice = catalog === null
      ? failure('The catalog is not available: check your connection, then run /mods refresh.')
      : action === 'update-all'
        ? await runUpdateAll($, catalog, bin)
        : await runAction($, catalog, bin, action, name)
  } catch (error) {
    notice = failure(`${busy.verb} ${busy.name} failed: ${describe(error)}`)
  } finally {
    active = null
  }
  await update($, busyState, () => null)
  await update($, noticeState, () => notice)
  if (notice.canReload) {
    $.ui.toast(said(notice))
  }

  return notice
}

// ── Pane helpers ─────────────────────────────────────────────────────────────

async function setReadme($: Dollar, name: string, readme: StoreReadme): Promise<void> {
  await update($, readmesState, all =>
    Object.fromEntries([...Object.entries(all).filter(([key]) => key !== name), [name, readme]].slice(-README_LIMIT)),
  )
}

async function loadReadme($: Dollar, catalog: StoreCatalog, mod: StoreMod): Promise<void> {
  const known = (await read($, readmesState))[mod.name]
  if (known?.phase === 'ready' || readmesLoading.has(mod.name)) {
    return
  }
  readmesLoading.add(mod.name)
  try {
    await setReadme($, mod.name, { phase: 'loading', text: '' })
    let readme: StoreReadme
    try {
      readme = { phase: 'ready', text: trimReadme(await fetchText($, readmeRawUrl(catalog, mod)), mod) }
    } catch {
      readme = { phase: 'missing', text: '' }
    }
    await setReadme($, mod.name, readme)
  } finally {
    readmesLoading.delete(mod.name)
  }
}

async function openDetail($: Dollar, config: Config, name: string): Promise<void> {
  await update($, viewState, view => ({ ...view, selected: name }))
  const catalog = await currentCatalog($, config)
  const mod = catalog?.mods.find(one => one.name === name)
  if (catalog !== null && mod !== undefined) {
    await loadReadme($, catalog, mod)
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
  const unknown = installed?.isKnown === false ? ` Install status unavailable: ${installed.error}.` : ''

  return `◆ ${plural(counts.mods, 'mod')} in ${categories}, ${counts.installed} installed, ${plural(counts.updates, 'update')} available.${offline}${unknown}`
}

async function openStore($: Dollar, config: Config, query: string | undefined): Promise<CommandRunResult> {
  if (active === null) {
    await update($, busyState, () => null)
  }
  await update($, viewState, () => ({ query: query ?? '', filter: FILTER_ALL, selected: null, page: 0 }))
  await currentCatalog($, config)
  const opened = await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true, closeOnEscape: true, rows: PANE_ROWS })
  if (!opened.isPlaced) {
    await refresh($, config, false)
    return { text: await listingText($, config, query ?? '') }
  }
  void refresh($, config, false)

  return {
    text: query === undefined || query === ''
      ? '◆ Opened the mod store.'
      : `◆ Opened the mod store, searching for "${query}".`,
  }
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
      case 'update-all': {
        await refresh($, config, true)
        return { text: said(await perform($, config, 'update-all', '')) }
      }
      case 'install':
      case 'update':
      case 'uninstall':
        return { text: said(await perform($, config, command.kind, command.name)) }
      case 'usage':
        return { text: `✗ ${command.reason} Usage: /mods ${ARGUMENT_HINT}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link, Markdown } = $.ui.resolve(e)
    const fields = e.surface === 'mobile' ? undefined : $.ui.resolve(e)
    const [shown, sync, installed, view, busy, notice, readmes, now] = await Promise.all([
      read($, catalogState),
      read($, syncState),
      read($, installedState),
      read($, viewState),
      read($, busyState),
      read($, noticeState),
      read($, readmesState),
      $.clock.now(),
    ])
    const catalog = shown !== null && isCatalogOf(shown, config.source) ? shown : null
    const width = e.props.bodyColumns
    const isWide = width >= WIDE_COLUMNS
    const where = `${config.source.repository}@${config.source.branch}`
    const setView = (change: (current: typeof view) => typeof view) => update($, viewState, change)

    const header = (
      <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={2}>
        <Text bold color="claude">◆ Claude Mods</Text>
        {catalog === null ? null : (() => {
          const counts = countsOf(catalog, installed)
          return (
            <Text>
              <Text>{plural(counts.mods, 'mod')}</Text>
              <Text dimColor> · </Text>
              <Text color={counts.installed > 0 ? 'success' : 'inactive'}>{counts.installed} installed</Text>
              <Text dimColor> · </Text>
              <Text color={counts.updates > 0 ? 'warning' : 'inactive'}>{plural(counts.updates, 'update')}</Text>
            </Text>
          )
        })()}
      </Box>
    )

    const syncLine =
      sync.phase === 'syncing' ? <Text color="suggestion" wrap="truncate-end">⟳ Syncing with {where}…</Text>
      : catalog === null ? null
      : sync.phase === 'offline'
        ? <Text color="warning" wrap="truncate-end">● Offline · catalog cached {formatAge(now - catalog.fetchedAt)} · {sync.message ?? ''}</Text>
        : <Text dimColor wrap="truncate-end">{where} · synced {formatAge(now - catalog.fetchedAt)}</Text>

    const statusLines = (
      <Box flexDirection="column">
        {installed?.isKnown === false
          ? <Text color="warning" wrap="truncate-end">▲ Install status unavailable: {installed.error}</Text>
          : null}
        {busy === null ? null : <Text color="suggestion">⟳ {busy.verb} {busy.name}…</Text>}
        {notice === null ? null : (
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            <Text color={TONE_COLOR[notice.tone]} wrap="wrap">{TONE_GLYPH[notice.tone]} {notice.text}</Text>
            {notice.canReload
              ? <Button key="reload" label="Reload plugins" plain hotkey="l" variant="primary" onPress={() => reloadPlugins($)} />
              : null}
            <Button key="dismiss" label="Dismiss" plain hotkey="d" onPress={() => update($, noticeState, () => null)} />
          </Box>
        )}
      </Box>
    )
    const statusRows =
      (installed?.isKnown === false ? 1 : 0) +
      (busy === null ? 0 : 1) +
      (notice === null ? 0 : Math.ceil((notice.text.length + 30) / Math.max(20, width)))

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

    const badge = (mod: StoreMod, status: ModStatus) =>
      status.kind === 'update' ? <Text color="warning">↑ {mod.version}</Text>
      : status.kind === 'installed'
        ? <Text color={status.install.isEnabled ? 'success' : 'inactive'}>{status.install.isEnabled ? '✓ installed' : '✓ disabled'}</Text>
        : <Text dimColor>{mod.version === '' ? '' : `v${mod.version}`}</Text>

    const selected = view.selected === null ? undefined : catalog.mods.find(mod => mod.name === view.selected)
    if (selected !== undefined) {
      const mod = selected
      const status = statusOf(mod, installed)
      const category = categoryOf(catalog, mod.category)
      const line = installLine(mod.name, catalog.repository)
      const url = readmeUrl(catalog, mod)
      const readme = readmes[mod.name]
      const meta = [category.title, mod.tier, mod.author === undefined ? undefined : `by ${mod.author}`]
        .filter((part): part is string => part !== undefined)
        .join(' · ')
      const isIdle = busy === null
      const state =
        installed?.isKnown === false ? <Text color="warning">install status unknown</Text>
        : status.kind === 'update' ? <Text color="warning">↑ update {status.install.version} → {mod.version}</Text>
        : status.kind === 'installed'
          ? <Text color={status.install.isEnabled ? 'success' : 'inactive'}>✓ installed {status.install.version} ({status.install.scope}{status.install.isEnabled ? '' : ', disabled'})</Text>
          : <Text dimColor>not installed</Text>
      const canUninstall = status.kind !== 'available' && status.install.scope !== 'managed'

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
            <Button key="back" label="← All mods" hotkey="b" plain onPress={() => setView(current => ({ ...current, selected: null }))} />
            <Text dimColor wrap="truncate-end">{meta}</Text>
          </Box>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
            <Text bold color="claude">{mod.name}</Text>
            {mod.version === '' ? null : <Text dimColor>v{mod.version}</Text>}
            <Text dimColor>·</Text>
            {state}
          </Box>
          <Text wrap="wrap">{mod.description}</Text>
          {mod.keywords.length === 0 ? null : <Text dimColor wrap="truncate-end">{mod.keywords.map(word => `#${word}`).join(' ')}</Text>}
          {statusLines}
          <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
            {isIdle && status.kind === 'available'
              ? <Button key="install" label="Install" plain hotkey="i" variant="primary" autoFocus onPress={() => perform($, config, 'install', mod.name)} />
              : null}
            {isIdle && status.kind === 'update'
              ? <Button key="update" label={`Update to ${mod.version}`} plain hotkey="u" variant="primary" autoFocus onPress={() => perform($, config, 'update', mod.name)} />
              : null}
            {isIdle && canUninstall
              ? <Button key="uninstall" label="Uninstall" plain hotkey="x" onPress={() => perform($, config, 'uninstall', mod.name)} />
              : null}
            <Button key="copy-install" label="Copy install line" plain hotkey="c" onPress={press => copy($, line, 'install line', press.surface)} />
            <Button key="copy-readme" label="Copy README link" plain hotkey="o" onPress={press => copy($, url, 'README link', press.surface)} />
          </Box>
          <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} marginTop={1}>
            <Text dimColor>Install from a terminal session</Text>
            <Text color="suggestion" wrap="wrap">{line}</Text>
          </Box>
          <Link href={url} label="README on GitHub ↗" />
          <Box flexDirection="column" marginTop={1}>
            {readme?.phase === 'ready' && readme.text !== ''
              ? <Markdown text={readme.text} />
              : readme?.phase === 'missing'
                ? <Text dimColor>The README could not be loaded{sync.phase === 'offline' ? ' while offline' : ''}.</Text>
                : readme?.phase === 'loading' && readmesLoading.has(mod.name)
                  ? <Text dimColor>Loading the README…</Text>
                  : <Button key="readme" label="Show README" plain hotkey="m" onPress={() => loadReadme($, catalog, mod)} />}
          </Box>
        </Box>
      )
    }

    const options = filterOptions(catalog, installed)
    const filter = options.some(option => option.value === view.filter) ? view.filter : FILTER_ALL
    const mods = matchMods(catalog, installed, view.query, filter)
    const counts = countsOf(catalog, installed)
    const bodyRows = e.props.scroll.bodyRows > 0 ? e.props.scroll.bodyRows : DEFAULT_BODY_ROWS
    const chromeRows = 2 + (fields === undefined ? 0 : isWide ? 1 : 2) + statusRows + 2
    const pages = paginate(rowsOf(mods, catalog, view.query.trim() === ''), Math.max(MIN_PAGE_ROWS, bodyRows - chromeRows))
    const last = Math.max(0, pages.length - 1)
    const pageIndex = Math.min(Math.max(0, view.page), last)
    const page = pages[pageIndex] ?? []
    const pageMods = page.flatMap(row => (row.kind === 'mod' ? [row.mod] : []))
    const nameColumns = Math.min(NAME_COLUMNS_MAX, Math.max(NAME_COLUMNS_MIN, ...pageMods.map(mod => mod.name.length)) + HOTKEY_COLUMNS + 2)
    const turnPage = (delta: number) =>
      setView(current => ({ ...current, page: Math.min(last, Math.max(0, Math.min(current.page, last) + delta)) }))

    const filters = fields === undefined ? null : (() => {
      const { Input, Select } = fields
      const search = (query: string) => setView(current => ({ ...current, query, page: 0 }))
      return (
        <Box flexDirection={isWide ? 'row' : 'column'} columnGap={2}>
          <Box flexGrow={1}>
            <Input
              key="search"
              label="Search"
              placeholder="name, keyword or description"
              value={view.query}
              submitLabel="search"
              onInput={search}
              onSubmit={search}
            />
          </Box>
          <Select
            key="filter"
            label="Show"
            options={options}
            value={filter}
            onSelect={value => setView(current => ({ ...current, filter: value, page: 0 }))}
          />
        </Box>
      )
    })()

    const drawRow = (row: Row) => {
      if (row.kind === 'heading') {
        const tail = row.isContinued
          ? '(continued)'
          : row.category.tagline === '' ? `(${row.count})` : `(${row.count}) · ${row.category.tagline}`
        return (
          <Box flexDirection="row" columnGap={1}>
            <Text bold color="claude">{row.category.title}</Text>
            <Text dimColor wrap="truncate-end">{tail}</Text>
          </Box>
        )
      }
      const mod = row.mod
      const index = pageMods.indexOf(mod)
      const hotkey = ROW_HOTKEYS[index]
      return (
        <Box key={`row:${mod.name}`} flexDirection="row">
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
          <Box width={BADGE_COLUMNS} flexShrink={0}>{badge(mod, statusOf(mod, installed))}</Box>
          {isWide
            ? <Box flexGrow={1} flexShrink={1}><Text dimColor wrap="truncate-end">{mod.description}</Text></Box>
            : null}
        </Box>
      )
    }

    const list = mods.length === 0
      ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>No mods match {view.query.trim() === '' ? 'this filter' : `“${view.query.trim()}”`}.</Text>
          <Box marginTop={1}>
            <Button
              key="clear"
              label="Show every mod"
              plain
              hotkey="a"
              autoFocus
              onPress={() => setView(current => ({ ...current, query: '', filter: FILTER_ALL, page: 0 }))}
            />
          </Box>
        </Box>
      )
      : <Box flexDirection="column" marginTop={1}>{page.map(drawRow)}</Box>

    return (
      <Box flexDirection="column">
        {header}
        {syncLine}
        {filters}
        {statusLines}
        {list}
        <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
          {pageIndex > 0 ? <Button key="prev" label="Prev page" plain hotkey="p" onPress={() => turnPage(-1)} /> : null}
          {pages.length > 1 ? <Text dimColor>Page {pageIndex + 1}/{pages.length}</Text> : null}
          {pageIndex < last ? <Button key="next" label="Next page" plain hotkey="n" onPress={() => turnPage(1)} /> : null}
          {counts.updates > 0 && busy === null
            ? <Button key="update-all" label={`Update all (${counts.updates})`} plain hotkey="u" variant="primary" onPress={() => perform($, config, 'update-all', '')} />
            : null}
          <Button key="refresh" label="Refresh" plain hotkey="r" onPress={() => refresh($, config, true)} />
          <Button key="close" label="Close" plain hotkey="q" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}
