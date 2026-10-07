/** One screenshot: the PNG on disk, its viewport, and a small JPEG for surfaces that cannot open files. */
export type ScreenshotCheckShot = {
  name: 'desktop' | 'mobile'
  file: string
  width: number
  height: number
  thumb: { base64: string; width: number; height: number } | null
}

/** A capture of a page at desktop and mobile widths, with what the browser reported. */
export type ScreenshotCheckCapture = {
  url: string
  at: number
  /** `project`: the project's own Playwright (errors and thumbnails); `cli`: `npx playwright screenshot`. */
  runner: 'project' | 'cli'
  status: number | null
  title: string
  consoleErrors: string[]
  pageErrors: string[]
  shots: ScreenshotCheckShot[]
}

/** What the Screenshots pane shows. */
export type ScreenshotCheckView = {
  phase: 'capturing' | 'ready' | 'error'
  url: string
  /** Why it was taken: `/screenshot`, or the files an edit touched. */
  reason: string
  capture: ScreenshotCheckCapture | null
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'screenshot-check': { view: ScreenshotCheckView | null; shown: 'desktop' | 'mobile' | 'both' }
  }
}
