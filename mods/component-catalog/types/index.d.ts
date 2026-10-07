/** One prop a component takes, as its source declares it. */
export type ComponentCatalogProp = {
  name: string
  /** The declared type, when the source states one (`'primary' | 'ghost'`). */
  type?: string
  isOptional?: boolean
}

/** One UI component found in the project. */
export type ComponentCatalogEntry = {
  name: string
  /** The file, relative to the project root. */
  path: string
  /** One line: the JSDoc summary or the comment above it; '' when none. */
  purpose: string
  props: ComponentCatalogProp[]
  framework: 'react' | 'vue' | 'svelte' | 'angular'
}

/** The last scan of the component folders. */
export type ComponentCatalogScan = {
  components: ComponentCatalogEntry[]
  /** The component folders that exist, relative to the root. */
  dirs: string[]
  files: number
  scannedAt: number
  /** True when the walk stopped at its file cap. */
  isCut: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'component-catalog': {
      scan: ComponentCatalogScan | null
      isScanning: boolean
      query: string
      /** The system prompt section as last composed, refreshed between turns. */
      section: string | null
    }
  }
}
