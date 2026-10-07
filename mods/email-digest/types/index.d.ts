/** What the preview pane shows and the person can change in it. */
export type DigestView = {
  /** idle, or the work in progress: building the preview, sending. */
  phase: 'idle' | 'building' | 'sending'
  period: 'daily' | 'weekly'
  tone: 'client' | 'manager' | 'technical'
  language: 'en' | 'it'
  project: string
  subject: string
  /** The plain-text body, as it would be sent (secrets already masked). */
  preview: string
  isEmpty: boolean
  recipients: string[]
  invalid: string[]
  /** What stops a send ('' when ready): a missing key, sender or recipient. */
  problem: string
  /** The last action's outcome. */
  message: string
  messageTone: 'success' | 'error' | 'info'
  schedule: string
  provider: string
  lastSent: { at: number; period: string; count: number } | null
  isEditing: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'email-digest': {
      view: DigestView
      isLeader: boolean
    }
  }
}
