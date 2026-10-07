import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput, Timer } from 'claude-code'

import type { TeamConfig, TeamLevel, TeamRoute, TeamView } from '../types'
import type { ModsPrefs } from '../types/mods-hub'
import { argv, claudeBinary, parseInstalled, parseMarketplaceNames, parseOutcome } from './cli'
import type { CliInstall } from './cli'
import { detectDrift, driftEvent, driftSignature, driftSummary, guardLevelOfPolicy, modStates } from './drift'
import type { Personal } from './drift'
import { summaryText } from './report'
import { readSettings } from './settings'
import { findSecrets, redactText } from './shared/secrets'
import type { SecretCategory } from './shared/secrets'
import type { Settings } from './settings'
import { BUDGET_KEYS, GUARD_LEVELS, LEVELS, TEAM_FILE, applyOp, conventionLines, conventionsSection, isMaintainer, parseTeam, serializeTeam, starterTeam } from './team'
import type { BudgetKey, Op } from './team'

const NAME = 'team-hub'
const TAB = 'team'
const PANE = 'team-hub'
const TAB_ORDER = 220
const VERSION = '1.0.0'
const CHECK_MS = 60_000
const GIT_TIMEOUT_MS = 5_000
const LIST_TIMEOUT_MS = 30_000
const CHANGE_TIMEOUT_MS = 180_000
const SHOWN_LINES = 12
const SECRET_ONLY: ReadonlySet<SecretCategory> = new Set<SecretCategory>(['secrets'])

const hasSecret = (text: string): boolean => findSecrets(text, { enabled: SECRET_ONLY }).length > 0
const USAGE = [
  'Usage: /team [show | check | install [mods | all] | align | init | reload]',
  '       /team add-mod <mod…> | remove-mod <mod…> | convention <text> | guard off|standard|strict',
  '       /team budget sessionUsd|sessionTokens|dailyUsd <number|none> | route <level> <route|none> | owner add|remove <who>',
].join('\n')

const EMPTY_VIEW: TeamView = {
  phase: 'loading',
  path: TEAM_FILE,
  problems: [],
  team: null,
  mods: [],
  isInstalledKnown: false,
  drift: [],
  isMaintainer: false,
  who: '',
  busy: '',
  notice: null,
  isEditing: false,
  draft: null,
}

const viewAtom = atom({ plugin: 'team-hub', key: 'view' } as const, EMPTY_VIEW)

type Runtime = {
  settings: Settings
  root: string
  path: string
  isInteractive: boolean
  team: TeamConfig | null
  /** `ready`, `absent` (no file) or `invalid` (a file that cannot be read). */
  phase: 'ready' | 'absent' | 'invalid'
  problems: string[]
  mtime: number
  /** The conventions as added to the system prompt: set when the file is read, so the prompt text stays stable. */
  section: string
  who: { email: string; name: string }
  installed: Map<string, CliInstall> | undefined
  binary: string
  published: string
  shared: string
  isAnnounced: boolean
  timers: Timer[]
}

const newRuntime = (settings: Settings): Runtime => ({
  settings,
  root: '',
  path: '',
  isInteractive: false,
  team: null,
  phase: 'absent',
  problems: [],
  mtime: 0,
  section: '',
  who: { email: '', name: '' },
  installed: undefined,
  binary: '',
  published: '',
  shared: '',
  isAnnounced: false,
  timers: [],
})

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

// ── Hub, softly ────────────────────────────────────────────────────────────────────────────────────

async function hubPrefs($: EngineInterface): Promise<ModsPrefs | undefined> {
  try {
    const { value } = await $.state.get({ plugin: 'mods-hub', key: 'prefs' })
    return value
  } catch {
    return undefined
  }
}

async function hubFact($: EngineInterface, key: string): Promise<unknown> {
  try {
    return (await $.mods.read({ key }))?.value
  } catch {
    return undefined
  }
}

async function hubShare($: EngineInterface, name: string, value: unknown): Promise<void> {
  try {
    await $.mods.share({ name, value: value as never })
  } catch {
    // no hub: nobody reads the fact
  }
}

// ── Reading the world ──────────────────────────────────────────────────────────────────────────────

async function loadTeam($: EngineInterface, rt: Runtime): Promise<void> {
  rt.path = `${rt.root}/${TEAM_FILE}`
  let text: string | undefined
  try {
    const read = await $.fs.read(rt.path)
    text = typeof read === 'string' ? read : undefined
  } catch {
    text = undefined
  }
  if (text === undefined) {
    rt.team = null
    rt.phase = 'absent'
    rt.problems = []
    rt.section = ''
    rt.mtime = 0
    return
  }
  rt.mtime = (await $.fs.stat(rt.path).catch(() => undefined))?.mtimeMs ?? 0
  const parsed = parseTeam(text)
  if ('error' in parsed) {
    rt.team = null
    rt.phase = 'invalid'
    rt.problems = [parsed.error]
    rt.section = ''
    return
  }
  rt.team = parsed.team
  rt.phase = 'ready'
  rt.problems = hasSecret(text) ? [...parsed.warnings, 'The file contains what looks like a secret: remove it and rotate it (the file is committed to git).'] : parsed.warnings
  // Whatever the file holds, a secret in it never goes into the system prompt.
  rt.section = redactText(conventionsSection(parsed.team), { enabled: SECRET_ONLY }).text
}

async function gitConfig($: EngineInterface, rt: Runtime, key: string): Promise<string> {
  try {
    const run = await $.process.run(['git', 'config', key], { cwd: rt.root, timeoutMs: GIT_TIMEOUT_MS })
    return run.exitCode === 0 ? run.stdout.trim() : ''
  } catch {
    return ''
  }
}

async function claudeBin($: EngineInterface, rt: Runtime): Promise<string> {
  if (rt.binary === '') {
    const execPath = await $.env.get('CLAUDE_CODE_EXECPATH').catch(() => undefined)
    rt.binary = claudeBinary(execPath)
  }
  return rt.binary
}

/** What `claude plugin list --json` says is installed; undefined when it cannot be read. */
async function readInstalled($: EngineInterface, rt: Runtime): Promise<void> {
  try {
    const listed = await $.process.run(argv.list(await claudeBin($, rt)), { timeoutMs: LIST_TIMEOUT_MS })
    rt.installed = listed.exitCode === 0 ? parseInstalled(listed.stdout) : undefined
  } catch {
    rt.installed = undefined
  }
}

/** The person's own side: the numbers in `/config`, the hub's routes and guardian's level. */
async function personalOf($: EngineInterface, rt: Runtime): Promise<Personal> {
  const rows = await $.config.list().catch(() => [])
  const config = new Map<string, string | number | boolean>()
  for (const row of rows) if (typeof row.value === 'string' || typeof row.value === 'number' || typeof row.value === 'boolean') config.set(row.key, row.value)
  const prefs = await hubPrefs($)
  return {
    config,
    routes: prefs?.routes,
    guardLevel: guardLevelOfPolicy(await hubFact($, 'guardian.policy')),
    isGuardianInstalled: rt.installed === undefined || rt.installed.has('guardian'),
  }
}

// ── The view, and what the hub is told ─────────────────────────────────────────────────────────────

async function setView($: EngineInterface, change: Partial<TeamView>): Promise<void> {
  await update($, viewAtom, view => ({ ...view, ...change }))
}

async function notice($: EngineInterface, tone: 'success' | 'error' | 'info', text: string): Promise<void> {
  await setView($, { notice: { tone, text } })
}

/** Re-reads nothing: recomputes the mods and the drift from what is held, draws them, and tells the hub on a change. */
async function refreshView($: EngineInterface, rt: Runtime): Promise<void> {
  const personal = await personalOf($, rt)
  const team = rt.team
  const mods = team === null ? [] : modStates(team, rt.installed)
  const drift = team === null ? [] : detectDrift(team, personal)
  await setView($, {
    phase: rt.phase,
    path: TEAM_FILE,
    problems: rt.problems,
    team,
    mods,
    isInstalledKnown: rt.installed !== undefined,
    drift,
    isMaintainer: team === null ? true : isMaintainer(team, rt.who),
    who: rt.who.email === '' ? rt.who.name : rt.who.email,
  })
  if (team === null) return
  const event = driftEvent(drift, mods, rt.installed !== undefined)
  const signature = driftSignature(event)
  if (signature !== rt.published) {
    rt.published = signature
    await hubPublish($, { topic: 'x.team-hub.drift', data: event })
  }
  const policy = JSON.stringify({ name: team.name, guardLevel: team.guardLevel, budget: team.budget, notifications: team.notifications, recommendedMods: team.recommendedMods })
  if (policy !== rt.shared) {
    rt.shared = policy
    await hubShare($, 'policy', { name: team.name, guardLevel: team.guardLevel, budget: team.budget, notifications: team.notifications, recommendedMods: team.recommendedMods })
  }
  if (!rt.isAnnounced && rt.isInteractive) {
    rt.isAnnounced = true
    if (rt.settings.notifyDrift && event.count > 0) await hubNotify($, { level: 'info', title: `Team rules: ${driftSummary(event)}`, body: 'Run /team to see what differs.', audience: 'terminal' })
  }
}

/** Reads the file again when it changed on disk (a `git pull`), then refreshes. */
async function check($: EngineInterface, rt: Runtime): Promise<void> {
  const stat = await $.fs.stat(rt.path).catch(() => undefined)
  const mtime = stat?.mtimeMs ?? 0
  if (mtime !== rt.mtime || (stat === undefined) !== (rt.phase === 'absent')) await loadTeam($, rt)
  await refreshView($, rt)
}

// ── Writing the file ───────────────────────────────────────────────────────────────────────────────

/** A maintainer-only action: '' when allowed, else why not. */
function deny(rt: Runtime): string {
  if (rt.team === null) return ''
  return isMaintainer(rt.team, rt.who) ? '' : `Only the owners of this team file can change it (${rt.team.owners.join(', ')}). You are ${rt.who.email || rt.who.name || 'unknown'}.`
}

async function writeTeam($: EngineInterface, rt: Runtime, team: TeamConfig): Promise<string> {
  const text = serializeTeam(team)
  const found = findSecrets(text, { enabled: SECRET_ONLY })[0]
  if (found !== undefined) return `Not saved: the file would contain what looks like a secret (${found.kind}, line ${found.line}). Team files are committed to git: keep secrets out.`
  try {
    await $.fs.write(rt.path, text)
  } catch (error) {
    return `Could not write ${TEAM_FILE}: ${messageOf(error)}`
  }
  await loadTeam($, rt)
  await refreshView($, rt)
  return ''
}

const SAVED = `Saved ${TEAM_FILE}. It is a normal file: review and commit it (git add ${TEAM_FILE}) so the team gets it.`

/** Applies one edit to the saved team and writes it. Returns a sentence for the person. */
async function editTeam($: EngineInterface, rt: Runtime, op: Op): Promise<string> {
  if (rt.team === null) return `There is no ${TEAM_FILE} yet. /team init creates one.`
  const refused = deny(rt)
  if (refused !== '') return refused
  const edited = applyOp(rt.team, op)
  if ('error' in edited) return edited.error
  const failed = await writeTeam($, rt, edited.team)
  return failed === '' ? SAVED : failed
}

async function initTeam($: EngineInterface, rt: Runtime): Promise<string> {
  if (rt.phase !== 'absent') return `${TEAM_FILE} already exists.`
  const name = rt.root.split(/[\\/]/).filter(Boolean).pop() ?? 'Team'
  const failed = await writeTeam($, rt, starterTeam(name, rt.who.email || rt.who.name))
  return failed === '' ? `Created ${TEAM_FILE} with a starter. Edit it with /team (or by hand), then commit it.` : failed
}

// ── Installing and aligning ────────────────────────────────────────────────────────────────────────

async function ensureMarketplace($: EngineInterface, rt: Runtime, team: TeamConfig, bin: string): Promise<string | undefined> {
  const listed = await $.process.run(argv.marketplaces(bin), { timeoutMs: LIST_TIMEOUT_MS })
  let names: string[] = []
  try {
    names = listed.exitCode === 0 ? parseMarketplaceNames(listed.stdout) : []
  } catch {
    names = []
  }
  if (names.includes(team.marketplaceName)) return undefined
  const added = parseOutcome(await $.process.run(argv.addMarketplace(bin, team.marketplace), { timeoutMs: CHANGE_TIMEOUT_MS }))
  return added.isOk ? undefined : added.message
}

/** Installs the named recommended mods that are missing (all of them when none is named), one after another. */
async function installMods($: EngineInterface, rt: Runtime, names: readonly string[]): Promise<string> {
  const team = rt.team
  if (team === null) return `There is no ${TEAM_FILE} yet.`
  await readInstalled($, rt)
  if (rt.installed === undefined) return 'Could not read the installed mods (claude plugin list failed).'
  const wanted = names.length === 0 ? team.recommendedMods : names
  const unknown = wanted.filter(name => !team.recommendedMods.includes(name))
  if (unknown.length > 0) return `Not in the team's list: ${unknown.join(', ')}.`
  const targets = wanted.filter(name => rt.installed?.get(name) === undefined)
  if (targets.length === 0) return 'Every recommended mod is already installed.'
  const bin = await claudeBin($, rt)
  try {
    const problem = await ensureMarketplace($, rt, team, bin)
    if (problem !== undefined) return `Could not add the ${team.marketplaceName} marketplace: ${problem}`
    const added: string[] = []
    const failed: string[] = []
    for (const [index, name] of targets.entries()) {
      await setView($, { busy: `Installing ${name} (${index + 1}/${targets.length})` })
      let outcome = parseOutcome(await $.process.run(argv.install(bin, name, team.marketplaceName), { timeoutMs: CHANGE_TIMEOUT_MS }))
      if (!outcome.isOk && outcome.failureCode === 'not_found') {
        await $.process.run(argv.refreshMarketplace(bin, team.marketplaceName), { timeoutMs: CHANGE_TIMEOUT_MS })
        outcome = parseOutcome(await $.process.run(argv.install(bin, name, team.marketplaceName), { timeoutMs: CHANGE_TIMEOUT_MS }))
      }
      if (outcome.isOk) added.push(name)
      else failed.push(`${name} (${outcome.message})`)
    }
    return [added.length > 0 ? `Installed ${added.join(', ')}. Run /reload-plugins to activate ${added.length === 1 ? 'it' : 'them'}.` : '', failed.length > 0 ? `Failed: ${failed.join('; ')}.` : ''].filter(Boolean).join(' ')
  } catch (error) {
    return `Could not install: ${messageOf(error)}`
  } finally {
    await readInstalled($, rt)
    await setView($, { busy: '' })
    await refreshView($, rt)
  }
}

/** Sets the personal budget rows back to the team's limits (the drift items this mod can fix). */
async function alignAll($: EngineInterface, rt: Runtime): Promise<string> {
  const view = await read($, viewAtom)
  const fixable = view.drift.filter(item => item.fix !== undefined)
  if (fixable.length === 0) return 'Nothing to align: the remaining differences need a change this mod cannot make (see the hints).'
  const done: string[] = []
  const refused: string[] = []
  for (const item of fixable) {
    if (item.fix === undefined) continue
    const result = await $.config.set({ key: item.fix.key, value: item.fix.value }).catch(() => ({ deny: 'refused' }))
    if ('deny' in result && result.deny !== undefined) refused.push(`${item.title} (${result.deny})`)
    else done.push(item.title)
  }
  await refreshView($, rt)
  return [done.length > 0 ? `Set ${done.join(', ')} to the team's values.` : '', refused.length > 0 ? `Could not change: ${refused.join('; ')}.` : ''].filter(Boolean).join(' ')
}

// ── The editor (maintainers) ───────────────────────────────────────────────────────────────────────

async function startEditing($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.team === null) return
  const refused = deny(rt)
  if (refused !== '') {
    await notice($, 'error', refused)
    return
  }
  await setView($, { isEditing: true, draft: (JSON.parse(JSON.stringify(rt.team)) as TeamConfig), notice: null })
}

async function stopEditing($: EngineInterface): Promise<void> {
  await setView($, { isEditing: false, draft: null })
}

/** One edit of the working copy; nothing is written until Save. */
async function draftOp($: EngineInterface, op: Op): Promise<void> {
  const view = await read($, viewAtom)
  if (view.draft === null) return
  const edited = applyOp(view.draft, op)
  if ('error' in edited) await notice($, 'error', edited.error)
  else await setView($, { draft: edited.team, notice: null })
}

async function budgetOp($: EngineInterface, key: BudgetKey, text: string): Promise<void> {
  const trimmed = text.trim()
  await draftOp($, { type: 'budget', key, value: trimmed === '' || trimmed === 'none' ? null : Number(trimmed.replace(',', '.')) })
}

async function saveDraft($: EngineInterface, rt: Runtime): Promise<void> {
  const view = await read($, viewAtom)
  if (view.draft === null) return
  const refused = deny(rt)
  if (refused !== '') {
    await notice($, 'error', refused)
    return
  }
  const failed = await writeTeam($, rt, view.draft)
  if (failed !== '') {
    await notice($, 'error', failed)
    return
  }
  await setView($, { isEditing: false, draft: null })
  await notice($, 'success', SAVED)
}

const nextOf = <T,>(list: readonly T[], current: T | undefined): T | undefined => {
  const index = current === undefined ? -1 : list.indexOf(current)
  return list[index + 1]
}

async function cycleGuard($: EngineInterface): Promise<void> {
  const view = await read($, viewAtom)
  if (view.draft === null) return
  await draftOp($, { type: 'guard', value: nextOf(GUARD_LEVELS, view.draft.guardLevel) ?? GUARD_LEVELS[0] ?? 'off' })
}

const ROUTE_CYCLE: readonly TeamRoute[] = ['terminal', 'away', 'always']

async function cycleRoute($: EngineInterface, level: TeamLevel): Promise<void> {
  const view = await read($, viewAtom)
  if (view.draft === null) return
  await draftOp($, { type: 'route', level, value: nextOf(ROUTE_CYCLE, view.draft.notifications[level]) ?? null })
}

async function doInstall($: EngineInterface, rt: Runtime, names: readonly string[]): Promise<void> {
  const text = await installMods($, rt, names)
  await notice($, text.startsWith('Installed') || text.startsWith('Every') ? 'success' : 'error', text)
}

async function doAlign($: EngineInterface, rt: Runtime): Promise<void> {
  await notice($, 'info', await alignAll($, rt))
}

async function doRefresh($: EngineInterface, rt: Runtime): Promise<void> {
  await loadTeam($, rt)
  await readInstalled($, rt)
  await refreshView($, rt)
}

async function doInit($: EngineInterface, rt: Runtime): Promise<void> {
  await notice($, 'info', await initTeam($, rt))
}

// ── The command ────────────────────────────────────────────────────────────────────────────────────

async function openPanel($: EngineInterface): Promise<boolean> {
  if (await hubShowTab($, TAB)) return true
  const opened = await $.ui.open({ id: PANE, title: 'Team' })
  return opened.isPlaced
}

const wordsOf = (text: string): string[] => text.split(/[\s,]+/).filter(word => word !== '')

async function runTeam($: EngineInterface, rt: Runtime, args: string): Promise<string> {
  const [word = '', ...rest] = args.trim().split(/\s+/)
  const command = word.toLowerCase()
  const argument = rest.join(' ').trim()
  if (command === 'reload') {
    await doRefresh($, rt)
    return `Reloaded ${TEAM_FILE}.`
  }
  if (command === '' || command === 'show' || command === 'status') {
    await check($, rt)
    const view = await read($, viewAtom)
    if (command === '' && (await openPanel($))) return 'Team panel opened.'
    return summaryText(view)
  }
  if (command === 'check') {
    await doRefresh($, rt)
    const view = await read($, viewAtom)
    if (view.team === null) return summaryText(view)
    const missing = view.mods.filter(mod => mod.state === 'missing').map(mod => mod.name)
    const event = driftEvent(view.drift, view.mods, view.isInstalledKnown)
    return [driftSummary(event), ...view.drift.map(item => `  ⚠ ${item.title}: yours ${item.personal}, team ${item.team}`), ...(missing.length > 0 ? [`  Missing: ${missing.join(', ')} (/team install)`] : [])].join('\n')
  }
  if (command === 'init') return initTeam($, rt)
  if (command === 'install') return installMods($, rt, argument === 'all' ? [] : wordsOf(argument))
  if (command === 'align') return alignAll($, rt)
  if (command === 'add-mod') return wordsOf(argument).length === 0 ? USAGE : editEach($, rt, wordsOf(argument).map(value => ({ type: 'addMod' as const, value })))
  if (command === 'remove-mod') return wordsOf(argument).length === 0 ? USAGE : editEach($, rt, wordsOf(argument).map(value => ({ type: 'removeMod' as const, value })))
  if (command === 'convention') return argument === '' ? USAGE : editTeam($, rt, { type: 'addConvention', value: argument })
  if (command === 'guard') {
    const level = GUARD_LEVELS.find(one => one === argument.toLowerCase())
    return level === undefined ? USAGE : editTeam($, rt, { type: 'guard', value: level })
  }
  if (command === 'budget') {
    const [key = '', value = ''] = rest
    const budgetKey = BUDGET_KEYS.find(one => one === key)
    if (budgetKey === undefined || value === '') return USAGE
    return editTeam($, rt, { type: 'budget', key: budgetKey, value: value === 'none' ? null : Number(value.replace(',', '.')) })
  }
  if (command === 'route') {
    const [level = '', route = ''] = rest
    const known = LEVELS.find(one => one === level)
    const wanted = (['off', 'terminal', 'away', 'always'] as const).find(one => one === route)
    if (known === undefined || (wanted === undefined && route !== 'none')) return USAGE
    return editTeam($, rt, { type: 'route', level: known, value: wanted ?? null })
  }
  if (command === 'owner') {
    const [action = '', ...who] = rest
    if ((action !== 'add' && action !== 'remove') || who.length === 0) return USAGE
    return editTeam($, rt, { type: action === 'add' ? 'addOwner' : 'removeOwner', value: who.join(' ') })
  }
  return USAGE
}

/** Several edits in a row, each checked; stops at the first that fails, and says what was done. */
async function editEach($: EngineInterface, rt: Runtime, ops: readonly Op[]): Promise<string> {
  let last = ''
  for (const op of ops) {
    last = await editTeam($, rt, op)
    if (last !== SAVED) return last
  }
  return last
}

// ── The tab and the pane ───────────────────────────────────────────────────────────────────────────

const TONE_COLOR = { success: 'success', error: 'error', info: 'suggestion' } as const
const TONE_GLYPH = { success: '✓', error: '✗', info: '•' } as const
const MOD_GLYPH = { installed: '✓', disabled: '○', missing: '✗' } as const
const MOD_COLOR = { installed: 'success', disabled: 'warning', missing: 'error' } as const

async function drawTeam($: EngineInterface, e: RenderInput<'Pane'>, rt: Runtime): Promise<RenderElement> {
  const { Box, Button, Text } = $.ui.resolve(e)
  const view = await read($, viewAtom)
  const fields = e.surface === 'mobile' ? undefined : $.ui.resolve(e)
  const Input = fields === undefined ? undefined : fields.Input
  const team = view.team
  const header = (
    <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={1}>
      <Text bold color="claude">{`👥 Team${team === null || team.name === '' ? '' : ` · ${team.name}`}`}</Text>
      <Text dimColor>{view.phase === 'ready' ? `${view.path}${view.isMaintainer ? '' : ' · read-only'}` : view.path}</Text>
    </Box>
  )
  const notices = (
    <Box flexDirection="column">
      {view.busy === '' ? null : <Text color="suggestion">{`⟳ ${view.busy}…`}</Text>}
      {view.notice === null ? null : <Text color={TONE_COLOR[view.notice.tone]} wrap="wrap">{`${TONE_GLYPH[view.notice.tone]} ${view.notice.text}`}</Text>}
    </Box>
  )
  if (view.phase === 'loading') return <Box flexDirection="column">{header}<Text color="suggestion">⟳ Reading the team file…</Text></Box>
  if (view.phase === 'absent') {
    return (
      <Box flexDirection="column">
        {header}
        <Text wrap="wrap">{`This repository has no ${TEAM_FILE}. It holds the team's conventions, recommended mods, budgets and notification rules, and travels with the code through git.`}</Text>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
          <Button key="team-create" label="Create team.json" variant="primary" onPress={() => doInit($, rt)} />
        </Box>
        {notices}
      </Box>
    )
  }
  if (view.phase === 'invalid' || team === null) {
    return (
      <Box flexDirection="column">
        {header}
        <Text color="error" wrap="wrap">{`✗ ${view.problems.join(' ')}`}</Text>
        <Text dimColor wrap="wrap">Fix the file (it is a normal JSON file in the repository), then reload.</Text>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
          <Button key="team-refresh" label="Reload" onPress={() => doRefresh($, rt)} />
        </Box>
      </Box>
    )
  }
  if (view.isEditing && view.draft !== null) return drawEditor($, e, rt, view.draft, header, notices)
  const conventions = conventionLines(team)
  const missing = view.mods.filter(mod => mod.state === 'missing')
  return (
    <Box flexDirection="column">
      {header}
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Text dimColor wrap="wrap">{`${plural(view.mods.length, 'recommended mod')} · ${view.drift.length === 0 ? 'in line with the rules' : plural(view.drift.length, 'difference')}${view.isInstalledKnown && missing.length > 0 ? ` · ${missing.length} missing` : ''}`}</Text>
      </Box>
      {notices}
      <Text bold>Conventions</Text>
      {conventions.length === 0 ? <Text dimColor>  none yet</Text> : null}
      {conventions.slice(0, SHOWN_LINES).map((line, index) => (
        <Text key={`convention-${index}`} wrap="wrap">{`  - ${line}`}</Text>
      ))}
      {conventions.length > SHOWN_LINES ? <Text dimColor>{`  …and ${conventions.length - SHOWN_LINES} more`}</Text> : null}
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Recommended mods</Text>
        {view.mods.length === 0 ? <Text dimColor>  none yet</Text> : null}
        {view.mods.map(mod => (
          <Box key={`mod-${mod.name}`} flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Text color={view.isInstalledKnown ? MOD_COLOR[mod.state] : 'suggestion'}>{`  ${view.isInstalledKnown ? MOD_GLYPH[mod.state] : '?'} ${mod.name}${mod.state === 'installed' && mod.version !== '' ? ` ${mod.version}` : ''}${mod.state === 'disabled' ? ' (installed, off)' : ''}`}</Text>
            {view.isInstalledKnown && mod.state === 'missing' && view.busy === '' ? <Button key={`team-install-${mod.name}`} label="Install" onPress={() => doInstall($, rt, [mod.name])} /> : null}
          </Box>
        ))}
        {view.isInstalledKnown && missing.length > 1 && view.busy === '' ? (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Button key="team-install-all" label={`Install all missing (${missing.length})`} variant="primary" onPress={() => doInstall($, rt, [])} />
          </Box>
        ) : null}
        {!view.isInstalledKnown && view.mods.length > 0 ? <Text dimColor wrap="wrap">  Could not read the installed mods (claude plugin list).</Text> : null}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Your settings against the team's</Text>
        {view.drift.length === 0 ? <Text color="success">  ✓ In line.</Text> : null}
        {view.drift.map(item => (
          <Box key={`drift-${item.id}`} flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Text color="warning" wrap="wrap">{`  ⚠ ${item.title}: yours ${item.personal}, team ${item.team}${item.hint === undefined ? '' : ` (${item.hint})`}`}</Text>
            {item.fix === undefined ? null : <Button key={`team-align-${item.id}`} label="Align" onPress={() => doAlign($, rt)} />}
          </Box>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Team defaults</Text>
        <Text wrap="wrap">{`  Guard: ${team.guardLevel === 'off' ? 'no requirement' : team.guardLevel}`}</Text>
        <Text wrap="wrap">{`  Budget: ${Object.keys(team.budget).length === 0 ? 'none set' : BUDGET_KEYS.filter(key => team.budget[key] !== undefined).map(key => `${key} ${team.budget[key]}`).join(' · ')}`}</Text>
        <Text wrap="wrap">{`  Notifications (at least): ${Object.keys(team.notifications).length === 0 ? 'none set' : LEVELS.filter(level => team.notifications[level] !== undefined).map(level => `${level} → ${team.notifications[level]}`).join(' · ')}`}</Text>
        <Text wrap="wrap">{`  Owners: ${team.owners.length === 0 ? 'nobody yet (anyone may edit)' : team.owners.join(', ')}`}</Text>
      </Box>
      {view.problems.length === 0 ? null : <Text dimColor wrap="wrap">{`Ignored in the file: ${view.problems.join(' ')}`}</Text>}
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
        {view.isMaintainer && Input !== undefined ? <Button key="team-edit" label="Edit" variant="primary" onPress={() => startEditing($, rt)} /> : null}
        <Button key="team-refresh" label="Reload" onPress={() => doRefresh($, rt)} />
      </Box>
      {!view.isMaintainer ? <Text dimColor wrap="wrap">{`Only the owners can edit this file (you are ${view.who || 'unknown'}). Propose a change through a pull request.`}</Text> : null}
      {view.isMaintainer && Input === undefined ? <Text dimColor wrap="wrap">Edit with /team commands on this surface (add-mod, convention, guard, budget, route, owner).</Text> : null}
    </Box>
  )
}

function drawEditor($: EngineInterface, e: RenderInput<'Pane'>, rt: Runtime, draft: TeamConfig, header: RenderElement, notices: RenderElement): RenderElement {
  const { Box, Button, Text } = $.ui.resolve(e)
  const fields = e.surface === 'mobile' ? undefined : $.ui.resolve(e)
  const Input = fields === undefined ? undefined : fields.Input
  const lines = conventionLines(draft)
  if (Input === undefined) return <Box flexDirection="column">{header}<Text>Editing needs text fields: use /team commands here.</Text></Box>
  return (
    <Box flexDirection="column">
      {header}
      <Text color="suggestion" wrap="wrap">{`Editing ${TEAM_FILE}: nothing is written until you press Save.`}</Text>
      {notices}
      <Input key="team-name" label="Name" value={draft.name} submitLabel="set" onSubmit={(value: string) => draftOp($, { type: 'name', value })} />
      <Text bold>Conventions</Text>
      {lines.map((line, index) => (
        <Box key={`edit-convention-${index}`} flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Text wrap="wrap">{`  ${index + 1}. ${line}`}</Text>
          <Button key={`team-rm-convention-${index}`} label="✕" onPress={() => draftOp($, { type: 'removeConvention', index })} />
        </Box>
      ))}
      <Input key="team-add-convention" label="Add a convention" placeholder="Run the tests before a pull request" submitLabel="add" onSubmit={(value: string) => draftOp($, { type: 'addConvention', value })} />
      <Text bold>Recommended mods</Text>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {draft.recommendedMods.map(name => (
          <Button key={`team-rm-mod-${name}`} label={`${name} ✕`} onPress={() => draftOp($, { type: 'removeMod', value: name })} />
        ))}
      </Box>
      <Input key="team-add-mod" label="Add a mod" placeholder="secret-shield" submitLabel="add" onSubmit={(value: string) => draftOp($, { type: 'addMod', value: value.trim() })} />
      <Text bold>Rules</Text>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Button key="team-guard" label={`Guard level: ${draft.guardLevel}`} onPress={() => cycleGuard($)} />
      </Box>
      {BUDGET_KEYS.map(key => (
        <Input key={`team-budget-${key}`} label={`Budget ${key}`} placeholder="none" value={draft.budget[key] === undefined ? '' : String(draft.budget[key])} submitLabel="set" onSubmit={(value: string) => budgetOp($, key, value)} />
      ))}
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {LEVELS.map(level => (
          <Button key={`team-route-${level}`} label={`${level}: ${draft.notifications[level] ?? '–'}`} onPress={() => cycleRoute($, level)} />
        ))}
      </Box>
      <Text bold>Owners</Text>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {draft.owners.map(owner => (
          <Button key={`team-rm-owner-${owner}`} label={`${owner} ✕`} onPress={() => draftOp($, { type: 'removeOwner', value: owner })} />
        ))}
      </Box>
      <Input key="team-add-owner" label="Add an owner" placeholder="alice@acme.com" submitLabel="add" onSubmit={(value: string) => draftOp($, { type: 'addOwner', value })} />
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
        <Button key="team-save" label="Save" variant="primary" onPress={() => saveDraft($, rt)} />
        <Button key="team-cancel" label="Cancel" onPress={() => stopEditing($)} />
      </Box>
    </Box>
  )
}

// ── Start ──────────────────────────────────────────────────────────────────────────────────────────

/** Loads the file first (the system prompt needs it at once), the slower reads after. */
async function startUp($: EngineInterface, rt: Runtime, isInteractive: boolean): Promise<void> {
  rt.isInteractive = isInteractive
  rt.root = (await $.session.repo().catch(() => null))?.root ?? (await $.session.root().catch(() => ''))
  rt.path = `${rt.root}/${TEAM_FILE}`
  await loadTeam($, rt)
  await hubHello($, { version: VERSION, publishes: ['x.team-hub.drift'], consumes: [] }, { id: TAB, title: 'Team', order: TAB_ORDER, command: 'team' })
  $.clock.after(0, () => void settleUp($, rt))
  if (isInteractive) rt.timers.push($.clock.every(CHECK_MS, () => void check($, rt).catch(error => $.ui.log(`${NAME}: ${messageOf(error)}`, { to: 'debug' }))))
}

/** The slower reads: who the person is in git, which mods are installed; then the first drift. */
async function settleUp($: EngineInterface, rt: Runtime): Promise<void> {
  try {
    rt.who = { email: await gitConfig($, rt, 'user.email'), name: await gitConfig($, rt, 'user.name') }
    await readInstalled($, rt)
    await refreshView($, rt)
  } catch (error) {
    $.ui.log(`${NAME}: ${messageOf(error)}`, { to: 'debug' })
  }
}

export const register: Register = (on, options) => {
  const rt = newRuntime(readSettings(options))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      await $.command.register({ name: 'team', description: "The team's shared conventions, recommended mods, budgets and rules (synced through the repo)", argumentHint: '[show | check | install | align | init | add-mod | convention | guard | budget | route | owner]' })
    } catch (error) {
      $.ui.log(`${NAME}: could not register /team: ${messageOf(error)}`, { to: 'debug' })
    }
    try {
      await startUp($, rt, e.isInteractive)
    } catch (error) {
      $.ui.log(`${NAME}: start-up failed: ${messageOf(error)}`, { to: 'debug' })
    }
    return started
  })

  on('command.run', { command: 'team' }, async ($, e) => {
    try {
      return { text: await runTeam($, rt, e.args) }
    } catch (error) {
      return { text: `The /team command failed: ${messageOf(error)}` }
    }
  })

  // The team's conventions, as one stable section of the system prompt (re-read only when the file changes).
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!rt.settings.injectConventions || rt.section === '' || e.traits.includes('bare')) return composed
    return { sections: [...composed.sections, { id: 'team-hub', text: rt.section, scope: 'session' }] }
  })

  // The shared panel: the Team tab's body, drawn here when the hub shows our tab.
  on('ui.render', { component: 'Pane', requestId: 'claude-mods' }, async ($, e, next) => {
    if (!(await hubTabIs($, TAB))) return next(e)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {await next(e)}
        {await drawTeam($, e, rt)}
      </Box>
    )
  })

  // Without the hub: the same drawing in a pane of its own.
  on('ui.render', { component: 'Pane', requestId: 'team-hub' }, async ($, e) => drawTeam($, e, rt))
}

// #region @vendored shared/hub-client.ts sha256:0acb840d81b7: edit the source, then run `node scripts/sync-shared.mjs`.
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
// #endregion @vendored shared/hub-client.ts
