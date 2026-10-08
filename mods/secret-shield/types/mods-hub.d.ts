// @vendored mods/mods-hub/types/index.d.ts sha256:6a9c6ec03ef2 by scripts/sync-shared.mjs: edit the source, then run `node scripts/sync-shared.mjs`; never this copy.
// The mods-hub contract: the `$.mods` noun every Claude Mod can talk to, the standard events, and the
// hub's public state. Self-contained (no import) so it can be laid beside a dependent mod by the engine
// (`"dependencies": ["mods-hub"]`) or vendored as `types/mods-hub.d.ts` by scripts/sync-shared.mjs.
// See docs/ARCHITECTURE.md and docs/MOD_CONTRACT.md.

/** JSON data, as everything crossing `$` is (one level deep in the type; the hub checks the rest at run time). */
export type ModsJson = string | number | boolean | null | readonly unknown[] | { readonly [key: string]: unknown }

/** How much a notification matters; routing is decided per level. */
export type ModsLevel = 'info' | 'success' | 'warning' | 'error' | 'critical'

/** Where the person is: at the keyboard, quiet for a while, or gone (set by timers, `/hub away` or a channel). */
export type ModsPresence = 'here' | 'idle' | 'away'

/** Whether mods may START a conversation with the person on a channel (questions, approvals). auto: only while away. */
export type ModsInteraction = 'auto' | 'on' | 'off'

/** Where one level goes: the terminal only, channels too while not here, channels always, or only the hub's inbox. */
export type ModsRoute = 'terminal' | 'away' | 'always' | 'off'

/** Who a notification is for: the person (their personal channels), the team (team channels), or the terminal alone. */
export type ModsAudience = 'me' | 'team' | 'terminal'

// ── Standard events ─────────────────────────────────────────────────────────────────────────────────

export type ModsOutcome = 'passed' | 'failed' | 'error'

/** The payload of every standard topic. A topic not listed here is published as `x.<mod>.<name>`. */
export type ModsEventMap = {
  'test.result': { runner: string; outcome: ModsOutcome; passed: number | null; failed: number | null; durationMs?: number; command?: string; failures?: string[] }
  'build.result': { tool: string; outcome: ModsOutcome; durationMs?: number; command?: string; errors?: number }
  'lint.result': { tool: string; errors: number; warnings: number; files?: string[] }
  'typecheck.result': { tool: string; errors: number; files?: string[] }
  'cost.update': { turnUsd: number; sessionUsd: number; model: string; tokens: number; isEstimate: boolean }
  'budget.threshold': { kind: 'usd' | 'tokens'; scope: 'session' | 'day' | 'week' | 'month'; used: number; limit: number; percent: number }
  'context.pressure': { percent: number; tokens: number; window: number }
  'ci.result': { provider: string; workflow: string; outcome: 'passed' | 'failed' | 'cancelled'; branch?: string; url?: string; durationMs?: number }
  'deploy.started': { target: string; environment: string; version?: string; url?: string }
  'deploy.finished': { target: string; environment: string; version?: string; url?: string; durationMs?: number }
  'deploy.failed': { target: string; environment: string; reason: string; url?: string }
  'git.commit': { sha: string; message: string; branch: string; files: number }
  'git.push': { remote: string; branch: string; isForce: boolean }
  'pr.opened': { url: string; title: string; branch: string }
  'decision.recorded': { title: string; summary?: string; path?: string; status?: string }
  'lesson.learned': { lesson: string; context?: string; path?: string }
  'error.repeated': { signature: string; count: number; tool: string; command?: string }
  'tool.failed': { tool: string; summary: string; command?: string }
  'risk.blocked': { guard: string; tool: string; reason: string; severity: 'low' | 'medium' | 'high'; command?: string; path?: string }
  'secret.detected': { kind: string; where: 'edit' | 'result' | 'prompt' | 'command'; action: 'blocked' | 'redacted' | 'warned'; path?: string }
  'agent.routed': { agentType: string; tier: 'light' | 'standard' | 'deep'; model: string; reason: string; agentId?: string }
  'agent.finished': { agentType: string; outcome: 'ok' | 'failed'; durationMs: number; agentId?: string; usd?: number }
  'turn.finished': { durationMs: number; tools: number; isAborted: boolean }
  'session.started': { project: string; cwd: string; branch?: string }
  'session.ended': { durationMs: number; turns: number; usd?: number }
  'session.idle': { since: number; reason: ModsPresenceReason }
  'session.away': { since: number; reason: ModsPresenceReason }
  'session.back': { since: number; reason: ModsPresenceReason; awayMs: number }
  'mod.recommended': { name: string; reason: string; score?: number }
  'mod.installed': { name: string; version: string }
  'screenshot.taken': { path: string; url?: string; width?: number; height?: number; purpose?: string }
  'issue.drafted': { title: string; body?: string; url?: string; labels?: string[] }
  'task.queued': { id: string; title: string }
  'task.started': { id: string; title: string }
  'task.finished': { id: string; title: string; outcome: 'ok' | 'failed' | 'cancelled' }
  'approval.requested': { id: string; question: string; tool?: string }
  'approval.answered': { id: string; answer: 'allow' | 'deny'; by: string }
  'channel.inbound': { channel: string; from: string; text: string; isOwner: boolean }
  'focus.started': { minutes: number; label?: string }
  'focus.ended': { minutes: number; isCompleted: boolean }
  'notification.sent': { level: ModsLevel; title: string; source: string; targets: string[]; held: boolean }
  /** Stop the automatic work (autopilot, task-queue, night-shift, workflows): raised by `$.mods.stop`, never published directly. */
  'control.stop': ModsControlData
  /** Pause the automatic work until a `control.resume`. */
  'control.pause': ModsControlData
  /** Lift a pause (or a stop) for what may run again. */
  'control.resume': ModsControlData
}

/**
 * A stop, pause or resume as the hub raises it. `scope: 'all'` reaches every session on this machine (through
 * `~/.claude/claude-mods/hub/control.json`, within 5 seconds); `session` only the session that asked. `session` is
 * the asking session's id, `by` who asked in words (`owner via whatsapp`), the event's `source` the mod that called.
 */
export type ModsControlData = { id: string; scope: ModsControlScope; reason: string; by: string; session: string }
export type ModsControlScope = 'session' | 'all'
export type ModsControlAction = 'stop' | 'pause' | 'resume'

export type ModsPresenceReason = 'activity' | 'timer' | 'manual' | 'channel'

/** A standard topic. */
export type ModsTopic = keyof ModsEventMap

/** What `$.mods.publish` takes: a standard topic with its payload, or a mod's own `x.<mod>.<name>` topic. */
export type ModsPublishInput =
  | { [T in ModsTopic]: { topic: T; data: ModsEventMap[T]; scope?: ModsScope } }[ModsTopic]
  | { topic: `x.${string}`; data: ModsJson; scope?: ModsScope }

/** `session`: this session's subscribers only; `global`: also written to the cross-session feed other sessions read. */
export type ModsScope = 'session' | 'global'

/** One event as the hub stamped it: who published it, when, in which session. */
export type ModsEvent = {
  id: string
  topic: string
  data: ModsJson
  /** The publishing plugin, from the engine's own origin record (never from the payload). */
  source: string
  at: number
  session: string
  scope: ModsScope
}

export type ModsPublishResult = { id: string }

// ── Notifications ───────────────────────────────────────────────────────────────────────────────────

export type ModsNotifyInput = {
  level: ModsLevel
  title: string
  body?: string
  /** Who it is for; `me` by default. */
  audience?: ModsAudience
  /** A question or approval starts a conversation: it obeys the Interaction mode. */
  kind?: 'notice' | 'question'
  /** The event it is about, so channels can thread or group it. */
  topic?: string
  /** A link the person can open (a CI run, a PR). */
  url?: string
}

/** One notification as routed: kept in the hub's inbox and handed to channels. */
export type ModsNotice = ModsNotifyInput & {
  id: string
  source: string
  at: number
  /** Where it went: `toast` and channel ids. */
  targets: string[]
  /** Held for later (night, rate limit); delivered in the next digest. */
  held: boolean
  /** Why it went nowhere, or was held. */
  reason?: string
}

export type ModsNotifyResult = { id: string; targets: string[]; held: boolean; reason?: string }

/**
 * The global mode every mod respects: read it with `$.mods.mode()` or the `mode` state.
 *
 * Fields added after the first release are optional in the type (`isNightOn`, `idleMinutes`, `awayMinutes`): the
 * hub always sets them, but a mod's vendored contract may meet a test stand-in (or an older hub) that does not.
 */
export type ModsMode = {
  presence: ModsPresence
  /** Silent: mods' toasts and sounds are held in the hub's inbox. */
  isSilent: boolean
  /** When Silent ends by itself; null while it is off or on with no end (until switched off). */
  silentUntil: number | null
  /** Night: inside quiet hours now (and the schedule is on); sounds off, only critical reaches channels, the rest waits for the morning digest. */
  isNight: boolean
  /** Whether the Night schedule is on at all (`isNight` is whether it applies right now). */
  isNightOn?: boolean
  quietHours: string
  /** Minutes without activity before presence turns `idle`, and `away` (the hub's settings). */
  idleMinutes?: number
  awayMinutes?: number
  interaction: ModsInteraction
  /** Whether a mod may ask the person something on a channel right now (Interaction × presence × night). */
  canAsk: boolean
}

/** Settings shared by every session (~/.claude/claude-mods/hub/prefs.json), changed from the Home tab or `/hub`. */
export type ModsPrefs = {
  interaction: ModsInteraction
  silentUntil: number | null
  isSilent: boolean
  isNightOn: boolean
  quietHours: string
  /** `auto` follows activity; `away`/`here` set by the person or a channel until the next activity. */
  presence: 'auto' | 'away' | 'here'
  routes: Record<ModsLevel, ModsRoute>
  /** Per channel: off switch and the lowest level it carries. */
  channels: Record<string, { isEnabled: boolean; minLevel: ModsLevel }>
}

/**
 * A change of the global mode; absent fields stay as they are.
 *
 * Silent: `isSilent: true` turns it on with no end (until switched off), or for `silentMinutes` when that is a
 * positive number too; `isSilent: false` turns it off. Without `isSilent`, `silentMinutes: n > 0` is Silent for n
 * minutes and `silentMinutes: null` (or ≤ 0) is off, as before `isSilent` existed.
 */
export type ModsSetModeInput = { interaction?: ModsInteraction; isSilent?: boolean; silentMinutes?: number | null; isNightOn?: boolean; quietHours?: string }

// ── Panel, channels, discovery, shared facts ────────────────────────────────────────────────────────

/** A tab of the shared "Claude Mods" panel. Its owner draws the body (see MOD_CONTRACT.md). */
export type ModsTab = { id: string; title: string; owner: string; order: number; command?: string }
/** How the shared panel is folded: the tab bar's More row (terminal and mobile) and the channel whose setup help is open. */
export type ModsPanelView = { isMoreOpen: boolean; openChannel: string | null }
export type ModsTabInput = { id: string; title: string; order?: number; command?: string }

export type ModsChannelStatus = 'connected' | 'connecting' | 'disconnected' | 'error' | 'unconfigured'

/** A connector (whatsapp, telegram, slack, discord, email, desktop ...) the router can deliver to. */
export type ModsChannel = {
  id: string
  title: string
  owner: string
  audience: 'me' | 'team'
  /** push: the owner answers `mods.deliver` (needs `dependencies: ["mods-hub"]`); pull: it drains `$.mods.drain()`. */
  delivery: 'push' | 'pull'
  status: ModsChannelStatus
  detail?: string
}
export type ModsChannelInput = Omit<ModsChannel, 'owner'>

export type ModsDeliverInput = { channel: string; notice: ModsNotice }

/**
 * What a pull channel's owner asks `$.mods.drain` for. `after` is the channel's cursor: the id of the last notice
 * the owner handled (null on its first call). The hub drops every notice up to and including it and returns the
 * ones still waiting, oldest first, WITHOUT removing them: a notice comes back until a later drain acknowledges it
 * (at-least-once; dedupe by `id`). Without `after` (the first contract), what is returned is removed at once.
 */
export type ModsDrainInput = { channel: string; after?: string | null }

/** What `$.mods.stop` takes: `action` defaults to `stop`, `scope` to `session`; `by` defaults to the calling mod. */
export type ModsStopInput = { action?: ModsControlAction; scope?: ModsControlScope; reason: string; by?: string }

/** The stop, pause or resume in force (the `control` state): the last one raised, here or in another session. */
export type ModsControl = ModsControlData & { action: ModsControlAction; source: string; at: number }
export type ModsDeliverResult = { isDelivered: boolean; reason?: string }

/** A mod that said hello this session, and what it trades on the bus. */
export type ModsHello = { name: string; version: string; publishes: string[]; consumes: string[] }
export type ModsHelloInput = { version: string; publishes?: string[]; consumes?: string[] }

/** One installed plugin, from `claude plugin list --json`. */
export type ModsInstall = { name: string; marketplace: string; version: string; isEnabled: boolean }
export type ModsInstalled = { hello: ModsHello[]; plugins: ModsInstall[]; listedAt: number | null }

/** A fact a mod shares on the blackboard, keyed `<owner>.<name>` (`smart-router.policy`). */
export type ModsFact = { key: string; owner: string; value: ModsJson; at: number }

export type ModsRecentInput = { topic?: string; prefix?: string; since?: number; limit?: number }

/**
 * `$.mods`: every method is an event `mods.<method>` that runs through all plugins' hooks, the hub's
 * included. Calls from a mod without the hub installed throw (TypeError): wrap them (hub-client region).
 */
export type Mods = {
  /** Publish an event to every subscriber; the hub stamps source, time and session. */
  publish: (input: ModsPublishInput) => Promise<ModsPublishResult>
  /** The last events, newest last (topic exact, or prefix like `deploy.`); this session's. */
  recent: (input: ModsRecentInput) => Promise<ModsEvent[]>
  /** The latest event of a topic, or null. */
  latest: (input: { topic: string }) => Promise<ModsEvent | null>
  /** Route a notification to the terminal and the person's channels, respecting presence, silent, night and interaction. */
  notify: (input: ModsNotifyInput) => Promise<ModsNotifyResult>
  /** The global mode. */
  mode: () => Promise<ModsMode>
  /** Change the global mode (a channel's "/silent 30", the Home tab). */
  setMode: (input: ModsSetModeInput) => Promise<ModsMode>
  /** Say the person is away or back (`auto` returns to activity tracking). */
  setPresence: (input: { presence: 'auto' | 'away' | 'here'; reason?: ModsPresenceReason }) => Promise<ModsMode>
  /** Add a tab to the shared panel (owner = the calling plugin). */
  registerTab: (input: ModsTabInput) => Promise<{ tabs: ModsTab[] }>
  /** Open the panel on a tab; call it from a command the person typed so the pane is placed at any width. */
  showTab: (input: { id: string }) => Promise<{ isPlaced: boolean }>
  /** Register (or update) a connector channel. */
  registerChannel: (input: ModsChannelInput) => Promise<{ channels: ModsChannel[] }>
  /** Update a channel's status line. */
  channelStatus: (input: { id: string; status: ModsChannelStatus; detail?: string }) => Promise<{ channels: ModsChannel[] }>
  /** Raised BY the hub for each push channel; the channel's owner answers `{ value: { isDelivered } }`. */
  deliver: (input: ModsDeliverInput) => Promise<ModsDeliverResult>
  /** For pull channels (owner only): the notices waiting, oldest first; pass `after` (your cursor) to acknowledge. */
  drain: (input: ModsDrainInput) => Promise<ModsNotice[]>
  /** Stop, pause or resume the automatic work in this session or all sessions; raises `control.<action>`. */
  stop: (input: ModsStopInput) => Promise<ModsControl>
  /** Announce the calling mod and what it trades on the bus. */
  hello: (input: ModsHelloInput) => Promise<{ installed: ModsInstalled }>
  /** Capability discovery: the mods that said hello and the installed plugins. */
  installed: () => Promise<ModsInstalled>
  /** Put a fact on the blackboard under `<caller>.<name>`. */
  share: (input: { name: string; value: ModsJson }) => Promise<ModsFact>
  /** Read a fact by its full key. */
  read: (input: { key: string }) => Promise<ModsFact | null>
}

declare module 'claude-code' {
  interface EngineInterface {
    mods: Mods
  }
  interface PluginState {
    'mods-hub': {
      /** The derived global mode (render reads subscribe). */
      mode: ModsMode
      prefs: ModsPrefs
      /** The shared panel's active tab (`home` or a registered tab id). */
      tab: string
      tabs: ModsTab[]
      /** The panel's folds (More open, a channel's setup help open); this session's alone. */
      view: ModsPanelView
      channels: ModsChannel[]
      /** The latest event per topic, the member id being the topic. */
      latest: StateFamily<ModsEvent | null>
      /** Blackboard facts, the member id being the full key. */
      facts: StateFamily<ModsFact | null>
      /** The last events of this session, newest last. */
      feed: ModsEvent[]
      /** The last notifications (theirs, and other mods' captured toasts), newest last. */
      inbox: ModsNotice[]
      installed: ModsInstalled
      /** Notices waiting for each pull channel (secrets masked), by channel id, until its owner drains them. */
      outbox: Record<string, ModsNotice[]>
      /** The last stop, pause or resume (this session's, or another session's with scope `all`); null before any. */
      control: ModsControl | null
    }
  }
}
