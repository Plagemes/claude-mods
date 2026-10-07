/** One line of code that collects, stores or sends personal data. */
export type DataMapHit = {
  /** The signal it matched: a data item (`email`), a store (`database`) or a third party (`Stripe`). */
  signal: string
  kind: 'data' | 'storage' | 'third-party'
  file: string
  line: number
  text: string
}

/** What the /data-map pane draws. */
export type DataMapView = {
  phase: 'idle' | 'scanning' | 'organising' | 'done' | 'error'
  project: string
  /** The Markdown table (and notes) the model organised, or the local fallback. */
  markdown: string
  /** True when the model could not answer and the table was built locally. */
  isFallback: boolean
  counts: { hits: number; files: number; items: number; stores: number; thirdParties: number }
  savedTo: string | null
  message: string
}

declare module 'claude-code' {
  interface PluginState {
    'data-map': { view: DataMapView }
  }
}
