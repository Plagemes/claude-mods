/** A field (or an input value) of a GraphQL type. */
export type GraphqlContextField = {
  name: string
  /** `(id: ID!, first: Int = 10)`, or '' without arguments. */
  args: string
  /** `[Post!]!` */
  type: string
}

/** A named type of the schema. */
export type GraphqlContextType = {
  kind: 'type' | 'input' | 'enum' | 'interface' | 'union' | 'scalar'
  name: string
  fields: GraphqlContextField[]
  /** Enum values. */
  values: string[]
  /** Union members. */
  members: string[]
  implements: string[]
}

/** The schema as last loaded from the project. */
export type GraphqlContextSchema = {
  /** Where it was read from, relative to the project root. */
  files: string[]
  roots: { query: string; mutation: string; subscription: string }
  types: GraphqlContextType[]
  loadedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'graphql-context': {
      schema: GraphqlContextSchema | null
      /** Why no schema could be read, when one was looked for and none was. */
      problem: string | null
      /** Whether this conversation has been given the schema already. */
      isGiven: boolean
      /** Set by the pane: hand the schema over with the next prompt. */
      isQueued: boolean
      filter: string
    }
  }
}
