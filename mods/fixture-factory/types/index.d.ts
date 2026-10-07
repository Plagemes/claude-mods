/** What kind of definition the records follow. */
export type FixtureFactoryKind = 'prisma' | 'typescript' | 'zod' | 'python' | 'sql' | 'go' | 'rust'

/** The fixtures being made or shown in the pane. */
export type FixtureFactoryDraft = {
  phase: 'generating' | 'ready' | 'error'
  name: string
  count: number
  kind: FixtureFactoryKind
  /** Where the definition is, relative to the project: `prisma/schema.prisma:12`. */
  source: string
  definition: string
  /** Enums and models the definition refers to, from the same file. */
  related: string[]
  /** Other definitions with the same name, `path:line` each. */
  alternatives: string[]
  /** The records as pretty JSON, and the head of it the pane shows. */
  json: string
  preview: string
  recordCount: number
  warning: string | null
  error: string | null
  /** Where Save writes, relative to the project. */
  target: string
  savedTo: string | null
  /** Set after a first Save press on a file that exists: the next press replaces it. */
  isReplacing: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'fixture-factory': { draft: FixtureFactoryDraft | null; isDefinitionShown: boolean }
  }
}
