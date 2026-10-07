import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput } from 'claude-code'

import type { Recipe, RecipeCheckResult, RecipeEntry, RecipeMode, RecipeRun, RecipeSource, RecipeTier, StudioEditing, StudioUi } from '../types'
import { BUILTIN_RECIPES } from './builtins'
import {
  DEFAULT_MODELS,
  MAX_STEPS,
  MODES,
  TIERS,
  USAGE,
  detailText,
  fill,
  findRecipe,
  fromAutopilot,
  fromRoute,
  listText,
  markShadowed,
  oneLine,
  parseArgs,
  placeholdersIn,
  readRecipe,
  recipeText,
  resolveParams,
  runGlyph,
  runLine,
  runPrompt,
  search,
  skeleton,
  slugify,
  span,
  stagesOf,
  validateRecipe,
} from './recipe'
import type { AutopilotPlan } from './recipe'
import { parseYaml } from './yaml'

const PANE = 'workflow-studio'
const PANE_TITLE = 'Workflows'
const TAB = 'workflows'
const TAB_ORDER = 50
const VERSION = '1.0.0'
const PROJECT_DIR = '.claude/recipes'
const PERSONAL_DIR = '.claude/claude-mods/recipes'
const AUTOPILOT_PLAN = '.claude/claude-mods/autopilot/last-plan.json'
const HISTORY_PREFIX = 'history:'
const MAX_HISTORY = 30
const CHECK_TIMEOUT_MS = 300_000
const GIT_TIMEOUT_MS = 5_000
const RECIPE_FILE = /\.(?:ya?ml|json)$/i
const SOURCE_LABEL: Record<RecipeSource, string> = { project: 'project', personal: 'personal', builtin: 'built-in' }
const OUTCOME_COLOR: Record<RecipeRun['outcome'], string> = { queued: 'subtle', running: 'suggestion', checking: 'suggestion', passed: 'success', failed: 'error', done: 'success', cancelled: 'warning' }
const HOME_UI: StudioUi = { screen: 'list', query: '', selected: null, params: {}, message: '' }

const entriesAtom = atom({ plugin: 'workflow-studio', key: 'entries' } as const, [] as RecipeEntry[])
const uiAtom = atom({ plugin: 'workflow-studio', key: 'ui' } as const, HOME_UI)
const editingAtom = atom({ plugin: 'workflow-studio', key: 'editing' } as const, null as StudioEditing | null)
const runsAtom = atom({ plugin: 'workflow-studio', key: 'runs' } as const, [] as RecipeRun[])

/** What this load knows beside the state: where things are, whether a turn runs, the run waiting for it to end. */
type Ctx = {
  root: string | undefined
  home: string | undefined
  isTurnRunning: boolean
  queued: { id: string; prompt: string } | null
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

// ── Where recipes live ──────────────────────────────────────────────────────────────────────────────

async function rootOf($: EngineInterface, ctx: Ctx): Promise<string> {
  if (ctx.root === undefined) ctx.root = (await $.session.root().catch(() => '')).replace(/[\\/]+$/, '')
  return ctx.root
}

async function homeOf($: EngineInterface, ctx: Ctx): Promise<string> {
  if (ctx.home === undefined) ctx.home = ((await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '').replace(/[\\/]+$/, '')
  return ctx.home
}

async function dirOf($: EngineInterface, ctx: Ctx, target: 'project' | 'personal'): Promise<string> {
  return target === 'project' ? `${await rootOf($, ctx)}/${PROJECT_DIR}` : `${await homeOf($, ctx)}/${PERSONAL_DIR}`
}

async function readDir($: EngineInterface, dir: string, source: RecipeSource): Promise<RecipeEntry[]> {
  const files = await $.fs.list(dir).catch(() => [])
  const entries: RecipeEntry[] = []
  for (const file of files.filter(one => one.kind === 'file' && RECIPE_FILE.test(one.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${dir}/${file.name}`
    const text = await $.fs.read(path).catch(() => undefined)
    const { recipe, errors } = text === undefined ? { recipe: null, errors: ['could not read the file'] } : readRecipe(text, path)
    entries.push({ name: recipe?.name ?? file.name.replace(RECIPE_FILE, ''), source, path, recipe, errors, isShadowed: false })
  }
  return entries
}

/** Reads every recipe: built-in, personal, then the project's (which win on a shared name). */
async function loadAll($: EngineInterface, ctx: Ctx): Promise<RecipeEntry[]> {
  const builtin = Object.entries(BUILTIN_RECIPES).map(([name, text]): RecipeEntry => {
    const { recipe, errors } = readRecipe(text, `${name}.yaml`)
    return { name, source: 'builtin', path: `builtin:${name}`, recipe, errors, isShadowed: false }
  })
  const home = await homeOf($, ctx)
  const root = await rootOf($, ctx)
  const personal = home === '' ? [] : await readDir($, `${home}/${PERSONAL_DIR}`, 'personal')
  const project = root === '' ? [] : await readDir($, `${root}/${PROJECT_DIR}`, 'project')
  const entries = markShadowed([...builtin, ...personal, ...project])
  await update($, entriesAtom, () => entries)
  return entries
}

async function writeRecipe($: EngineInterface, ctx: Ctx, recipe: Recipe, target: 'project' | 'personal', path = ''): Promise<string> {
  const where = path !== '' && !path.startsWith('builtin:') ? path : `${await dirOf($, ctx, target)}/${recipe.name}.yaml`
  const text = /\.json$/i.test(where) ? `${JSON.stringify(recipe, null, 2)}\n` : recipeText(recipe)
  await $.fs.write(where, text)
  await loadAll($, ctx)
  return where
}

const shortPath = (path: string, root: string, home: string): string =>
  root !== '' && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : home !== '' && path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path

// ── Runs ────────────────────────────────────────────────────────────────────────────────────────────

/** smart-router's tier models when it shares its policy on the hub, else haiku / sonnet / opus. */
async function modelsOf($: EngineInterface): Promise<Record<RecipeTier, string>> {
  try {
    const fact = await $.mods.read({ key: 'smart-router.policy' })
    const models = (fact?.value as { models?: Record<string, unknown> } | null | undefined)?.models
    if (models === undefined || models === null) return DEFAULT_MODELS
    const pick = (tier: RecipeTier): string => (typeof models[tier] === 'string' && models[tier] !== '' ? String(models[tier]) : DEFAULT_MODELS[tier])
    return { light: pick('light'), standard: pick('standard'), deep: pick('deep') }
  } catch {
    return DEFAULT_MODELS
  }
}

/** Subagents that finished since `since`, from the hub's bus; null without the hub. */
async function agentsSince($: EngineInterface, since: number): Promise<number | null> {
  try {
    return (await $.mods.recent({ topic: 'agent.finished', since, limit: 200 })).length
  } catch {
    return null
  }
}

async function builtinsOf($: EngineInterface, ctx: Ctx, recipe: Recipe): Promise<{ project: string; date: string; branch: string }> {
  const root = await rootOf($, ctx)
  const now = new Date(await $.clock.now())
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const uses = [...recipe.steps.flatMap(step => placeholdersIn(step.prompt)), ...recipe.checks.flatMap(check => placeholdersIn(check.command))]
  let branch = ''
  if (uses.includes('branch') && root !== '') {
    const ran = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, timeoutMs: GIT_TIMEOUT_MS }).catch(() => undefined)
    branch = ran?.exitCode === 0 ? ran.stdout.trim() : ''
  }
  return { project: root.replace(/^.*[\\/]/, ''), date, branch }
}

async function saveHistory($: EngineInterface, ctx: Ctx, change: (runs: RecipeRun[]) => RecipeRun[]): Promise<RecipeRun[]> {
  const runs = await update($, runsAtom, list => change(list).slice(-MAX_HISTORY))
  try {
    await $.store.set(`${HISTORY_PREFIX}${await rootOf($, ctx)}`, runs)
  } catch (error) {
    $.ui.log(`workflow-studio: could not save the history: ${messageOf(error)}`, { to: 'debug' })
  }
  return runs
}

const changeRun = (id: string, change: (run: RecipeRun) => RecipeRun) => (runs: RecipeRun[]) => runs.map(run => (run.id === id ? change(run) : run))

/** Runs a recipe: fills its params, builds the prompt for its mode and sends it as your words (after the current turn, if one runs). */
async function runRecipe($: EngineInterface, ctx: Ctx, name: string, given: Record<string, string>): Promise<string> {
  const entries = await loadAll($, ctx)
  const entry = findRecipe(entries, name)
  if (entry === undefined) return `No recipe "${name}". /recipe list shows them.`
  if (entry.recipe === null) return detailText(entry)
  const recipe = entry.recipe
  const { values, problems } = resolveParams(recipe, given, await builtinsOf($, ctx, recipe))
  if (problems.length > 0) return [`Cannot run ${recipe.name}:`, ...problems.map(problem => `- ${problem}`)].join('\n')
  if (ctx.queued !== null) return 'Another recipe is already waiting for this turn to end.'
  const id = crypto.randomUUID()
  const marker = `[workflow-studio run ${id.slice(0, 8)}]`
  const prompt = runPrompt(recipe, { values, models: await modelsOf($), marker })
  const params = Object.fromEntries(recipe.params.map(param => [param.name, values[param.name] ?? '']).filter(([, value]) => value !== ''))
  const run: RecipeRun = {
    id,
    name: recipe.name,
    title: recipe.title ?? recipe.name,
    mode: recipe.mode,
    source: entry.source,
    params,
    startedAt: await $.clock.now(),
    endedAt: null,
    outcome: 'queued',
    marker,
    checks: [],
    agents: null,
    summary: '',
  }
  await saveHistory($, ctx, runs => [...runs, run])
  if (ctx.isTurnRunning) {
    ctx.queued = { id, prompt }
    await hubPublish($, { topic: 'task.queued', data: { id, title: `Recipe: ${run.title}` } })
    return `Queued ${recipe.name}: it starts when the current turn ends.`
  }
  // Sent once the command or press that asked for it has answered.
  $.clock.after(0, () => void send($, ctx, id, prompt))
  return `Running ${recipe.name}${recipe.mode === 'workflow' ? ' as a workflow' : ''}${Object.keys(params).length === 0 ? '' : ` (${Object.entries(params).map(([key, value]) => `${key}=${value}`).join(', ')})`}.`
}

async function send($: EngineInterface, ctx: Ctx, id: string, prompt: string): Promise<void> {
  const runs = await saveHistory($, ctx, changeRun(id, run => ({ ...run, outcome: 'running' })))
  const run = runs.find(one => one.id === id)
  if (run !== undefined) await hubPublish($, { topic: 'task.started', data: { id, title: `Recipe: ${run.title}` } })
  try {
    const sent = await $.prompt.submit({ text: prompt, asUser: true })
    if (sent.drop !== undefined) await finishRun($, ctx, id, 'failed', `a hook refused the prompt: ${sent.drop}`)
  } catch (error) {
    await finishRun($, ctx, id, 'failed', `the prompt could not be sent: ${messageOf(error)}`)
  }
}

async function runChecks($: EngineInterface, ctx: Ctx, recipe: Recipe, params: Record<string, string>): Promise<RecipeCheckResult[]> {
  const root = await rootOf($, ctx)
  const values = { ...(await builtinsOf($, ctx, recipe)), ...params }
  const results: RecipeCheckResult[] = []
  for (const check of recipe.checks) {
    const command = fill(check.command, values)
    try {
      const ran = await $.process.run(['sh', '-c', command], { ...(root === '' ? {} : { cwd: root }), timeoutMs: CHECK_TIMEOUT_MS })
      results.push({ name: check.name, command, ok: ran.exitCode === 0, summary: ran.exitCode === 0 ? '✓ exit 0' : `✗ exit ${ran.exitCode}` })
    } catch (error) {
      results.push({ name: check.name, command, ok: false, summary: /still running/.test(messageOf(error)) ? '✗ timed out' : '✗ could not start' })
    }
  }
  return results
}

/** The run's turn ended: run its checks (when it has some), file the outcome, tell the hub. */
async function settleRun($: EngineInterface, ctx: Ctx, id: string, reason: string, answer: string): Promise<void> {
  const run = (await read($, runsAtom)).find(one => one.id === id)
  if (run === undefined) return
  const summary = oneLine(answer, 300)
  if (reason === 'aborted') return finishRun($, ctx, id, 'cancelled', summary || 'you interrupted it')
  if (reason !== 'answer') return finishRun($, ctx, id, 'failed', reason === 'refusal' ? 'Claude declined' : 'the turn ended on an error')
  const recipe = findRecipe(await read($, entriesAtom), run.name)?.recipe
  if (recipe === undefined || recipe === null || recipe.checks.length === 0) return finishRun($, ctx, id, 'done', summary)
  await saveHistory($, ctx, changeRun(id, one => ({ ...one, outcome: 'checking', summary })))
  const checks = await runChecks($, ctx, recipe, run.params)
  await saveHistory($, ctx, changeRun(id, one => ({ ...one, checks })))
  return finishRun($, ctx, id, checks.every(check => check.ok) ? 'passed' : 'failed', summary)
}

async function finishRun($: EngineInterface, ctx: Ctx, id: string, outcome: 'passed' | 'failed' | 'done' | 'cancelled', summary: string): Promise<void> {
  const before = (await read($, runsAtom)).find(one => one.id === id)
  if (before === undefined) return
  const now = await $.clock.now()
  const agents = await agentsSince($, before.startedAt)
  const runs = await saveHistory($, ctx, changeRun(id, run => ({ ...run, outcome, endedAt: now, summary: summary || run.summary, agents })))
  const run = runs.find(one => one.id === id) ?? before
  await hubPublish($, { topic: 'task.finished', data: { id, title: `Recipe: ${run.title}`, outcome: outcome === 'cancelled' ? 'cancelled' : outcome === 'failed' ? 'failed' : 'ok' } })
  await hubPublish($, { topic: 'x.workflow-studio.finished', data: { id, name: run.name, mode: run.mode, outcome, ms: now - run.startedAt, checks: run.checks.map(check => ({ name: check.name, ok: check.ok })), agents } })
  const checks = run.checks.length === 0 ? '' : ` · checks ${run.checks.filter(check => check.ok).length}/${run.checks.length}`
  if (outcome === 'failed') await hubNotify($, { level: 'error', title: `Recipe ${run.name} failed`, body: `${summary || 'see the history'}${checks}`, topic: 'x.workflow-studio.finished' })
  else if (outcome === 'cancelled') $.ui.toast(`${run.name}: cancelled`)
  else await hubNotify($, { level: 'success', title: `Recipe ${run.name} ${outcome === 'passed' ? 'passed' : 'done'}`, body: `${span(now - run.startedAt)}${checks}`, topic: 'x.workflow-studio.finished' })
}

/** Runs a finished run's checks again (a workflow that kept going in the background, a fix made by hand). */
async function recheck($: EngineInterface, ctx: Ctx, id: string): Promise<void> {
  const run = (await read($, runsAtom)).find(one => one.id === id)
  const recipe = run === undefined ? undefined : findRecipe(await read($, entriesAtom), run.name)?.recipe
  if (run === undefined || recipe === undefined || recipe === null || recipe.checks.length === 0) return
  const checks = await runChecks($, ctx, recipe, run.params)
  const outcome = checks.every(check => check.ok) ? 'passed' : 'failed'
  await saveHistory($, ctx, changeRun(id, one => ({ ...one, checks, outcome })))
  $.ui.toast(`${run.name}: checks ${checks.filter(check => check.ok).length}/${checks.length} ${outcome}`)
}

// ── Saving a plan as a recipe ───────────────────────────────────────────────────────────────────────

async function savePlan($: EngineInterface, ctx: Ctx, name: string, from: 'auto' | 'autopilot' | 'route', target: 'project' | 'personal'): Promise<string> {
  const home = await homeOf($, ctx)
  const pilotText = from === 'route' || home === '' ? undefined : await $.fs.read(`${home}/${AUTOPILOT_PLAN}`).catch(() => undefined)
  let pilot: (AutopilotPlan & { finishedAt?: string }) | undefined
  try {
    const parsed = pilotText === undefined ? undefined : (JSON.parse(pilotText) as AutopilotPlan)
    pilot = parsed !== undefined && typeof parsed.goal === 'string' && Array.isArray(parsed.steps) && parsed.steps.length > 0 ? parsed : undefined
  } catch {
    pilot = undefined
  }
  const route = from === 'autopilot' ? null : ((await $.state.get({ plugin: 'smart-router', key: 'plan' })).value ?? null)
  const pilotAt = pilot?.finishedAt === undefined ? 0 : Date.parse(pilot.finishedAt) || 0
  const useRoute = route !== null && route.subtasks.length > 0 && (pilot === undefined || route.createdAt >= pilotAt)
  if (!useRoute && pilot === undefined) {
    return from === 'route'
      ? 'No /route plan in this session (smart-router keeps it per session): run /route <task> first.'
      : 'Nothing to save yet: a successful /autopilot run or a /route plan (smart-router) becomes a recipe.'
  }
  const recipeName = slugify(name !== '' ? name : useRoute && route !== null ? route.task : (pilot?.goal ?? 'plan'))
  const recipe = useRoute && route !== null ? fromRoute(route, recipeName) : fromAutopilot(pilot as AutopilotPlan, recipeName)
  const { errors } = validateRecipe(parseYaml(recipeText(recipe)))
  if (errors.length > 0) return [`The plan does not make a valid recipe:`, ...errors.map(error => `- ${error}`)].join('\n')
  const path = await writeRecipe($, ctx, recipe, target)
  await update($, uiAtom, (ui): StudioUi => ({ ...ui, screen: 'detail', selected: recipe.name, params: {}, message: `Saved ${recipe.name} from ${useRoute ? 'the /route plan' : 'autopilot\'s last plan'}` }))
  return `Saved the ${useRoute ? '/route plan' : 'autopilot plan'} as ${recipe.name} (${plural(recipe.steps.length, 'step')}) in ${shortPath(path, await rootOf($, ctx), home)}. Edit it with /recipe edit ${recipe.name}.`
}

// ── The editor ──────────────────────────────────────────────────────────────────────────────────────

async function startEditing($: EngineInterface, entry: RecipeEntry | undefined, recipe: Recipe, target: 'project' | 'personal'): Promise<void> {
  const path = entry === undefined || entry.source === 'builtin' ? '' : entry.path
  await update($, editingAtom, () => ({ path, target: entry?.source === 'personal' ? 'personal' : target, recipe, errors: [] }))
  await update($, uiAtom, (ui): StudioUi => ({ ...ui, screen: 'edit', selected: recipe.name, message: entry?.source === 'builtin' ? 'Editing a copy of a built-in: Save writes it to this project.' : '' }))
}

async function edit($: EngineInterface, change: (recipe: Recipe) => Recipe): Promise<void> {
  await update($, editingAtom, editing => (editing === null ? null : { ...editing, recipe: change(editing.recipe), errors: [] }))
}

const cycle = <T,>(list: readonly T[], value: T | undefined): T => list[(list.indexOf(value as T) + 1) % list.length] as T

/** `version, channel=stable` → params, keeping what the old ones said about the same names. */
function paramsFrom(text: string, old: Recipe['params']): Recipe['params'] {
  return text
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const [name = '', ...rest] = part.split('=')
      const fallback = rest.join('=').trim()
      const before = old.find(param => param.name === name.trim())
      const { default: _default, ...kept } = before ?? { name: name.trim() }
      return { ...kept, name: name.trim(), ...(fallback === '' ? {} : { default: fallback }) }
    })
}

const paramsWords = (params: Recipe['params']): string => params.map(param => (param.default === undefined ? param.name : `${param.name}=${param.default}`)).join(', ')

async function saveEditing($: EngineInterface, ctx: Ctx): Promise<void> {
  const editing = await read($, editingAtom)
  if (editing === null) return
  const { recipe, errors } = validateRecipe(parseYaml(recipeText(editing.recipe)))
  if (recipe === null) {
    await update($, editingAtom, latest => (latest === null ? null : { ...latest, errors }))
    return
  }
  const entries = await read($, entriesAtom)
  const clash = entries.find(entry => entry.name === recipe.name && entry.source === editing.target && entry.path !== editing.path)
  if (clash !== undefined) {
    await update($, editingAtom, latest => (latest === null ? null : { ...latest, errors: [`name: "${recipe.name}" is already a ${SOURCE_LABEL[editing.target]} recipe (${clash.path}); pick another name`] }))
    return
  }
  const path = await writeRecipe($, ctx, recipe, editing.target, editing.path)
  await update($, editingAtom, () => null)
  await update($, uiAtom, (ui): StudioUi => ({ ...ui, screen: 'detail', selected: recipe.name, message: `Saved ${shortPath(path, ctx.root ?? '', ctx.home ?? '')}` }))
}

async function copyRecipe($: EngineInterface, ctx: Ctx, name: string, target: 'project' | 'personal'): Promise<string> {
  const entry = findRecipe(await loadAll($, ctx), name)
  if (entry?.recipe === undefined || entry.recipe === null) return entry === undefined ? `No recipe "${name}".` : detailText(entry)
  if (entry.source === target) return `${name} is already a ${SOURCE_LABEL[target]} recipe (${entry.path}).`
  const path = await writeRecipe($, ctx, entry.recipe, target)
  await update($, uiAtom, (ui): StudioUi => ({ ...ui, screen: 'detail', selected: name, message: `Copied to ${shortPath(path, ctx.root ?? '', ctx.home ?? '')}` }))
  return `Copied ${name} to ${shortPath(path, await rootOf($, ctx), await homeOf($, ctx))}${target === 'project' ? ' (commit it to share it with your team)' : ''}.`
}

// ── /recipe ─────────────────────────────────────────────────────────────────────────────────────────

/** Shows the Workflows tab of the hub's panel, or this mod's own pane without the hub. */
async function showSurface($: EngineInterface): Promise<void> {
  if (await hubShowTab($, TAB)) return
  await $.ui.open({ id: PANE, title: PANE_TITLE }).catch(() => undefined)
}

async function commandText($: EngineInterface, ctx: Ctx, args: string): Promise<string> {
  const command = parseArgs(args)
  switch (command.kind) {
    case 'open': {
      const entries = await loadAll($, ctx)
      await update($, uiAtom, (ui): StudioUi => ({ ...ui, screen: ui.screen === 'edit' ? 'edit' : 'list', message: '' }))
      await showSurface($)
      return `${plural(entries.filter(entry => !entry.isShadowed).length, 'recipe')}. ${USAGE}`
    }
    case 'list':
      return listText(await loadAll($, ctx))
    case 'history': {
      const runs = await read($, runsAtom)
      return runs.length === 0 ? 'No recipe has run in this project yet.' : [...runs].reverse().map(runLine).join('\n')
    }
    case 'run': {
      const text = await runRecipe($, ctx, command.name, command.values)
      return command.extra.length > 0 ? `${text}\n(ignored: ${command.extra.join(' ')} — params are name=value)` : text
    }
    case 'show': {
      const entry = findRecipe(await loadAll($, ctx), command.name)
      if (entry === undefined) return `No recipe "${command.name}".`
      await update($, uiAtom, (ui): StudioUi => ({ ...ui, screen: 'detail', selected: entry.name, params: {}, message: '' }))
      await showSurface($)
      return detailText(entry)
    }
    case 'edit': {
      const entry = findRecipe(await loadAll($, ctx), command.name)
      if (entry === undefined) return `No recipe "${command.name}". /recipe new ${command.name} starts one.`
      if (entry.recipe === null) return `${detailText(entry)}\nFix the file by hand (${entry.path}): the editor needs a recipe that loads.`
      await startEditing($, entry, entry.recipe, 'project')
      await showSurface($)
      return `Editing ${entry.name}.`
    }
    case 'new': {
      const name = slugify(command.name)
      const entries = await loadAll($, ctx)
      if (entries.some(entry => entry.name === name && entry.source !== 'builtin')) return `${name} exists: /recipe edit ${name}.`
      await startEditing($, undefined, skeleton(name), command.isPersonal ? 'personal' : 'project')
      await showSurface($)
      return `New recipe ${name}: fill it in and press Save (it goes to ${command.isPersonal ? `~/${PERSONAL_DIR}` : PROJECT_DIR}).`
    }
    case 'copy':
      return copyRecipe($, ctx, command.name, command.isPersonal ? 'personal' : 'project')
    case 'save':
      return savePlan($, ctx, command.name, command.from, command.isPersonal ? 'personal' : 'project')
    case 'validate': {
      const entries = (await loadAll($, ctx)).filter(entry => command.name === '' || entry.name === command.name)
      if (entries.length === 0) return `No recipe "${command.name}".`
      return entries
        .map(entry => (entry.recipe === null ? `✗ ${entry.name} (${entry.path})\n${entry.errors.map(error => `  - ${error}`).join('\n')}` : `✓ ${entry.name} (${SOURCE_LABEL[entry.source]}${entry.isShadowed ? ', shadowed' : ''})`))
        .join('\n')
    }
    case 'usage':
      return `Usage: ${command.why}\n${USAGE}`
  }
}

// ── Drawing (the hub's Workflows tab and the own pane share it) ─────────────────────────────────────

type PaneInput = RenderInput<'Pane'>

async function go($: EngineInterface, screen: StudioUi['screen'], selected?: string): Promise<void> {
  await update($, uiAtom, ui => ({ ...ui, screen, ...(selected === undefined ? {} : { selected, params: selected === ui.selected ? ui.params : {} }), message: '' }))
}

function drawList($: EngineInterface, e: PaneInput, entries: readonly RecipeEntry[], ui: StudioUi, runs: readonly RecipeRun[]): RenderElement {
  const elements = $.ui.resolve(e)
  const { Box, Button, Text } = elements
  const Input = 'Input' in elements ? elements.Input : undefined
  const shown = search(entries.filter(entry => !entry.isShadowed), ui.query)
  const width = Math.max(20, e.props.bodyColumns - 30)
  return (
    <Box key="list" flexDirection="column" gap={1}>
      {Input !== undefined && <Input key="search" label="Search " value={ui.query} placeholder="name, word or tag" submitLabel="find" onInput={value => void update($, uiAtom, latest => ({ ...latest, query: value }))} onSubmit={value => void update($, uiAtom, latest => ({ ...latest, query: value }))} />}
      <Box key="rows" flexDirection="column">
        {shown.length === 0 && <Text dimColor>No recipe matches.</Text>}
        {shown.map(entry => (
          <Box key={`row-${entry.name}`} flexDirection="row" columnGap={1}>
            <Button key={`open-${entry.name}`} plain label={entry.recipe === null ? `⚠ ${entry.name}` : entry.name} onPress={() => void go($, 'detail', entry.name)} />
            <Text dimColor>
              {entry.recipe?.mode ?? 'invalid'} · {SOURCE_LABEL[entry.source]}
            </Text>
            <Box flexGrow={1}>
              <Text wrap="truncate-end" color={entry.recipe === null ? 'error' : undefined}>
                {entry.recipe === null ? `${plural(entry.errors.length, 'problem')}: ${entry.errors[0] ?? ''}` : oneLine(entry.recipe.description, width)}
              </Text>
            </Box>
          </Box>
        ))}
      </Box>
      <Box key="list-buttons" flexDirection="row" columnGap={1}>
        <Button key="new" label="New recipe" hotkey="n" onPress={() => void startEditing($, undefined, skeleton('my-recipe'), 'project')} />
        <Button key="history" label={`History (${runs.length})`} hotkey="h" onPress={() => void go($, 'history')} />
      </Box>
    </Box>
  )
}

function drawDetail($: EngineInterface, e: PaneInput, ctx: Ctx, entry: RecipeEntry, ui: StudioUi, runs: readonly RecipeRun[]): RenderElement {
  const elements = $.ui.resolve(e)
  const { Box, Button, Text } = elements
  const Input = 'Input' in elements ? elements.Input : undefined
  const recipe = entry.recipe
  const back = <Button key="back" label="Back" hotkey="b" onPress={() => void go($, 'list')} />
  if (recipe === null) {
    return (
      <Box key="detail" flexDirection="column" gap={1}>
        <Text bold color="error">
          ⚠ {entry.name} does not load
        </Text>
        <Text dimColor>{entry.path}</Text>
        <Box flexDirection="column">
          {entry.errors.map((error, index) => (
            <Text key={`err-${index}`} wrap="wrap">
              - {error}
            </Text>
          ))}
        </Box>
        {back}
      </Box>
    )
  }
  const last = [...runs].reverse().find(run => run.name === recipe.name)
  const stages = stagesOf(recipe.steps)
  return (
    <Box key="detail" flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold>
          {recipe.title ?? recipe.name} <Text dimColor>({recipe.name} · {recipe.mode} · {SOURCE_LABEL[entry.source]})</Text>
        </Text>
        <Text wrap="wrap">{recipe.description}</Text>
        {entry.source !== 'builtin' && <Text dimColor>{shortPath(entry.path, ctx.root ?? '', ctx.home ?? '')}</Text>}
      </Box>
      <Box key="steps" flexDirection="column">
        <Text bold>Steps</Text>
        {stages.map((stage, at) => (
          <Box key={`stage-${at}`} flexDirection="column">
            {recipe.mode !== 'inline' && stage.length > 1 && <Text dimColor>in parallel:</Text>}
            {stage.map(index => {
              const step = recipe.steps[index]
              return step === undefined ? null : (
                <Text key={`step-${index}`} wrap="truncate-end">
                  {recipe.mode !== 'inline' && stage.length > 1 ? '  ' : ''}
                  {index + 1}. {step.title}
                  {step.tier === undefined ? '' : ` · ${step.tier}`}
                </Text>
              )
            })}
          </Box>
        ))}
        {recipe.checks.length > 0 && <Text dimColor wrap="truncate-end">Checks: {recipe.checks.map(check => check.command).join(' · ')}</Text>}
      </Box>
      {recipe.params.length > 0 && (
        <Box key="params" flexDirection="column">
          <Text bold>Params</Text>
          {recipe.params.map(param => {
            const value = ui.params[param.name] ?? param.default ?? ''
            return Input !== undefined ? (
              <Input
                key={`param-${param.name}`}
                label={`${param.name}${param.required === true || param.default === undefined ? '*' : ''} `}
                value={value}
                placeholder={param.options?.join(' | ') ?? param.description ?? ''}
                submitLabel="set"
                onSubmit={text => void update($, uiAtom, latest => ({ ...latest, params: { ...latest.params, [param.name]: text.trim() } }))}
              />
            ) : (
              <Text key={`param-${param.name}`}>
                {param.name} = {value === '' ? '(required: run it with /recipe run)' : value}
              </Text>
            )
          })}
        </Box>
      )}
      {last !== undefined && (
        <Text dimColor wrap="truncate-end">
          Last run: {runLine(last)}
        </Text>
      )}
      <Box key="detail-buttons" flexDirection="row" columnGap={1} flexWrap="wrap">
        <Button key="run" label={recipe.mode === 'workflow' ? 'Run as workflow' : 'Run'} hotkey="r" variant="primary" onPress={() => void pressRun($, ctx, recipe.name)} />
        <Button key="edit" label="Edit" hotkey="e" onPress={() => void startEditing($, entry, recipe, 'project')} />
        {entry.source !== 'project' && <Button key="copy-project" label="Copy to project" hotkey="c" onPress={() => void copyRecipe($, ctx, recipe.name, 'project')} />}
        {entry.source === 'project' && <Button key="copy-personal" label="Copy to personal" onPress={() => void copyRecipe($, ctx, recipe.name, 'personal')} />}
        {back}
      </Box>
    </Box>
  )
}

async function pressRun($: EngineInterface, ctx: Ctx, name: string): Promise<void> {
  const { params } = await read($, uiAtom)
  const message = await runRecipe($, ctx, name, Object.fromEntries(Object.entries(params).filter(([, value]) => value !== '')))
  await update($, uiAtom, ui => ({ ...ui, message }))
}

function drawEditor($: EngineInterface, e: PaneInput, ctx: Ctx, editing: StudioEditing): RenderElement {
  const elements = $.ui.resolve(e)
  const { Box, Button, Text } = elements
  const Input = 'Input' in elements ? elements.Input : undefined
  const { recipe } = editing
  if (Input === undefined) {
    return (
      <Box key="editor" flexDirection="column">
        <Text>This surface has no text fields: edit the recipe in a terminal or the desktop app, or its file.</Text>
        <Button key="cancel-edit" label="Back" onPress={() => void update($, editingAtom, () => null).then(() => go($, 'list'))} />
      </Box>
    )
  }
  return (
    <Box key="editor" flexDirection="column" gap={1}>
      <Text bold>
        Editing {recipe.name} <Text dimColor>→ {editing.path === '' ? `${editing.target === 'project' ? PROJECT_DIR : `~/${PERSONAL_DIR}`}/${recipe.name}.yaml` : shortPath(editing.path, ctx.root ?? '', ctx.home ?? '')}</Text>
      </Text>
      <Box key="fields" flexDirection="column">
        <Input key="name" label="Name " value={recipe.name} submitLabel="set" onSubmit={value => void edit($, r => ({ ...r, name: value.trim() }))} />
        <Input key="title" label="Title " value={recipe.title ?? ''} submitLabel="set" onSubmit={value => void edit($, r => ({ ...r, title: value.trim() === '' ? undefined : value.trim() }))} />
        <Input key="description" label="Description " value={recipe.description} submitLabel="set" onSubmit={value => void edit($, r => ({ ...r, description: value.trim() }))} />
        <Input key="params" label="Params " value={paramsWords(recipe.params)} placeholder="version, channel=stable" submitLabel="set" onSubmit={value => void edit($, r => ({ ...r, params: paramsFrom(value, r.params) }))} />
        <Box key="modes" flexDirection="row" columnGap={1}>
          <Text>Mode</Text>
          {MODES.map((mode: RecipeMode) => (
            <Button key={`mode-${mode}`} label={mode} variant={recipe.mode === mode ? 'primary' : 'secondary'} onPress={() => void edit($, r => ({ ...r, mode }))} />
          ))}
        </Box>
      </Box>
      <Box key="steps" flexDirection="column">
        <Text bold>Steps</Text>
        {recipe.steps.map((step, index) => (
          <Box key={`step-${index}`} flexDirection="column">
            <Box flexDirection="row" columnGap={1}>
              <Text dimColor>{index + 1}.</Text>
              <Button key={`step-tier-${index}`} label={step.tier ?? 'tier'} onPress={() => void edit($, r => ({ ...r, steps: r.steps.map((one, at) => (at === index ? { ...one, tier: cycle(TIERS, one.tier) } : one)) }))} />
              <Button key={`step-remove-${index}`} plain label="✕" onPress={() => void edit($, r => ({ ...r, steps: r.steps.filter((_, at) => at !== index) }))} />
            </Box>
            <Input key={`step-title-${index}`} label="  Title " value={step.title} submitLabel="set" onSubmit={value => void edit($, r => ({ ...r, steps: r.steps.map((one, at) => (at === index ? { ...one, title: value.trim() } : one)) }))} />
            <Input key={`step-group-${index}`} label="  Group " value={step.group ?? ''} placeholder="same group = parallel" submitLabel="set" onSubmit={value => void edit($, r => ({ ...r, steps: r.steps.map((one, at) => (at === index ? { ...one, group: value.trim() === '' ? undefined : value.trim() } : one)) }))} />
            <Input key={`step-prompt-${index}`} label="  Prompt " value={step.prompt} submitLabel="set" onSubmit={value => void edit($, r => ({ ...r, steps: r.steps.map((one, at) => (at === index ? { ...one, prompt: value } : one)) }))} />
          </Box>
        ))}
        {recipe.steps.length < MAX_STEPS && <Button key="add-step" label="Add step" onPress={() => void edit($, r => ({ ...r, steps: [...r.steps, { title: `Step ${r.steps.length + 1}`, prompt: 'What to do.', tier: 'standard' }] }))} />}
      </Box>
      <Box key="checks" flexDirection="column">
        <Text bold>Success checks</Text>
        {recipe.checks.map((check, index) => (
          <Box key={`check-row-${index}`} flexDirection="row" columnGap={1}>
            <Input key={`check-${index}`} label={`${check.name} `} value={check.command} submitLabel="set" onSubmit={value => void edit($, r => ({ ...r, checks: r.checks.map((one, at) => (at === index ? { ...one, command: value.trim() } : one)) }))} />
            <Button key={`check-remove-${index}`} plain label="✕" onPress={() => void edit($, r => ({ ...r, checks: r.checks.filter((_, at) => at !== index) }))} />
          </Box>
        ))}
        <Input key="check-new" label="Add check " placeholder="a command that exits 0, e.g. npm test" submitLabel="add" onSubmit={value => void edit($, r => (value.trim() === '' ? r : { ...r, checks: [...r.checks, { name: oneLine(value.trim(), 40), command: value.trim() }] }))} />
      </Box>
      {editing.errors.length > 0 && (
        <Box key="errors" flexDirection="column">
          {editing.errors.map((error, index) => (
            <Text key={`error-${index}`} color="error" wrap="wrap">
              ✗ {error}
            </Text>
          ))}
        </Box>
      )}
      <Box key="edit-buttons" flexDirection="row" columnGap={1}>
        <Button key="save" label="Save" hotkey="s" variant="primary" onPress={() => void saveEditing($, ctx)} />
        <Button key="cancel-edit" label="Cancel" onPress={() => void update($, editingAtom, () => null).then(() => go($, 'list'))} />
      </Box>
    </Box>
  )
}

function drawHistory($: EngineInterface, e: PaneInput, ctx: Ctx, runs: readonly RecipeRun[], entries: readonly RecipeEntry[]): RenderElement {
  const { Box, Button, Text } = $.ui.resolve(e)
  const newest = [...runs].reverse().slice(0, 15)
  return (
    <Box key="history" flexDirection="column" gap={1}>
      <Text bold>Runs in this project</Text>
      <Box key="runs" flexDirection="column">
        {newest.length === 0 && <Text dimColor>No recipe has run here yet.</Text>}
        {newest.map(run => {
          const hasChecks = (findRecipe(entries, run.name)?.recipe?.checks.length ?? 0) > 0
          return (
            <Box key={`run-${run.id}`} flexDirection="row" columnGap={1}>
              <Text color={OUTCOME_COLOR[run.outcome]}>{runGlyph(run.outcome)}</Text>
              <Box flexGrow={1}>
                <Text wrap="truncate-end">{runLine(run).slice(2)}</Text>
              </Box>
              {run.endedAt !== null && hasChecks && <Button key={`recheck-${run.id}`} plain label="re-check" onPress={() => void recheck($, ctx, run.id)} />}
              {run.endedAt !== null && <Button key={`again-${run.id}`} plain label="again" onPress={() => void runRecipe($, ctx, run.name, run.params).then(message => update($, uiAtom, ui => ({ ...ui, message })))} />}
            </Box>
          )
        })}
      </Box>
      <Button key="back" label="Back" hotkey="b" onPress={() => void go($, 'list')} />
    </Box>
  )
}

async function drawBody($: EngineInterface, e: PaneInput, ctx: Ctx): Promise<RenderElement> {
  const { Box, Text } = $.ui.resolve(e)
  const ui = await read($, uiAtom)
  const entries = await read($, entriesAtom)
  const runs = await read($, runsAtom)
  const editing = await read($, editingAtom)
  const selected = ui.selected === null ? undefined : findRecipe(entries, ui.selected)
  const body =
    ui.screen === 'edit' && editing !== null
      ? drawEditor($, e, ctx, editing)
      : ui.screen === 'detail' && selected !== undefined
        ? drawDetail($, e, ctx, selected, ui, runs)
        : ui.screen === 'history'
          ? drawHistory($, e, ctx, runs, entries)
          : drawList($, e, entries, ui, runs)
  return (
    <Box key="studio" flexDirection="column">
      <Text bold>⚙ Workflows</Text>
      {ui.message !== '' && (
        <Text key="message" color="suggestion" wrap="wrap">
          {ui.message}
        </Text>
      )}
      <Box marginTop={1} flexDirection="column">
        {body}
      </Box>
    </Box>
  )
}

// ── Hooks ───────────────────────────────────────────────────────────────────────────────────────────

export const register: Register = on => {
  const ctx: Ctx = { root: undefined, home: undefined, isTurnRunning: false, queued: null }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'recipe',
      description: 'Reusable multi-step recipes (release, dependency update, security audit…): list, edit, run',
      argumentHint: '[list | run <name> [param=value …] | new | edit | copy | save | validate | history]',
    })
    try {
      await loadAll($, ctx)
      const stored = await $.store.get(`${HISTORY_PREFIX}${await rootOf($, ctx)}`).catch(() => undefined)
      if (Array.isArray(stored)) {
        // A run the last session left open never got its turn's end: mark it, so the history stays true.
        const runs = (stored as RecipeRun[]).map(run => (run.endedAt === null ? { ...run, outcome: 'cancelled' as const, endedAt: run.startedAt, summary: run.summary || 'the session ended first' } : run))
        await update($, runsAtom, () => runs.slice(-MAX_HISTORY))
      }
    } catch (error) {
      $.ui.log(`workflow-studio: could not load: ${messageOf(error)}`, { to: 'debug' })
    }
    await hubHello(
      $,
      { version: VERSION, publishes: ['task.queued', 'task.started', 'task.finished', 'x.workflow-studio.finished'], consumes: ['agent.finished', 'smart-router.policy'] },
      { id: TAB, title: PANE_TITLE, order: TAB_ORDER, command: 'recipe' },
    )
    return next(e)
  })

  on('command.run', { command: 'recipe' }, async ($, e) => {
    try {
      return { text: await commandText($, ctx, e.args) }
    } catch (error) {
      return { text: `Failed: ${messageOf(error)}` }
    }
  })

  on('turn.start', async ($, e, next) => {
    ctx.isTurnRunning = true
    const runs = await read($, runsAtom)
    const run = runs.find(one => one.outcome === 'running' && one.turnId === undefined && e.text.includes(one.marker))
    if (run !== undefined) await saveHistory($, ctx, changeRun(run.id, one => ({ ...one, turnId: e.turnId })))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    ctx.isTurnRunning = false
    const run = (await read($, runsAtom)).find(one => one.turnId === e.turnId && one.endedAt === null)
    if (run !== undefined) {
      const { reason, answer } = e
      $.clock.after(0, () => void settleRun($, ctx, run.id, reason, answer).catch(error => $.ui.log(`workflow-studio: ${messageOf(error)}`, { to: 'debug' })))
    }
    const queued = ctx.queued
    if (queued !== null) {
      ctx.queued = null
      $.clock.after(0, () => void send($, ctx, queued.id, queued.prompt))
    }
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawBody($, e, ctx))

  on('ui.render', { component: 'Pane', requestId: 'claude-mods' }, async ($, e, next) => {
    if (!(await hubTabIs($, TAB))) return next(e)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {await next(e)}
        {await drawBody($, e, ctx)}
      </Box>
    )
  })
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
