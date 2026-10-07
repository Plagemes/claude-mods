/** Whether Claude may start a conversation: the hub's Interaction switch, or this mod's own when no hub answers. */
export type BrInteraction = 'auto' | 'on' | 'off'

/** This mod's own switches, shared by every session (prefs.json). The hub's mode wins whenever it answers. */
export type BrPrefs = {
  /** Mutes this channel (critical messages still go). */
  paused: boolean
  /** Only read without a hub: `auto` follows the keyboard, `away` / `here` are set by hand. */
  presence: 'auto' | 'away' | 'here'
  interaction: BrInteraction
  /** Ask "Run this?" with buttons before a prompt from the phone starts a turn. */
  confirmPrompts: boolean
}

/** What this session knows of the person's presence and Interaction: from the hub, or computed from `BrPrefs`. */
export type BrMode = {
  source: 'hub' | 'own'
  presence: 'here' | 'idle' | 'away'
  isSilent: boolean
  isNight: boolean
  interaction: BrInteraction
  canAsk: boolean
}

export type BrPhase = 'unconfigured' | 'no-owner' | 'connecting' | 'ready' | 'error'

/** The bot link as this session last saw it. */
export type BrConnection = { phase: BrPhase; detail: string; bot: string; checkedAt: number; isLeader: boolean }

/** One live Claude Code session in the shared registry (sessions/<id>.json). */
export type BrSessionInfo = {
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

/** One line of a session's log (log/<id>.jsonl): what came in, went out or was dropped. */
export type BrLogEntry = {
  at: number
  dir: 'in' | 'out' | 'drop'
  chatId: string
  session: string
  kind: string
  text: string
  who?: 'owner' | 'member' | 'bot'
}

/** A project's group chat (groups.json, keyed by project root). */
export type BrGroupLink = { chatId: string; title: string; linkedAt: number }

/** A chat the bot was added to or heard from: only its id, title and kind are kept (never what was said). */
export type BrChatSeen = { id: string; title: string; kind: string }

/** A group member's question and what happened to it. */
export type BrMemberQa = { at: number; member: string; question: string; answer: string; outcome: 'answered' | 'limited' | 'failed' }

declare module 'claude-code' {
  interface PluginState {
    'telegram-bridge': {
      connection: BrConnection
      sessions: BrSessionInfo[]
      conversation: BrLogEntry[]
      prefs: BrPrefs
      mode: BrMode
      groups: BrGroupLink[]
      members: BrMemberQa[]
    }
  }
}
