/** A package whose license needs a look: copyleft, unknown or not an SPDX id. */
export type SbomReviewItem = {
  name: string
  version: string
  ecosystem: 'npm' | 'pypi' | 'cargo' | 'golang'
  license: string | undefined
  class: 'permissive' | 'weak copyleft' | 'copyleft' | 'other' | 'unknown'
}

/** The counts the pane draws. */
export type SbomCounts = {
  total: number
  dev: number
  byEcosystem: Partial<Record<SbomReviewItem['ecosystem'], number>>
  /** Each license and how many packages carry it, most first. */
  licenses: [string, number][]
  classes: Record<SbomReviewItem['class'], number>
  review: SbomReviewItem[]
}

/** The SBOM pane: the last scan and what it wrote. */
export type SbomView = {
  phase: 'idle' | 'scanning' | 'done'
  project: string
  /** The lockfiles read, relative to the project root. */
  sources: string[]
  counts: SbomCounts | null
  /** The document last written: its format label and path relative to the root. */
  written: { label: string; path: string } | null
  /** What went wrong or was left out (a lockfile that did not parse, lookups capped). */
  notes: string[]
}

declare module 'claude-code' {
  interface PluginState {
    sbom: { view: SbomView }
  }
}
