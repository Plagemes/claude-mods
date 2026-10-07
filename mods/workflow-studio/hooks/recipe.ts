// Recipes, pure (no `$`): the schema and its friendly errors, reading a file, filling params, the prompt a run
// sends, and turning an autopilot or /route plan into a recipe.

import type { Recipe, RecipeCheck, RecipeEntry, RecipeMode, RecipeParam, RecipeRun, RecipeSource, RecipeStep, RecipeTier } from '../types'
import { YamlError, parseYaml, stringifyYaml } from './yaml'

export const MODES: readonly RecipeMode[] = ['inline', 'parallel', 'workflow']
export const TIERS: readonly RecipeTier[] = ['light', 'standard', 'deep']
export const MAX_STEPS = 20
const MAX_CHECKS = 10
const MAX_PARAMS = 12
const MAX_DESCRIPTION = 500
const MAX_PROMPT = 8000
const NAME = /^[a-z0-9][a-z0-9-]{1,39}$/
const PARAM_NAME = /^[A-Za-z_][\w-]{0,31}$/
const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g
/** Values every recipe can use without declaring them. */
export const BUILTIN_VARS = ['project', 'date', 'branch'] as const
const FIELDS = ['name', 'title', 'description', 'mode', 'params', 'steps', 'checks', 'tags'] as const
const STEP_FIELDS = ['title', 'prompt', 'tier', 'group'] as const
const PARAM_FIELDS = ['name', 'description', 'default', 'required', 'options'] as const
const CHECK_FIELDS = ['name', 'command'] as const

export const oneLine = (text: string, width = 120): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > width ? `${line.slice(0, Math.max(1, width - 1))}…` : line
}

/** A recipe name from free text: `Release v2!` → `release-v2`. */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug.length >= 2 ? slug : `recipe-${slug || 'new'}`
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** The closest known word, for "did you mean". */
function closest(word: string, known: readonly string[]): string | undefined {
  const distance = (a: string, b: string): number => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i)
    for (let i = 1; i <= a.length; i += 1) {
      let previous = row[0] ?? 0
      row[0] = i
      for (let j = 1; j <= b.length; j += 1) {
        const kept = row[j] ?? 0
        row[j] = Math.min((row[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
        previous = kept
      }
    }
    return row[b.length] ?? 0
  }
  const best = known.map(candidate => ({ candidate, d: distance(word.toLowerCase(), candidate) })).sort((x, y) => x.d - y.d)[0]
  return best !== undefined && best.d <= 2 ? best.candidate : undefined
}

function unknownFields(value: Record<string, unknown>, known: readonly string[], where: string, errors: string[]): void {
  for (const key of Object.keys(value)) {
    if (known.includes(key)) continue
    const guess = closest(key, known)
    errors.push(`${where}${where === '' ? '' : '.'}${key}: unknown field${guess === undefined ? ` (fields: ${known.join(', ')})` : ` — did you mean "${guess}"?`}`)
  }
}

const textOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined)

/** Every `{{name}}` in a text. */
export const placeholdersIn = (text: string): string[] => [...text.matchAll(PLACEHOLDER)].map(match => match[1] ?? '')

/**
 * Checks a parsed file against the recipe schema. Returns the recipe (defaults filled in) when it is valid, and
 * every problem as `field: what is wrong` otherwise, so one look fixes them all.
 */
export function validateRecipe(raw: unknown): { recipe: Recipe | null; errors: string[] } {
  const errors: string[] = []
  if (!isRecord(raw)) return { recipe: null, errors: ['the file must be a mapping of fields (name, description, steps, …), not a list or a single value'] }
  unknownFields(raw, FIELDS, '', errors)

  const name = textOf(raw.name)?.trim() ?? ''
  if (name === '') errors.push('name: required (2–40 lowercase letters, digits and dashes, e.g. dependency-update)')
  else if (!NAME.test(name)) errors.push(`name: "${name}" must be 2–40 lowercase letters, digits and dashes (try "${slugify(name)}")`)

  const title = raw.title === undefined || raw.title === null ? undefined : textOf(raw.title)?.trim()
  if (raw.title !== undefined && raw.title !== null && title === undefined) errors.push('title: must be text')

  const description = textOf(raw.description)?.trim() ?? ''
  if (description === '') errors.push('description: required (one or two sentences: what the recipe does)')
  else if (description.length > MAX_DESCRIPTION) errors.push(`description: too long (${description.length} characters, at most ${MAX_DESCRIPTION})`)

  let mode: RecipeMode = 'inline'
  if (raw.mode !== undefined && raw.mode !== null) {
    const word = textOf(raw.mode)?.trim().toLowerCase() ?? ''
    const found = MODES.find(one => one === word)
    if (found === undefined) errors.push(`mode: "${String(raw.mode)}" is not one of ${MODES.join(', ')}`)
    else mode = found
  }

  const params: RecipeParam[] = []
  if (raw.params !== undefined && raw.params !== null) {
    if (!Array.isArray(raw.params)) errors.push('params: must be a list (- name: version)')
    else {
      if (raw.params.length > MAX_PARAMS) errors.push(`params: at most ${MAX_PARAMS}`)
      raw.params.forEach((item, index) => {
        const where = `params[${index + 1}]`
        const value = typeof item === 'string' ? { name: item } : item
        if (!isRecord(value)) return void errors.push(`${where}: must be a name or a mapping (name, description, default, required, options)`)
        unknownFields(value, PARAM_FIELDS, where, errors)
        const paramName = textOf(value.name)?.trim() ?? ''
        if (!PARAM_NAME.test(paramName)) return void errors.push(`${where}.name: "${paramName}" must start with a letter and use letters, digits, _ or -`)
        if (params.some(param => param.name === paramName)) return void errors.push(`${where}.name: "${paramName}" is declared twice`)
        if ((BUILTIN_VARS as readonly string[]).includes(paramName)) return void errors.push(`${where}.name: "${paramName}" is built in ({{${paramName}}} is always there)`)
        const param: RecipeParam = { name: paramName }
        if (value.description !== undefined && value.description !== null) param.description = textOf(value.description) ?? ''
        if (value.default !== undefined && value.default !== null) {
          const fallback = textOf(value.default)
          if (fallback === undefined) errors.push(`${where}.default: must be text or a number`)
          else param.default = fallback
        }
        if (value.required !== undefined && value.required !== null) {
          if (typeof value.required !== 'boolean') errors.push(`${where}.required: must be true or false`)
          else param.required = value.required
        }
        if (value.options !== undefined && value.options !== null) {
          const options = Array.isArray(value.options) ? value.options.map(textOf) : undefined
          if (options === undefined || options.some(option => option === undefined) || options.length === 0) errors.push(`${where}.options: must be a list of values, e.g. [patch, minor, major]`)
          else {
            param.options = options as string[]
            if (param.default !== undefined && !param.options.includes(param.default)) errors.push(`${where}.default: "${param.default}" is not one of its options (${param.options.join(', ')})`)
          }
        }
        params.push(param)
      })
    }
  }

  const steps: RecipeStep[] = []
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) errors.push('steps: required, a list of at least one step (- title: …, prompt: …)')
  else {
    if (raw.steps.length > MAX_STEPS) errors.push(`steps: at most ${MAX_STEPS} (${raw.steps.length} given)`)
    raw.steps.forEach((item, index) => {
      const where = `steps[${index + 1}]`
      const value = typeof item === 'string' ? { prompt: item } : item
      if (!isRecord(value)) return void errors.push(`${where}: must be a prompt or a mapping (title, prompt, tier, group)`)
      unknownFields(value, STEP_FIELDS, where, errors)
      const prompt = textOf(value.prompt)?.trim() ?? ''
      if (prompt === '') return void errors.push(`${where}.prompt: required (what Claude or the step's agent should do)`)
      if (prompt.length > MAX_PROMPT) errors.push(`${where}.prompt: too long (${prompt.length} characters, at most ${MAX_PROMPT})`)
      const step: RecipeStep = { title: oneLine(textOf(value.title)?.trim() || prompt.split('\n')[0] || prompt, 60), prompt }
      if (value.tier !== undefined && value.tier !== null) {
        const word = textOf(value.tier)?.trim().toLowerCase() ?? ''
        const tier = TIERS.find(one => one === word) ?? ({ haiku: 'light', sonnet: 'standard', opus: 'deep' } as Record<string, RecipeTier>)[word]
        if (tier === undefined) errors.push(`${where}.tier: "${String(value.tier)}" is not one of ${TIERS.join(', ')}`)
        else step.tier = tier
      }
      if (value.group !== undefined && value.group !== null) {
        const group = textOf(value.group)?.trim()
        if (group === undefined || group === '') errors.push(`${where}.group: must be a short name; steps next to each other with the same group run in parallel`)
        else step.group = group
      }
      steps.push(step)
    })
  }

  const checks: RecipeCheck[] = []
  if (raw.checks !== undefined && raw.checks !== null) {
    if (!Array.isArray(raw.checks)) errors.push('checks: must be a list (- name: Tests, command: npm test)')
    else {
      if (raw.checks.length > MAX_CHECKS) errors.push(`checks: at most ${MAX_CHECKS}`)
      raw.checks.forEach((item, index) => {
        const where = `checks[${index + 1}]`
        const value = typeof item === 'string' ? { command: item } : item
        if (!isRecord(value)) return void errors.push(`${where}: must be a command or a mapping (name, command)`)
        unknownFields(value, CHECK_FIELDS, where, errors)
        const command = textOf(value.command)?.trim() ?? ''
        if (command === '') return void errors.push(`${where}.command: required (a shell command that exits 0 when all is well)`)
        checks.push({ name: textOf(value.name)?.trim() || oneLine(command, 40), command })
      })
    }
  }

  let tags: string[] | undefined
  if (raw.tags !== undefined && raw.tags !== null) {
    if (!Array.isArray(raw.tags) || raw.tags.some(tag => textOf(tag) === undefined)) errors.push('tags: must be a list of words, e.g. [release, git]')
    else tags = raw.tags.map(tag => String(tag))
  }

  const known = new Set<string>([...params.map(param => param.name), ...BUILTIN_VARS])
  const declared = params.length === 0 ? 'none declared' : `params: ${params.map(param => param.name).join(', ')}`
  steps.forEach((step, index) => {
    for (const used of placeholdersIn(step.prompt)) if (!known.has(used)) errors.push(`steps[${index + 1}].prompt: {{${used}}} is not a param (${declared})`)
  })
  checks.forEach((check, index) => {
    for (const used of placeholdersIn(check.command)) if (!known.has(used)) errors.push(`checks[${index + 1}].command: {{${used}}} is not a param (${declared})`)
  })
  const groups = steps.map(step => step.group).filter((group): group is string => group !== undefined)
  for (const group of new Set(groups)) {
    const at = steps.flatMap((step, index) => (step.group === group ? [index] : []))
    if (at.some((index, i) => i > 0 && index !== (at[i - 1] ?? 0) + 1)) errors.push(`steps: the steps of group "${group}" must be next to each other`)
  }

  if (errors.length > 0) return { recipe: null, errors }
  const recipe: Recipe = { name, ...(title === undefined || title === '' ? {} : { title }), description, mode, params, steps, checks, ...(tags === undefined ? {} : { tags }) }
  return { recipe, errors: [] }
}

/** Reads a recipe file's text (YAML, or JSON for .json) and validates it. */
export function readRecipe(text: string, path: string): { recipe: Recipe | null; errors: string[] } {
  let raw: unknown
  try {
    raw = /\.json$/i.test(path) ? JSON.parse(text) : parseYaml(text)
  } catch (error) {
    if (error instanceof YamlError) return { recipe: null, errors: [`YAML ${error.message}`] }
    return { recipe: null, errors: [`not valid ${/\.json$/i.test(path) ? 'JSON' : 'YAML'}: ${error instanceof Error ? error.message : String(error)}`] }
  }
  return validateRecipe(raw)
}

/** A recipe as the file the studio writes: fields in a fixed order, empty optional fields left out. */
export function recipeText(recipe: Recipe): string {
  const ordered: Record<string, unknown> = {
    name: recipe.name,
    ...(recipe.title === undefined ? {} : { title: recipe.title }),
    description: recipe.description,
    mode: recipe.mode,
    ...(recipe.tags === undefined || recipe.tags.length === 0 ? {} : { tags: recipe.tags }),
    ...(recipe.params.length === 0 ? {} : { params: recipe.params }),
    steps: recipe.steps.map(step => ({ title: step.title, ...(step.tier === undefined ? {} : { tier: step.tier }), ...(step.group === undefined ? {} : { group: step.group }), prompt: step.prompt })),
    ...(recipe.checks.length === 0 ? {} : { checks: recipe.checks }),
  }
  return stringifyYaml(ordered)
}

/** Which recipe each name means: project wins over personal, personal over built-in. */
export function markShadowed(entries: readonly RecipeEntry[]): RecipeEntry[] {
  const rank: Record<RecipeSource, number> = { project: 0, personal: 1, builtin: 2 }
  const winner = new Map<string, RecipeEntry>()
  for (const entry of entries) {
    const current = winner.get(entry.name)
    if (current === undefined || rank[entry.source] < rank[current.source]) winner.set(entry.name, entry)
  }
  return entries
    .map(entry => ({ ...entry, isShadowed: winner.get(entry.name) !== entry }))
    .sort((a, b) => a.name.localeCompare(b.name) || rank[a.source] - rank[b.source])
}

/** The recipe `name` resolves to (the winning valid one). */
export const findRecipe = (entries: readonly RecipeEntry[], name: string): RecipeEntry | undefined =>
  entries.find(entry => entry.name === name && !entry.isShadowed)

/** Entries whose name, title, description or tags hold every word of the query. */
export function search(entries: readonly RecipeEntry[], query: string): RecipeEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...entries]
  return entries.filter(entry => {
    const hay = [entry.name, entry.recipe?.title ?? '', entry.recipe?.description ?? '', ...(entry.recipe?.tags ?? []), entry.source].join(' ').toLowerCase()
    return words.every(word => hay.includes(word))
  })
}

// ── Params ─────────────────────────────────────────────────────────────────────────────────────────

/** `version=1.2.0 notes="first stable"` → `{ version: '1.2.0', notes: 'first stable' }`; words that are no pair are returned apart. */
export function parsePairs(text: string): { values: Record<string, string>; rest: string[] } {
  const values: Record<string, string> = {}
  const rest: string[] = []
  for (const match of text.matchAll(/([A-Za-z_][\w-]*)=(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S*))|"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
    if (match[1] !== undefined) values[match[1]] = (match[2] ?? match[3] ?? match[4] ?? '').replace(/\\(.)/g, '$1')
    else rest.push(match[5] ?? match[6] ?? '')
  }
  return { values, rest }
}

export type Filled = { values: Record<string, string>; problems: string[] }

/** The params' values: given, else the default; a missing required one, or a value outside its options, is a problem. */
export function resolveParams(recipe: Recipe, given: Record<string, string>, builtins: Record<(typeof BUILTIN_VARS)[number], string>): Filled {
  const values: Record<string, string> = { ...builtins }
  const problems: string[] = []
  for (const key of Object.keys(given)) {
    if (!recipe.params.some(param => param.name === key)) problems.push(`"${key}" is not a param of ${recipe.name}${recipe.params.length === 0 ? ' (it has none)' : ` (params: ${recipe.params.map(param => param.name).join(', ')})`}`)
  }
  for (const param of recipe.params) {
    const value = (given[param.name] ?? '').trim() || param.default
    if (value === undefined || value === '') {
      if (param.required === true || (param.default === undefined && param.required !== false)) problems.push(`${param.name} is required${param.description === undefined ? '' : ` (${param.description})`}: ${param.name}=…`)
      values[param.name] = ''
      continue
    }
    if (param.options !== undefined && !param.options.includes(value)) problems.push(`${param.name} must be one of ${param.options.join(', ')} (got "${value}")`)
    values[param.name] = value
  }
  return { values, problems }
}

/** Replaces each `{{name}}` with its value. */
export const fill = (template: string, values: Record<string, string>): string => template.replace(PLACEHOLDER, (whole, name: string) => values[name] ?? whole)

// ── The prompt a run sends ─────────────────────────────────────────────────────────────────────────

/** Steps in run order: neighbours that share a group form one stage; any other step is a stage of its own. */
export function stagesOf(steps: readonly RecipeStep[]): number[][] {
  const stages: number[][] = []
  steps.forEach((step, index) => {
    const last = stages[stages.length - 1]
    const previous = last === undefined ? undefined : steps[last[last.length - 1] ?? -1]
    if (last !== undefined && step.group !== undefined && previous?.group === step.group) last.push(index)
    else stages.push([index])
  })
  return stages
}

export const DEFAULT_MODELS: Record<RecipeTier, string> = { light: 'haiku', standard: 'sonnet', deep: 'opus' }

const indent = (text: string): string => text.replace(/\n/g, '\n     ')

export type RunPromptOptions = { values: Record<string, string>; models: Record<RecipeTier, string>; marker: string }

/** What Run sends as your own words: precise steps for the recipe's mode, the checks, and the run's tag. */
export function runPrompt(recipe: Recipe, opts: RunPromptOptions): string {
  const title = recipe.title ?? recipe.name
  const shown = recipe.params.filter(param => (opts.values[param.name] ?? '') !== '')
  const lines = [`Run the recipe "${title}" (workflow-studio · ${recipe.name}).`, fill(recipe.description, opts.values)]
  if (shown.length > 0) lines.push('', `Parameters: ${shown.map(param => `${param.name} = ${opts.values[param.name]}`).join(', ')}`)
  const stepLine = (index: number, withModel: boolean): string[] => {
    const step = recipe.steps[index]
    if (step === undefined) return []
    const tier = step.tier ?? 'standard'
    const model = withModel ? ` — ${tier}, model: ${opts.models[tier]}` : step.tier === undefined ? '' : ` (${step.tier})`
    return [`  ${index + 1}. ${fill(step.title, opts.values)}${model}`, `     ${indent(fill(step.prompt, opts.values))}`]
  }

  if (recipe.mode === 'inline') {
    lines.push('', 'Do these steps yourself, in order, in this conversation. Hand a step to a subagent only when it is self-contained and read-heavy.', '', 'Steps:')
    recipe.steps.forEach((_, index) => lines.push(...stepLine(index, false)))
  } else {
    if (recipe.mode === 'workflow') {
      lines.push(
        '',
        'I explicitly opt in: run this recipe as a workflow with the Workflow tool (I pressed Run on a workflow recipe in workflow-studio).',
        'In the script: one agent() per step with opts.model set as listed, parallel() for the steps of one stage, the stages in order, then the success checks. Integrate the results when it finishes.',
      )
    } else {
      lines.push(
        '',
        'Run the steps with subagents. The steps of one stage are independent: send all their Agent calls in ONE message, and start a stage only when the one before has finished. Set each agent\'s model as listed.',
        'Start every parallel agent\'s prompt with the same shared context block (the goal and the parameters), then its own step. You coordinate: integrate the results and do not redo the agents\' work.',
      )
    }
    stagesOf(recipe.steps).forEach((stage, at) => {
      lines.push('', `Stage ${at + 1}${at === 0 ? '' : ` (after stage ${at})`}${stage.length > 1 ? ` — ${stage.length} in parallel` : ''}:`)
      for (const index of stage) lines.push(...stepLine(index, true))
    })
  }
  if (recipe.checks.length > 0) {
    lines.push('', 'Success checks: run them at the end and report each as PASS or FAIL (I will run them again myself):')
    for (const check of recipe.checks) lines.push(`- ${check.name}: \`${fill(check.command, opts.values)}\``)
  }
  lines.push('', 'End with a short summary: what changed, what passed, and anything left for me.', '', opts.marker)
  return lines.join('\n')
}

// ── Saving a plan as a recipe ──────────────────────────────────────────────────────────────────────

/** What autopilot leaves in ~/.claude/claude-mods/autopilot/last-plan.json after a successful run. */
export type AutopilotPlan = { goal: string; steps: string[]; checks: { name: string; command: string }[]; allowWorkflow?: boolean; finishedAt?: string }

/** smart-router's /route plan, the parts a recipe needs. */
export type RoutePlan = { task: string; mode: string; subtasks: { title: string; tier: string; prompt: string }[]; stages: number[][] }

export function fromAutopilot(plan: AutopilotPlan, name: string): Recipe {
  return {
    name,
    title: oneLine(plan.goal, 60),
    description: oneLine(`Autopilot's plan for: ${plan.goal}`, MAX_DESCRIPTION),
    mode: 'inline',
    params: [],
    steps: plan.steps.slice(0, MAX_STEPS).map(step => ({ title: oneLine(step, 60), prompt: step, tier: 'standard' as const })),
    checks: plan.checks.slice(0, MAX_CHECKS).map(check => ({ name: check.name, command: check.command })),
  }
}

export function fromRoute(plan: RoutePlan, name: string): Recipe {
  const groupOf = new Map<number, string>()
  plan.stages.forEach((stage, at) => {
    if (stage.length > 1) for (const index of stage) groupOf.set(index, `stage-${at + 1}`)
  })
  const order = plan.stages.flat().filter(index => plan.subtasks[index] !== undefined)
  const steps = (order.length === plan.subtasks.length ? order : plan.subtasks.map((_, index) => index)).slice(0, MAX_STEPS).map(index => {
    const subtask = plan.subtasks[index] as RoutePlan['subtasks'][number]
    const tier = TIERS.find(one => one === subtask.tier)
    const group = groupOf.get(index)
    return { title: oneLine(subtask.title, 60), prompt: subtask.prompt, ...(tier === undefined ? {} : { tier }), ...(group === undefined ? {} : { group }) }
  })
  const mode: RecipeMode = plan.mode === 'workflow' ? 'workflow' : plan.mode === 'inline' ? 'inline' : 'parallel'
  return { name, title: oneLine(plan.task, 60), description: oneLine(`Planned by /route: ${plan.task}`, MAX_DESCRIPTION), mode, params: [], steps, checks: [] }
}

/** A new recipe's skeleton for the editor. */
export function skeleton(name: string): Recipe {
  return {
    name,
    description: 'What this recipe does, in one sentence.',
    mode: 'inline',
    params: [{ name: 'target', description: 'What to work on', default: '.' }],
    steps: [{ title: 'First step', prompt: 'Describe the first step. Use {{target}} for the param.', tier: 'standard' }],
    checks: [],
  }
}

// ── /recipe arguments and texts ────────────────────────────────────────────────────────────────────

export type StudioCommand =
  | { kind: 'open' }
  | { kind: 'list' }
  | { kind: 'history' }
  | { kind: 'run'; name: string; values: Record<string, string>; extra: string[] }
  | { kind: 'show'; name: string }
  | { kind: 'edit'; name: string }
  | { kind: 'new'; name: string; isPersonal: boolean }
  | { kind: 'copy'; name: string; isPersonal: boolean }
  | { kind: 'save'; name: string; from: 'auto' | 'autopilot' | 'route'; isPersonal: boolean }
  | { kind: 'validate'; name: string }
  | { kind: 'usage'; why: string }

export const USAGE = '/recipe [list | run <name> [param=value …] | show <name> | new <name> | edit <name> | copy <name> [--personal] | save [name] [--from autopilot|route] [--personal] | validate [name] | history]'

export function parseArgs(args: string): StudioCommand {
  const text = args.trim()
  if (text === '') return { kind: 'open' }
  const [head = '', ...words] = text.split(/\s+/)
  const word = head.toLowerCase()
  const tail = text.slice(head.length).trim()
  const isPersonal = /(?:^|\s)--?personal\b/.test(tail)
  const plain = tail.replace(/(?:^|\s)--?personal\b/g, '').trim()
  const first = plain.split(/\s+/)[0] ?? ''
  if (words.length === 0 && (word === 'list' || word === 'ls')) return { kind: 'list' }
  if (words.length === 0 && word === 'history') return { kind: 'history' }
  if (word === 'run') {
    if (first === '') return { kind: 'usage', why: 'which recipe? /recipe run <name> [param=value …]' }
    const { values, rest } = parsePairs(plain.slice(first.length))
    return { kind: 'run', name: first, values, extra: rest }
  }
  if (word === 'show' || word === 'edit' || word === 'validate') {
    if (first === '' && word !== 'validate') return { kind: 'usage', why: `which recipe? /recipe ${word} <name>` }
    return word === 'show' ? { kind: 'show', name: first } : word === 'edit' ? { kind: 'edit', name: first } : { kind: 'validate', name: first }
  }
  if (word === 'new' || word === 'copy') {
    if (first === '') return { kind: 'usage', why: `which name? /recipe ${word} <name>` }
    return word === 'new' ? { kind: 'new', name: first, isPersonal } : { kind: 'copy', name: first, isPersonal }
  }
  if (word === 'save') {
    const from = /--from\s+(autopilot|route)\b/.exec(plain)?.[1] as 'autopilot' | 'route' | undefined
    const name = plain.replace(/--from\s+\S+/, '').trim().split(/\s+/)[0] ?? ''
    return { kind: 'save', name, from: from ?? 'auto', isPersonal }
  }
  // `/recipe release version=1.2.0` runs it.
  const { values, rest } = parsePairs(text.slice(head.length))
  return { kind: 'run', name: head, values, extra: rest }
}

const GLYPH: Record<RecipeRun['outcome'], string> = { queued: '…', running: '▶', checking: '⧗', passed: '✓', failed: '✗', done: '✓', cancelled: '■' }
export const runGlyph = (outcome: RecipeRun['outcome']): string => GLYPH[outcome]

const two = (n: number): string => String(n).padStart(2, '0')

/** `10-07 14:05`, local time. */
export function when(ms: number): string {
  const day = new Date(ms)
  return `${two(day.getMonth() + 1)}-${two(day.getDate())} ${two(day.getHours())}:${two(day.getMinutes())}`
}

/** `45s`, `12m`, `2h 5m`. */
export function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function runLine(run: RecipeRun): string {
  const params = Object.entries(run.params).map(([key, value]) => `${key}=${value}`).join(' ')
  const checks = run.checks.length === 0 ? '' : ` · checks ${run.checks.filter(check => check.ok).length}/${run.checks.length}`
  const length = run.endedAt === null ? '' : ` · ${span(run.endedAt - run.startedAt)}`
  return `${runGlyph(run.outcome)} ${when(run.startedAt)} ${run.name}${params === '' ? '' : ` ${params}`} · ${run.outcome}${length}${checks}${run.agents === null ? '' : ` · ${run.agents} agents`}`
}

export function listText(entries: readonly RecipeEntry[]): string {
  if (entries.length === 0) return 'No recipes yet.'
  return entries
    .filter(entry => !entry.isShadowed)
    .map(entry => (entry.recipe === null ? `⚠ ${entry.name} (${entry.source}) — ${entry.errors.length} problem${entry.errors.length === 1 ? '' : 's'}: /recipe validate ${entry.name}` : `${entry.name} · ${entry.recipe.mode} · ${entry.source} — ${oneLine(entry.recipe.description, 80)}`))
    .join('\n')
}

export function detailText(entry: RecipeEntry): string {
  const recipe = entry.recipe
  if (recipe === null) return [`⚠ ${entry.name} (${entry.path}) does not load:`, ...entry.errors.map(error => `- ${error}`)].join('\n')
  return [
    `${recipe.title ?? recipe.name} (${recipe.name} · ${recipe.mode} · ${entry.source}${entry.source === 'builtin' ? '' : ` · ${entry.path}`})`,
    recipe.description,
    ...(recipe.params.length === 0 ? [] : [`Params: ${recipe.params.map(param => `${param.name}${param.default === undefined ? '' : `=${param.default}`}${param.required === true ? ' (required)' : ''}`).join(', ')}`]),
    ...recipe.steps.map((step, index) => `${index + 1}. ${step.title}${step.tier === undefined ? '' : ` [${step.tier}]`}${step.group === undefined ? '' : ` {${step.group}}`}`),
    ...(recipe.checks.length === 0 ? [] : [`Checks: ${recipe.checks.map(check => check.command).join(' · ')}`]),
  ].join('\n')
}
