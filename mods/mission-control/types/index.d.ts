// mission-control's shared formats: the heartbeat every session writes, the commands one session drops in
// another's inbox, the priority file other mods read, and the cockpit's own state.
// Files live in ~/.claude/claude-mods/mission/ (see README "How it works").

/** What a session is doing right now. */
export type MissionState = 'idle' | 'working' | 'waiting-permission' | 'waiting-input'

/** A session's priority: read by smart-router / autopilot from priority.json or the fact `mission-control.priority`. */
export type MissionPriority = 'high' | 'normal' | 'low'

/** sessions/<id>.json: one session's heartbeat, written by that session alone every few seconds. */
export type MissionHeartbeat = {
  v: 1
  id: string
  /** `<project>#<first 4 of the id>`: how cards and commands name the session. */
  label: string
  project: string
  /** The repository root (or the working directory outside a repository). */
  root: string
  cwd: string
  branch: string
  model: string
  surface: string
  state: MissionState
  /** When `state` last changed. */
  stateSince: number
  /** The last prompt, one line, secrets masked. */
  task: string
  /** When the running turn started; null while idle. */
  turnStartedAt: number | null
  startedAt: number
  updatedAt: number
  turns: number
  tokens: number
  usd: number
  isUsdEstimate: boolean
  /** Spend on the local day `day` (for "spend today" across sessions). */
  spend: { day: string; usd: number }
  subagents: number
  lastError: { text: string; at: number } | null
  /** Why the session cannot go on without the person, when it cannot. */
  blocked: string | null
  paused: boolean
  priority: MissionPriority
  /** Inbox command ids this session has handled (the newest 50). */
  acked: string[]
  ended: boolean
}

export type MissionCommandKind = 'pause' | 'resume' | 'stop' | 'note' | 'priority'

/** One line of inbox/<id>.jsonl: a click in some session's cockpit, for session <id>. */
export type MissionCommand = {
  id: string
  at: number
  kind: MissionCommandKind
  from: { session: string; label: string }
  text?: string
  priority?: MissionPriority
}

/** priority.json: the sessions whose priority is not normal, for smart-router / autopilot. */
export type MissionPriorityFile = {
  v: 1
  updatedAt: number
  sessions: Record<string, { priority: MissionPriority; label: string; root: string; at: number }>
}

export type MissionSort = 'status' | 'recent' | 'cost' | 'project'
export type MissionFilter = 'all' | 'working' | 'waiting' | 'idle'

/** One card of the cockpit. `isHubOnly`: known from mods-hub's sessions.json alone (no live state, no actions). */
export type MissionCard = {
  id: string
  label: string
  project: string
  branch: string
  state: MissionState
  task: string
  /** How long the turn (working) or the wait (waiting-*) has lasted, in ms; 0 while idle. */
  elapsedMs: number
  usd: number
  isUsdEstimate: boolean
  tokens: number
  subagents: number
  model: string
  priority: MissionPriority
  paused: boolean
  blocked: string | null
  lastError: string | null
  isMe: boolean
  isHubOnly: boolean
  updatedAt: number
}

export type MissionTotals = { sessions: number; working: number; waiting: number; paused: number; spendToday: number; isEstimate: boolean; longWaits: number }

export type MissionBoard = { cards: MissionCard[]; totals: MissionTotals; at: number }

export type MissionView = { sort: MissionSort; filter: MissionFilter; noteFor: string | null }

declare module 'claude-code' {
  interface PluginState {
    'mission-control': {
      board: MissionBoard
      view: MissionView
    }
  }
}
