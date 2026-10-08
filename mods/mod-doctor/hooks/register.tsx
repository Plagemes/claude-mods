import { atom, read, update } from 'claude-code'
import type { CommandRunResult, EngineInterface, ProcessRunResult, Register } from 'claude-code'

import type { DoctorCatalog, DoctorFinding, DoctorFix, DoctorNotice, DoctorReport, DoctorSeverity } from '../types'
import { argv, claudeBinary, parseOutcome } from './cli'
import { DEFAULT_MARKETPLACE, debugHints, diagnose, parseInstalled, parseMarketplace, parseMarketplaceFolders, parseProfile } from './diagnose'
import type { Installed, Profile, Unchecked } from './diagnose'

type Dollar = EngineInterface
/** The doctor's settings, read from userConfig. */
type Config = { repository: string; branch: string; shouldReadDebugLog: boolean; shouldCheckAtStart: boolean }
/** The catalog's versions as fetched or cached, with where they came from. */
type Catalog = DoctorCatalog & { versions?: Record<string, string> }
/** What the check keeps of a GitHub fetch in $.store. */
type CachedCatalog = { repository: string; branch: string; fetchedAt: number; marketplace: string; versions: Record<string, string> }

const PANE = 'mod-doctor'
const PANE_TITLE = 'Mod Doctor'
const PANE_ROWS = 24
const COMMAND = 'mod-doctor'
const CACHE_KEY = 'catalog'
const ANNOUNCED_KEY = 'announced'
const DEFAULT_REPOSITORY = 'plagemes/claude-mods'
const DEFAULT_BRANCH = 'main'
const FRESH_MS = 10 * 60_000
const FETCH_TIMEOUT_MS = 15_000
const LIST_TIMEOUT_MS = 30_000
const VALIDATE_TIMEOUT_MS = 30_000
const CHANGE_TIMEOUT_MS = 180_000
const VALIDATE_WORKERS = 4
const MAX_DEBUG_LOG_BYTES = 4 * 1024 * 1024
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/
const BRANCH = /^[\w./-]+$/
const SEVERITY_COLOR: Record<DoctorSeverity, string> = { error: 'error', warning: 'warning', info: 'suggestion', ok: 'success' }
const SEVERITY_GLYPH: Record<DoctorSeverity, string> = { error: '✗', warning: '▲', info: '•', ok: '✓' }
const TONE_COLOR: Record<DoctorNotice['tone'], string> = { success: 'success', error: 'error', info: 'suggestion' }
const TONE_GLYPH: Record<DoctorNotice['tone'], string> = { success: '✓', error: '✗', info: '•' }
const VERBS: Record<DoctorFix['action'], [string, string]> = {
  update: ['Updating', 'Updated'],
  enable: ['Enabling', 'Enabled'],
  disable: ['Disabling', 'Disabled'],
}

const reportState = atom({ plugin: 'mod-doctor', key: 'report' } as const, null)
const checkingState = atom({ plugin: 'mod-doctor', key: 'isChecking' } as const, false)
const busyState = atom({ plugin: 'mod-doctor', key: 'busy' } as const, null)
const noticeState = atom({ plugin: 'mod-doctor', key: 'notice' } as const, null)

/** The check in flight, so overlapping ones share it; the fix in flight, one at a time. */
const running: { check: Promise<DoctorReport> | null; fix: string | null } = { check: null, fix: null }

/** An error's message, without the `<plugin>: $.<noun>.<event>: ` prefix a refused `$` call carries. */
const describe = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^[\w-]+: \$\.[\w.]+: /, '')
const plural = (count: number, word: string, many = `${word}s`): string => `${count} ${count === 1 ? word : many}`
const nameOf = (id: string): string => id.slice(0, id.lastIndexOf('@'))

function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} days ago`
}

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

async function claudeBin($: Dollar): Promise<string> {
  try {
    return claudeBinary(await $.env.get('CLAUDE_CODE_EXECPATH'))
  } catch {
    return claudeBinary(undefined)
  }
}

function runCli($: Dollar, args: readonly string[], timeoutMs: number): Promise<ProcessRunResult> {
  return $.process.run(args, { timeoutMs })
}

// ── Evidence ─────────────────────────────────────────────────────────────────

function isCachedCatalog(value: unknown, config: Config): value is CachedCatalog {
  if (typeof value !== 'object' || value === null) return false
  const cached = value as Record<string, unknown>
  return cached.repository === config.repository && cached.branch === config.branch && typeof cached.fetchedAt === 'number' &&
    typeof cached.marketplace === 'string' && typeof cached.versions === 'object' && cached.versions !== null
}

/** The claude-mods catalog's versions: GitHub when online (cached ten minutes), the last fetch when not. */
async function fetchCatalog($: Dollar, config: Config, now: number): Promise<Catalog> {
  if (!REPOSITORY.test(config.repository) || !BRANCH.test(config.branch)) {
    return { marketplace: DEFAULT_MARKETPLACE, source: 'none', message: `"${config.repository}@${config.branch}" is not a GitHub owner/repo and branch` }
  }
  let cached: unknown
  try {
    cached = await $.store.get(CACHE_KEY)
  } catch {
    cached = undefined
  }
  const known = isCachedCatalog(cached, config) ? cached : undefined
  if (known !== undefined && now - known.fetchedAt < FRESH_MS) {
    return { marketplace: known.marketplace, source: 'github', fetchedAt: known.fetchedAt, versions: known.versions }
  }
  const url = `https://raw.githubusercontent.com/${config.repository}/${config.branch}/.claude-plugin/marketplace.json`
  try {
    const response = await withTimeout($, $.http.fetch(url), FETCH_TIMEOUT_MS, `GitHub did not answer within ${FETCH_TIMEOUT_MS / 1000} s`)
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${config.repository}`)
    const parsed = parseMarketplace(response.text)
    const fresh: CachedCatalog = { repository: config.repository, branch: config.branch, fetchedAt: now, marketplace: parsed.name, versions: parsed.versions }
    await $.store.set(CACHE_KEY, fresh)
    return { marketplace: parsed.name, source: 'github', fetchedAt: now, versions: parsed.versions }
  } catch (error) {
    const message = describe(error)
    return known === undefined
      ? { marketplace: DEFAULT_MARKETPLACE, source: 'none', message }
      : { marketplace: known.marketplace, source: 'cache', fetchedAt: known.fetchedAt, message, versions: known.versions }
  }
}

/** Each marketplace's versions from its local copy (`<installLocation>/.claude-plugin/marketplace.json`). */
async function localCatalogs($: Dollar, bin: string, names: readonly string[]): Promise<Record<string, Record<string, string>>> {
  let folders: Record<string, string>
  try {
    const listed = await runCli($, argv.marketplaces(bin), LIST_TIMEOUT_MS)
    folders = listed.exitCode === 0 ? parseMarketplaceFolders(listed.stdout) : {}
  } catch {
    folders = {}
  }
  const catalogs: Record<string, Record<string, string>> = {}
  await Promise.all(
    names.map(async name => {
      const folder = folders[name]
      if (folder === undefined) return
      try {
        catalogs[name] = parseMarketplace(await $.fs.read(`${folder.replace(/[\\/]+$/, '')}/.claude-plugin/marketplace.json`)).versions
      } catch {
        // A marketplace with no readable local copy is compared against nothing.
      }
    }),
  )

  return catalogs
}

async function profileOf($: Dollar, bin: string, plugin: Installed): Promise<Profile | Unchecked> {
  if (plugin.folder === undefined) return { problem: 'The plugin list names no folder for it.' }
  try {
    const ran = await runCli($, argv.validate(bin, plugin.folder), VALIDATE_TIMEOUT_MS)
    return parseProfile(ran.stdout) ?? { problem: `claude plugin validate printed no report (exit code ${ran.exitCode}).` }
  } catch (error) {
    return { problem: `claude plugin validate did not run: ${describe(error)}` }
  }
}

/** Validates every installed plugin's folder, a few at a time. */
async function profilesOf($: Dollar, bin: string, installed: readonly Installed[]): Promise<Record<string, Profile | Unchecked>> {
  const profiles: Record<string, Profile | Unchecked> = {}
  const queue = [...installed]
  const worker = async (): Promise<void> => {
    for (let plugin = queue.shift(); plugin !== undefined; plugin = queue.shift()) {
      profiles[plugin.id] = await profileOf($, bin, plugin)
    }
  }
  await Promise.all(Array.from({ length: VALIDATE_WORKERS }, worker))

  return profiles
}

/** Problems this session's debug log names per plugin; empty unless the session runs with --debug. */
async function hintsOf($: Dollar, names: readonly string[]): Promise<Record<string, string[]>> {
  try {
    const configured = await $.env.get('CLAUDE_CONFIG_DIR')
    const home = await $.env.get('HOME')
    const configDir = configured !== undefined && configured !== '' ? configured : home === undefined ? undefined : `${home}/.claude`
    if (configDir === undefined) return {}
    const path = `${configDir.replace(/[\\/]+$/, '')}/debug/${await $.session.id()}.txt`
    if (!(await $.fs.exists(path)) || (await $.fs.stat(path)).size > MAX_DEBUG_LOG_BYTES) return {}
    return debugHints(await $.fs.read(path), names)
  } catch {
    return {}
  }
}

async function builtinCommands($: Dollar): Promise<string[]> {
  try {
    return (await $.command.list()).filter(command => command.source === 'builtin').map(command => command.name)
  } catch {
    return []
  }
}

async function check($: Dollar, config: Config): Promise<DoctorReport> {
  const bin = await claudeBin($)
  const now = await $.clock.now()
  const listed = await runCli($, argv.list(bin), LIST_TIMEOUT_MS)
  if (listed.exitCode !== 0) throw new Error(parseOutcome(listed).message)
  const installed = parseInstalled(listed.stdout)
  const marketplaces = [...new Set(installed.map(plugin => plugin.marketplace))]
  const [catalog, local, profiles, hints, builtins] = await Promise.all([
    fetchCatalog($, config, now),
    localCatalogs($, bin, marketplaces),
    profilesOf($, bin, installed),
    config.shouldReadDebugLog ? hintsOf($, installed.map(plugin => plugin.name)) : Promise.resolve({}),
    builtinCommands($),
  ])
  const { versions, ...shown } = catalog
  const usesLocal = versions === undefined && local[catalog.marketplace] !== undefined
  const catalogs = versions === undefined ? local : { ...local, [catalog.marketplace]: versions }

  return {
    checkedAt: now,
    plugins: installed.length,
    enabled: installed.filter(plugin => plugin.isEnabled).length,
    catalog: usesLocal ? { ...shown, source: 'local' } : shown,
    findings: diagnose({ installed, profiles, catalogs, marketplace: catalog.marketplace, builtins, hints }),
  }
}

/** Runs a check (or joins the one running), keeps it for the pane, and never rejects. */
async function runCheck($: Dollar, config: Config): Promise<DoctorReport> {
  if (running.check !== null) return running.check
  const work = (async (): Promise<DoctorReport> => {
    await update($, checkingState, () => true)
    let report: DoctorReport
    try {
      report = await check($, config)
    } catch (error) {
      report = {
        checkedAt: await $.clock.now(),
        plugins: 0,
        enabled: 0,
        catalog: { marketplace: DEFAULT_MARKETPLACE, source: 'none' },
        findings: [{ key: 'list', severity: 'error', title: 'Could not list your plugins', details: [describe(error)], fixes: [] }],
      }
    }
    await update($, reportState, () => report)
    await update($, checkingState, () => false)
    return report
  })()
  running.check = work
  try {
    return await work
  } finally {
    running.check = null
  }
}

// ── Fixes ────────────────────────────────────────────────────────────────────

async function applyFix($: Dollar, bin: string, fix: DoctorFix): Promise<{ isOk: boolean; text: string }> {
  const name = nameOf(fix.id)
  const [, done] = VERBS[fix.action]
  if (fix.action === 'update') {
    await runCli($, argv.refreshMarketplace(bin, fix.id.slice(fix.id.lastIndexOf('@') + 1)), CHANGE_TIMEOUT_MS).catch(() => undefined)
  }
  const outcome = parseOutcome(await runCli($, argv[fix.action](bin, fix.id, fix.scope), CHANGE_TIMEOUT_MS))
  if (!outcome.isOk) return { isOk: false, text: `${name}: ${outcome.message}` }
  if (fix.action === 'update' && outcome.updateOutcome === 'up_to_date') return { isOk: true, text: `${name} is already at the version its marketplace offers` }
  const versions = outcome.oldVersion !== undefined && outcome.newVersion !== undefined ? ` ${outcome.oldVersion} → ${outcome.newVersion}` : ''

  return { isOk: true, text: `${done} ${name}${versions}` }
}

/** Applies fixes one after another, then checks again; one batch at a time. */
async function perform($: Dollar, config: Config, fixes: readonly DoctorFix[], what: string): Promise<DoctorNotice> {
  if (running.fix !== null) return { tone: 'info', text: `${running.fix} is still running; try again when it is done.`, canReload: false }
  running.fix = what
  let notice: DoctorNotice
  try {
    await update($, busyState, () => what)
    await update($, noticeState, () => null)
    const bin = await claudeBin($)
    const done: string[] = []
    const failed: string[] = []
    for (const fix of fixes) {
      try {
        const outcome = await applyFix($, bin, fix)
        if (outcome.isOk) done.push(outcome.text)
        else failed.push(outcome.text)
      } catch (error) {
        failed.push(`${nameOf(fix.id)}: ${describe(error)}`)
      }
    }
    const text = [
      done.length > 0 ? `${done.join('; ')}.` : '',
      failed.length > 0 ? `Failed: ${failed.join('; ')}.` : '',
      done.length > 0 ? 'Run /reload-plugins to apply.' : '',
    ].filter(part => part !== '').join(' ')
    notice = { tone: failed.length > 0 ? 'error' : 'success', text, canReload: done.length > 0 }
  } catch (error) {
    notice = { tone: 'error', text: `${what} failed: ${describe(error)}`, canReload: false }
  } finally {
    running.fix = null
  }
  await update($, busyState, () => null)
  await update($, noticeState, () => notice)
  if (notice.canReload) $.ui.toast(`${TONE_GLYPH[notice.tone]} ${notice.text}`)
  await runCheck($, config)

  return notice
}

function fixOne($: Dollar, config: Config, fix: DoctorFix): Promise<DoctorNotice> {
  return perform($, config, [fix], `${VERBS[fix.action][0]} ${nameOf(fix.id)}…`)
}

function updatesIn(report: DoctorReport | null): DoctorFix[] {
  const fixes = (report?.findings ?? []).flatMap(finding => (finding.key.startsWith('outdated:') ? finding.fixes : []))
  return fixes.filter(fix => fix.action === 'update')
}

async function reloadPlugins($: Dollar): Promise<void> {
  await update($, noticeState, () => null)
  try {
    await $.command.run({ command: 'reload-plugins' })
  } catch {
    $.ui.toast('Run /reload-plugins to apply the change')
  }
}

// ── Reports ──────────────────────────────────────────────────────────────────

function counts(report: DoctorReport): Record<DoctorSeverity, number> {
  const tally: Record<DoctorSeverity, number> = { error: 0, warning: 0, info: 0, ok: 0 }
  for (const finding of report.findings) tally[finding.severity] += 1
  return tally
}

function summaryLine(report: DoctorReport): string {
  const tally = counts(report)
  const parts = [
    tally.error > 0 ? plural(tally.error, 'error') : '',
    tally.warning > 0 ? plural(tally.warning, 'warning') : '',
    tally.info > 0 ? plural(tally.info, 'note') : '',
  ].filter(part => part !== '')
  return parts.length === 0 ? 'all healthy' : parts.join(' · ')
}

function catalogLine(config: Config, catalog: DoctorCatalog, now: number): string {
  const where = `${config.repository}@${config.branch}`
  switch (catalog.source) {
    case 'github':
      return `Catalog ${where}, fetched ${ago(now - (catalog.fetchedAt ?? now))}`
    case 'cache':
      return `Offline (${catalog.message ?? 'no answer'}): catalog ${where} as cached ${ago(now - (catalog.fetchedAt ?? now))}`
    case 'local':
      return `Offline (${catalog.message ?? 'no answer'}): versions from your local copy of ${catalog.marketplace}`
    case 'none':
      return `Versions not checked: ${catalog.message ?? 'the catalog is unavailable'}`
  }
}

const fixCommand = (fix: DoctorFix): string => `claude plugin ${fix.action} ${fix.id} --scope ${fix.scope}`

function reportText(config: Config, report: DoctorReport, now: number): string {
  const lines = [`🩺 Mod Doctor: ${plural(report.plugins, 'plugin')} (${report.enabled} enabled) · ${summaryLine(report)}`]
  for (const finding of report.findings) {
    lines.push(`${SEVERITY_GLYPH[finding.severity]} ${finding.title}`)
    for (const detail of finding.details) lines.push(`    ${detail}`)
    for (const fix of finding.fixes) lines.push(`    Fix: ${fixCommand(fix)}`)
  }
  lines.push(catalogLine(config, report.catalog, now))

  return lines.join('\n')
}

async function openDoctor($: Dollar, config: Config, args: string): Promise<CommandRunResult> {
  const wantsText = /^(report|text)$/i.test(args.trim())
  const opened = wantsText ? { isPlaced: false as const } : await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true, closeOnEscape: true, rows: PANE_ROWS })
  if (!opened.isPlaced) {
    const report = await runCheck($, config)
    return { text: reportText(config, report, await $.clock.now()) }
  }
  $.clock.after(0, () => void runCheck($, config))

  return { text: '🩺 Checking your mods in the Mod Doctor pane.' }
}

/** At session start, when asked: a quiet check that toasts only new load errors and clashes. */
async function announceProblems($: Dollar, config: Config): Promise<void> {
  const report = await runCheck($, config)
  const serious = report.findings.filter(finding => finding.severity === 'error')
  const fingerprint = serious.map(finding => finding.key).sort().join(' ')
  if (serious.length === 0 || (await $.store.get(ANNOUNCED_KEY)) === fingerprint) return
  await $.store.set(ANNOUNCED_KEY, fingerprint)
  // An error notice through the hub (your phone channel while you are away); a toast without it.
  await hubNotify($, { level: 'error', title: `✗ ${serious[0]?.title ?? ''}${serious.length > 1 ? ` (+${serious.length - 1} more)` : ''} · /${COMMAND}` }, { timeoutMs: 8_000 })
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

/** With mods-hub installed: hello (this mod reads `mod.installed`, to say a check has gone stale). */
async function greetHub($: Dollar): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: ['mod.installed'] })
}

/** The mod the hub last saw installed or updated (`mod.installed`) after `checkedAt`: the report does not include it. Read while drawing, so the pane redraws when one lands. */
async function installedSince($: Dollar, checkedAt: number): Promise<string | undefined> {
  const { value: event } = await $.state.get({ plugin: 'mods-hub', key: 'latest', id: 'mod.installed' })
  const data: unknown = event?.data
  const { name, version } = typeof data === 'object' && data !== null ? (data as { name?: unknown; version?: unknown }) : {}
  return event != null && event.at > checkedAt && typeof name === 'string' ? `${name}${typeof version === 'string' ? ` ${version}` : ''}` : undefined
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  const config: Config = {
    repository: String(options.repository ?? DEFAULT_REPOSITORY).trim(),
    branch: String(options.branch ?? DEFAULT_BRANCH).trim(),
    shouldReadDebugLog: options.readDebugLog !== false,
    shouldCheckAtStart: options.checkAtStart === true,
  }

  on('session.start', async ($, e, next) => {
    await registerCommand($, {
      name: 'mod-doctor',
      description: 'Check your installed mods for outdated versions, conflicts and load errors',
      argumentHint: '[report]',
    })
    afterStart($, 'mod-doctor', () => greetHub($))
    if (e.isInteractive && config.shouldCheckAtStart) {
      $.clock.after(0, () => void announceProblems($, config).catch(error => $.ui.log(`start check failed: ${describe(error)}`, { to: 'debug' })))
    }

    return next(e)
  })

  on('command.run', { command: 'mod-doctor' }, async ($, e) => openDoctor($, config, e.args))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const [report, isChecking, busy, notice, now] = await Promise.all([
      read($, reportState),
      read($, checkingState),
      read($, busyState),
      read($, noticeState),
      $.clock.now(),
    ])
    const updates = updatesIn(report)
    const isIdle = busy === null
    const tally = report === null ? undefined : counts(report)

    const header = (
      <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={2}>
        <Text bold color="claude">🩺 Mod Doctor</Text>
        {report === null || tally === undefined ? null : (
          <Text>
            <Text>{plural(report.plugins, 'plugin')}</Text>
            <Text dimColor> · </Text>
            <Text color={tally.error > 0 ? 'error' : tally.warning > 0 ? 'warning' : 'success'}>{summaryLine(report)}</Text>
          </Text>
        )}
      </Box>
    )

    const toolbar = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Button key="recheck" label={isChecking ? 'Checking…' : 'Re-check'} plain hotkey="r" onPress={() => runCheck($, config)} />
        {updates.length > 0 && isIdle ? (
          <Button
            key="update-all"
            label={`Update all (${updates.length})`}
            plain
            hotkey="u"
            variant="primary"
            onPress={() => perform($, config, updates, `Updating ${plural(updates.length, 'mod')}…`)}
          />
        ) : null}
        <Button key="close" label="Close" plain hotkey="q" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
      </Box>
    )

    const status = (
      <Box flexDirection="column">
        {isChecking ? <Text color="suggestion">⟳ Checking your plugins: listing, validating each one, comparing versions…</Text> : null}
        {busy === null ? null : <Text color="suggestion">⟳ {busy}</Text>}
        {notice === null ? null : (
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            <Text color={TONE_COLOR[notice.tone]} wrap="wrap">{TONE_GLYPH[notice.tone]} {notice.text}</Text>
            {notice.canReload ? (
              <Button key="reload" label="Reload plugins" plain hotkey="l" variant="primary" onPress={() => reloadPlugins($)} />
            ) : null}
            <Button key="dismiss" label="Dismiss" plain hotkey="d" onPress={() => update($, noticeState, () => null)} />
          </Box>
        )}
      </Box>
    )

    if (report === null) {
      return (
        <Box flexDirection="column">
          {header}
          {toolbar}
          {isChecking ? status : <Text dimColor>No check yet. Press Re-check (r).</Text>}
        </Box>
      )
    }

    const drawFinding = (finding: DoctorFinding) => (
      <Box key={`finding:${finding.key}`} flexDirection="column" marginTop={1}>
        <Text wrap="wrap">
          <Text bold color={SEVERITY_COLOR[finding.severity]}>{SEVERITY_GLYPH[finding.severity]} </Text>
          <Text bold={finding.severity !== 'ok'}>{finding.title}</Text>
        </Text>
        {finding.details.map(detail => (
          <Box paddingLeft={2}>
            <Text dimColor wrap="wrap">{detail}</Text>
          </Box>
        ))}
        {finding.fixes.length > 0 && isIdle ? (
          <Box flexDirection="row" flexWrap="wrap" columnGap={2} paddingLeft={2}>
            {finding.fixes.map(fix => (
              <Button
                key={`fix:${finding.key}:${fix.action}:${fix.id}`}
                label={fix.label}
                variant={fix.action === 'update' ? 'primary' : 'secondary'}
                onPress={() => fixOne($, config, fix)}
              />
            ))}
          </Box>
        ) : null}
      </Box>
    )

    const fresh = await installedSince($, report.checkedAt)

    return (
      <Box flexDirection="column">
        {header}
        <Text dimColor wrap="truncate-end">Checked {ago(now - report.checkedAt)} · {catalogLine(config, report.catalog, now)}</Text>
        {fresh === undefined ? null : (
          <Box key="stale">
            <Text color="suggestion" wrap="wrap">↻ {fresh} was installed after this check: press Re-check (r) to include it.</Text>
          </Box>
        )}
        {toolbar}
        {status}
        {report.findings.map(drawFinding)}
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
