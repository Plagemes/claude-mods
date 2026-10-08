/** How urgent a message to the phone is: critical goes at once, normal when away, info waits for the digest. */
export type WaPriority = 'critical' | 'normal' | 'info'

/** The automatic updates and features the owner can switch on and off. */
export type WaEventKey =
  | 'longTurn'
  | 'turnFailed'
  | 'toolErrors'
  | 'tests'
  | 'ci'
  | 'budget'
  | 'sessionEnd'
  | 'briefing'
  | 'evening'
  | 'permissions'
  | 'liveStatus'
  | 'confirmPrompts'
  | 'memberQuestions'
  | 'bugReports'
  | 'uiPreviews'
  | 'visualReports'

/**
 * Interaction is whether Claude may start a conversation with the phone (questions, confirmations,
 * approvals). `auto` follows the off-hours schedule, `night` is off until the schedule's morning.
 */
export type WaInteraction = 'auto' | 'on' | 'off' | 'night'

/** Shared preferences every session reads (prefs.json), changed from the pane, /wa or the phone. */
export type WaPrefs = {
  paused: boolean
  presence: 'auto' | 'away' | 'here'
  interaction: WaInteraction
  /** When `night` interaction ends (ms epoch). */
  nightUntil: number
  events: Record<WaEventKey, boolean>
  quietHours: string
  awayMinutes: number
}

export type WaPhase =
  | 'unconfigured'
  | 'unreachable'
  | 'no-key'
  | 'admin-key'
  | 'no-session'
  | 'starting'
  | 'qr'
  | 'ready'
  | 'disconnected'
  | 'error'

/** The OpenWA link as this session last saw it. */
export type WaConnection = {
  phase: WaPhase
  /** One friendly line about the phase ("OpenWA isn't running"). */
  detail: string
  /** The raw error behind it, for a dim, truncated line; '' when there is none. */
  raw: string
  phone: string
  /** The linking QR as base64 PNG, while the session waits to be linked. */
  qr: string
  /** The same QR as module rows (`1` dark), decoded from the PNG for an SVG or block drawing; [] when not decodable. */
  qrModules: string[]
  pairingCode: string
  /** `bot`: a dedicated number; `self`: the owner's own number is linked. */
  mode: 'bot' | 'self' | 'unknown'
  checkedAt: number
  isLeader: boolean
}

/** One live Claude Code session in the shared registry (sessions/<id>.json). */
export type WaSessionInfo = {
  id: string
  project: string
  root: string
  branch: string
  label: string
  lastSeen: number
  lastActiveAt: number
  state: 'idle' | 'working'
  task: string
  costUsd: number
  startedAt: number
  turns: number
  ended: boolean
}

/** One line of a session's log (log/<id>.jsonl): what came in, went out, was held or dropped. */
export type WaLogEntry = {
  at: number
  dir: 'in' | 'out' | 'held' | 'drop' | 'note'
  chatId: string
  session: string
  kind: string
  text: string
  messageId?: string
  who?: 'owner' | 'member' | 'bot'
}

/** A project's WhatsApp group (groups.json, keyed by project root). */
export type WaGroupLink = {
  groupId: string
  name: string
  inviteLink: string
  members: number
  createdAt: number
}

/** What the pane shows about this project's group, or why there is none. */
export type WaGroupCard = {
  link: WaGroupLink | null
  note: string
  choices: { id: string; name: string }[]
}

/** A group member's question (or bug report) and what happened to it. */
export type WaMemberQa = {
  at: number
  member: string
  question: string
  answer: string
  outcome: 'answered' | 'limited' | 'failed' | 'bug-draft' | 'bug-filed'
}

/**
 * Where the guided setup stands. `checking` docker; `no-docker` / `docker-off` the prerequisite is missing;
 * `ready` to start; `pulling` the image, `booting` the server, `provisioning` its WhatsApp session and scoped key;
 * `running` the server answers (linking then follows the connection); `elsewhere` another session is starting it;
 * `failed` the last attempt failed (see `note`).
 */
export type WaSetupStep = 'idle' | 'checking' | 'no-docker' | 'docker-off' | 'ready' | 'pulling' | 'booting' | 'provisioning' | 'running' | 'elsewhere' | 'failed'

/** The guided setup in the Status tab. */
export type WaSetup = {
  step: WaSetupStep
  /** One short line for the step. */
  note: string
  /** Raw output behind it (docker's error, the last pull line), dim and truncated. */
  raw: string
  /** Docker's server version once checked; '' unknown. */
  docker: string
  /** Who runs the server: this session started it, another did, or the user runs it ('external'); '' unknown. */
  owner: 'this' | 'other' | 'external' | ''
  /** Start the managed server by itself when a session starts and nothing answers (the user's opt-in). */
  autoStart: boolean
  /** The "I run it myself" form (URL and key) is open. */
  isManual: boolean
  /** The OpenWA API in use. */
  baseUrl: string
}

export type WaTab = 'status' | 'chat' | 'settings' | 'privacy' | 'log'

/** The privacy card: the allowlist in force and a redaction preview. */
export type WaPrivacy = { allowlist: string[]; sample: string; redacted: string }

declare module 'claude-code' {
  interface PluginState {
    'whatsapp-bridge': {
      tab: WaTab
      connection: WaConnection
      setup: WaSetup
      group: WaGroupCard
      sessions: WaSessionInfo[]
      conversation: WaLogEntry[]
      prefs: WaPrefs
      privacy: WaPrivacy
      audit: WaLogEntry[]
      members: WaMemberQa[]
    }
  }
}
