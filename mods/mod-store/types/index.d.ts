/** One category of the collection, as catalog.json lists it. */
export type StoreCategory = { id: string; title: string; tagline: string }

/** One mod the marketplace offers, merged with its catalog.json metadata. */
export type StoreMod = {
  name: string
  description: string
  version: string
  category: string
  keywords: string[]
  tier?: string
  author?: string
  /** The mod's folder in the repository (`mods/<name>`), when its source is relative. */
  path?: string
  /** The release that brought the mod (`2.0.0`), from catalog.json or the site's data. */
  since?: string
  /** The slash commands it registers (`/mods`), from the site's data. */
  commands?: string[]
  /** What tells a project needs it (catalog.json `signals`): files or globs present, dependencies, always on. */
  signals?: StoreSignals
}

/** A mod's project signals, from catalog.json: globs whose presence calls for it, dependencies, phrases people ask with, always on. */
export type StoreSignals = { files?: string[]; deps?: string[]; intents?: string[]; always?: boolean }

/** A curated bundle of mods (catalog.json `packs`), shown in the store's home in place of a bare Install all. */
export type StorePack = { id: string; title: string; tagline: string; mods: string[] }

/** The whole catalog as fetched from GitHub (and cached in $.store). */
export type StoreCatalog = {
  /** The marketplace's own name (`claude-mods`): what `<mod>@<marketplace>` names. */
  marketplace: string
  repository: string
  branch: string
  fetchedAt: number
  categories: StoreCategory[]
  mods: StoreMod[]
  /** The curated packs, members limited to mods of this catalog; empty when the repository defines none. */
  packs?: StorePack[]
  /** The newest release any mod came with, when not every mod did: what "New" means. */
  newest?: string
}

/** One installed plugin of the marketplace, from `claude plugin list --json`. */
export type StoreInstall = { version: string; scope: string; isEnabled: boolean; installedAt?: number }

/** What the store knows about installed mods, by mod name. */
export type StoreInstalled =
  | { isKnown: true; mods: Record<string, StoreInstall> }
  | { isKnown: false; error: string }

/** Where the catalog shown came from. */
export type StoreSync = {
  phase: 'idle' | 'syncing' | 'live' | 'offline' | 'error'
  message?: string
}

/**
 * Where the person is in the pane: the search, the category and status pickers, the open mod and the page.
 * Only the person's own presses and typing write it; a job never does, so navigation is never undone by one.
 */
export type StoreView = {
  query: string
  category: string
  status: string
  selected: string | null
  page: number
  /** The screen shown: the list (with a mod's page when `selected`), a review plan, or a pack. */
  screen?: 'list' | 'plan' | 'pack'
  /** The pack open on the pack screen. */
  pack?: string | null
  /** The plan screen's tab (what will be disabled, or kept) and its page. */
  planTab?: 'disable' | 'keep'
  planPage?: number
}

/** One mod of a review plan: whether it stays enabled (the person can flip it), and why the store proposes that. */
export type StorePlanRow = {
  name: string
  /** Enabled after Apply: the store's proposal until the person flips it. */
  keep: boolean
  /** What the store proposed (the tab the row is listed under, so a flip never moves it). */
  proposed: boolean
  /** Enabled now. */
  isEnabled: boolean
  reason: string
  /** Always kept unless the person ticks it: always-on, core and safety mods. */
  isProtected: boolean
}

/**
 * A proposal waiting for the person's Apply: a project profile (which mods this project needs, written to the
 * project's `.claude/settings.local.json`) or a slim (mods idle for `days`, disabled at user scope through the CLI).
 */
export type StorePlan = {
  kind: 'profile' | 'slim'
  /** The project root the profile is for (a slim's is the root it was made from). */
  root: string
  createdAt: number
  rows: StorePlanRow[]
  /** What the evidence covered: `days` idle threshold, transcripts read and skipped, days of history seen. */
  days?: number
  scanned?: number
  skipped?: number
  historyDays?: number
}

/**
 * The action running now (one at a time), drawn as the progress bar: what it does, the mod it is on, how far it
 * is, how many failed so far, and whether the person asked it to stop.
 */
export type StoreJob = {
  verb: string
  title: string
  current: string
  done: number
  total: number
  failed: number
  isStopping: boolean
}

/** The last action's outcome, drawn above the list until dismissed; `retry` names the mods a Retry would install again. */
export type StoreNotice = {
  tone: 'success' | 'error' | 'info'
  text: string
  canReload: boolean
  retry?: { action: 'install' | 'update'; names: string[] }
  /** The last Apply can be undone from the notice. */
  canUndo?: boolean
  /** Many mods were just installed: the notice offers a project profile. */
  canProfile?: boolean
}

/** One setting of a mod, from its manifest's `userConfig`. */
export type StoreConfigRow = { key: string; default: string; description: string }

/** A mod's README, fetched when its detail view opens. */
export type StoreReadme = { phase: 'loading' | 'ready' | 'missing'; text: string }

declare module 'claude-code' {
  interface PluginState {
    'mod-store': {
      catalog: StoreCatalog | null
      sync: StoreSync
      installed: StoreInstalled | null
      nav: StoreView
      job: StoreJob | null
      notice: StoreNotice | null
      readmes: Record<string, StoreReadme>
      configs: Record<string, StoreConfigRow[]>
      picks: string[]
      plan: StorePlan | null
    }
  }
}
