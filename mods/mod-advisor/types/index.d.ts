/** What a catalog entry says about where a mod fits (catalog.json `signals`, optional). */
export type AdvisorSignals = {
  /** Globs over the project's paths (`prisma/schema.prisma`, `**\/*.tf`, `.storybook/`). */
  files?: string[]
  /** Dependency names of any ecosystem (`next`, `django`, `@prisma/client`); a trailing `*` matches a prefix. */
  deps?: string[]
  /** Words and phrases of a request it helps with (`deploy`, `commit message`). */
  intents?: string[]
  /** An essential: recommended in every project. */
  always?: boolean
}

/** One mod of the catalog, as the advisor keeps it (no spec, no README). */
export type AdvisorMod = {
  name: string
  category: string
  description: string
  tier?: string
  commands?: string[]
  keywords?: string[]
  signals?: AdvisorSignals
}

export type AdvisorCategory = { id: string; title: string; tagline: string }

/** The catalog as read from GitHub, the cache or the marketplace's local copy. */
export type AdvisorCatalog = {
  version: string
  repository: string
  branch: string
  fetchedAt: number
  origin: 'github' | 'local'
  categories: AdvisorCategory[]
  mods: AdvisorMod[]
}

/** Where the catalog shown came from. */
export type AdvisorSync = { phase: 'idle' | 'syncing' | 'live' | 'offline' | 'error'; message?: string }

/** One installed plugin of the marketplace, from `claude plugin list --json`. */
export type AdvisorInstall = { version: string; scope: string; isEnabled: boolean }

export type AdvisorInstalled =
  | { isKnown: true; mods: Record<string, AdvisorInstall> }
  | { isKnown: false; error: string }

/** A recommended mod and the one line that says why. */
export type AdvisorPick = { name: string; score: number; reason: string }

/** The project's recommendations: what was detected, and the mods that fit. */
export type AdvisorFit = { root: string; stack: string[]; picks: AdvisorPick[] }

/** What the recent prompts are about: the mods that fit them. */
export type AdvisorNow = { picks: AdvisorPick[] }

/** A recommendation that appeared during this session ("New for you"). */
export type AdvisorFresh = { name: string; reason: string; at: number }

/** The band above the prompt, used while the pane is not on screen. */
export type AdvisorBand = { kind: 'fit' | 'new'; names: string[]; stack: string[] }

/** The pane's view: the search, the mod whose usage is open, the long list unfolded. */
export type AdvisorView = { query: string; howTo: string | null; isFitUnfolded: boolean }

export type AdvisorBusy = { verb: string; name: string }

export type AdvisorNotice = { tone: 'success' | 'error' | 'info'; text: string; canReload: boolean }

/** A mod's README Usage section, fetched for its How to use view. */
export type AdvisorUsage = { phase: 'loading' | 'ready' | 'missing'; text: string }

/** Whether the advisor's pane is open and placed. */
export type AdvisorPane = { isOpen: boolean; isPlaced: boolean }

declare module 'claude-code' {
  interface PluginState {
    'mod-advisor': {
      catalog: AdvisorCatalog | null
      sync: AdvisorSync
      installed: AdvisorInstalled | null
      fit: AdvisorFit | null
      now: AdvisorNow | null
      fresh: AdvisorFresh[]
      band: AdvisorBand | null
      view: AdvisorView
      busy: AdvisorBusy | null
      notice: AdvisorNotice | null
      usages: Record<string, AdvisorUsage>
      commands: Record<string, string[]>
      dismissed: string[]
      quiet: boolean
      pane: AdvisorPane
    }
  }
}
