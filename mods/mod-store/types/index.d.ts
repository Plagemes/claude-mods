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

/** What the pane shows: the search, the filter, the open mod and the page. */
export type StoreView = { query: string; filter: string; selected: string | null; page: number }

/** The action running now, drawn as a busy line. */
export type StoreBusy = { name: string; verb: string }

/** The last action's outcome, drawn above the list until dismissed. */
export type StoreNotice = { tone: 'success' | 'error' | 'info'; text: string; canReload: boolean }

/** A mod's README, fetched when its detail view opens. */
export type StoreReadme = { phase: 'loading' | 'ready' | 'missing'; text: string }

declare module 'claude-code' {
  interface PluginState {
    'mod-store': {
      catalog: StoreCatalog | null
      sync: StoreSync
      installed: StoreInstalled | null
      view: StoreView
      busy: StoreBusy | null
      notice: StoreNotice | null
      readmes: Record<string, StoreReadme>
    }
  }
}
