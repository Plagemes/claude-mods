/** How hard a step is: a hint for the model it runs on (light → haiku, standard → sonnet, deep → opus). */
export type RecipeTier = 'light' | 'standard' | 'deep'

/** inline: Claude does the steps itself; parallel: subagents, a group's steps at once; workflow: the Workflow tool. */
export type RecipeMode = 'inline' | 'parallel' | 'workflow'

export type RecipeParam = {
  name: string
  description?: string
  /** Used when the run gives no value; a param with no default and `required` must be given. */
  default?: string
  required?: boolean
  /** The only values it takes, when set. */
  options?: string[]
}

export type RecipeStep = {
  title: string
  /** A prompt template: `{{param}}` is replaced by the param's value. */
  prompt: string
  tier?: RecipeTier
  /** Steps next to each other with the same group run in parallel (one stage). */
  group?: string
}

/** A command that must exit 0 for the run to count as passed. */
export type RecipeCheck = { name: string; command: string }

/** A reusable multi-step job, as stored in a .yaml/.yml/.json file. */
export type Recipe = {
  name: string
  title?: string
  description: string
  mode: RecipeMode
  params: RecipeParam[]
  steps: RecipeStep[]
  checks: RecipeCheck[]
  tags?: string[]
}

/** project: .claude/recipes (shared through git); personal: ~/.claude/claude-mods/recipes; builtin: shipped. */
export type RecipeSource = 'project' | 'personal' | 'builtin'

/** One recipe file as found: its recipe when valid, the friendly errors when not. */
export type RecipeEntry = {
  name: string
  source: RecipeSource
  path: string
  recipe: Recipe | null
  errors: string[]
  /** A recipe of the same name in a source that wins (project over personal over built-in). */
  isShadowed: boolean
}

export type RecipeRunOutcome = 'queued' | 'running' | 'checking' | 'passed' | 'failed' | 'done' | 'cancelled'

export type RecipeCheckResult = { name: string; command: string; ok: boolean; summary: string }

/** One run of a recipe, kept in the history. */
export type RecipeRun = {
  id: string
  name: string
  title: string
  mode: RecipeMode
  source: RecipeSource
  params: Record<string, string>
  startedAt: number
  endedAt: number | null
  outcome: RecipeRunOutcome
  /** The tag its prompt ends with, so its turn is told apart. */
  marker: string
  turnId?: string
  checks: RecipeCheckResult[]
  /** Subagents that finished during the run (from the hub's agent.finished), when the hub is there. */
  agents: number | null
  summary: string
}

export type StudioScreen = 'list' | 'detail' | 'edit' | 'history'

/** What the panel shows: the screen, the search, the selected recipe and its param values, a message. */
export type StudioUi = {
  screen: StudioScreen
  query: string
  selected: string | null
  params: Record<string, string>
  message: string
}

/** The simple field editor's working copy. */
export type StudioEditing = {
  /** The file it was opened from (saving writes there), or '' for a new recipe. */
  path: string
  target: 'project' | 'personal'
  recipe: Recipe
  errors: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'workflow-studio': {
      entries: RecipeEntry[]
      ui: StudioUi
      editing: StudioEditing | null
      runs: RecipeRun[]
    }
  }
}
