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
}

/** The whole catalog as fetched from GitHub (and cached in $.store). */
export type StoreCatalog = {
  /** The marketplace's own name (`claude-mods`): what `<mod>@<marketplace>` names. */
  marketplace: string
  repository: string
  branch: string
  fetchedAt: number
  categories: StoreCategory[]
  mods: StoreMod[]
  /** The newest release any mod came with, when not every mod did: what "New" means. */
  newest?: string
}

/** One installed plugin of the marketplace, from `claude plugin list --json`. */
export type StoreInstall = { version: string; scope: string; isEnabled: boolean }

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
export type StoreView = { query: string; category: string; status: string; selected: string | null; page: number }

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
export type StoreNotice = { tone: 'success' | 'error' | 'info'; text: string; canReload: boolean; retry?: { action: 'install' | 'update'; names: string[] } }

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
    }
  }
}
