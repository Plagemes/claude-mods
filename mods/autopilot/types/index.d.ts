/** What a success criterion checks; every kind but `command` is suggested from the project. */
export type AutopilotCriterionKind = 'tests' | 'lint' | 'typecheck' | 'build' | 'command'

/** One run of a criterion's command, as autopilot ran it itself. */
export type AutopilotCheck = {
  ok: boolean
  at: number
  durationMs: number
  /** null when the command could not start or timed out. */
  exitCode: number | null
  /** One line: `✗ 2 failed · 10 passed`, `exit 1`, `timed out after 300s`. */
  summary: string
  /** The end of what it printed, for the next prompt (ANSI removed, capped). */
  output: string
}

/** A command that must exit 0 for the goal to count as reached. */
export type AutopilotCriterion = {
  id: string
  kind: AutopilotCriterionKind
  label: string
  command: string
  isOn: boolean
  last?: AutopilotCheck
}

/** Whether Claude may stop to ask: follow the hub's Interaction mode, always ask when blocked, or never ask. */
export type AutopilotInteraction = 'hub' | 'ask' | 'never'

/** The setup card, before a run starts. */
export type AutopilotDraft = {
  goal: string
  criteria: AutopilotCriterion[]
  isBudgetOn: boolean
  budgetUsd: number
  isTimeOn: boolean
  maxMinutes: number
  interaction: AutopilotInteraction
  allowWorkflow: boolean
  /** The hub's Interaction mode when the card opened; null without mods-hub. */
  hubInteraction: 'auto' | 'on' | 'off' | null
  /** Why Start was refused, shown on the card. */
  error: string
}

/** running: driving turns; paused: waiting for Resume; blocked: waiting for an answer; the rest are over. */
export type AutopilotStatus = 'running' | 'paused' | 'blocked' | 'succeeded' | 'failed' | 'stopped'

/** plan: asked for the plan; execute: working through it; fix: feeding failed checks back. */
export type AutopilotPhase = 'plan' | 'execute' | 'fix'

export type AutopilotEntryKind =
  | 'start'
  | 'plan'
  | 'step'
  | 'check'
  | 'fix'
  | 'escalate'
  | 'blocked'
  | 'question'
  | 'pause'
  | 'resume'
  | 'done'
  | 'stop'
  | 'error'

/** One row of the run's timeline. */
export type AutopilotEntry = { at: number; kind: AutopilotEntryKind; text: string; ok?: boolean }

/** The turn autopilot submitted and is waiting on; `marker` is the tag its prompt ends with. */
export type AutopilotAwait = {
  kind: 'plan' | 'step' | 'fix' | 'answer'
  marker: string
  submittedAt: number
  turnId?: string
  isEscalated: boolean
}

export type AutopilotRun = {
  id: string
  goal: string
  project: string
  criteria: AutopilotCriterion[]
  /** null: no cap. */
  budgetUsd: number | null
  maxMinutes: number | null
  maxTurns: number
  maxFailures: number
  /** Interaction off: Claude never asks; it states assumptions and parks questions. */
  neverAsk: boolean
  allowWorkflow: boolean
  status: AutopilotStatus
  phase: AutopilotPhase
  steps: string[]
  /** The step to run next (execute), from 0. */
  stepIndex: number
  /** Turns submitted so far. */
  turns: number
  /** Failed check rounds (or failed turns) in a row. */
  failuresInRow: number
  /** The next fix prompt asks for a stronger model and harder thinking. */
  escalateNext: boolean
  spentUsd: number
  startedAt: number
  /** Running time before the current stretch (paused and blocked time do not count). */
  activeMs: number
  /** When the current running stretch began; null while not running. */
  runningSince: number | null
  awaiting: AutopilotAwait | null
  /** Checks are running (survives a reload, so they run again). */
  isChecking: boolean
  /** Questions Claude parked instead of asking (interaction off), newest last. */
  questions: string[]
  assumptions: string[]
  /** The question that blocked the run, while blocked. */
  blockedQuestion: string
  /** The approval id published for the blocked question, when the hub carried it. */
  approvalId: string
  /** Your answer to the blocking question, sent as the next prompt; null when none is waiting. */
  pendingAnswer: string | null
  /** Set to end the run once the current turn finishes (a cap, a stop). */
  stopAfterTurn: string
  /** Why it paused or ended. */
  reason: string
  timeline: AutopilotEntry[]
  endedAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    autopilot: {
      draft: AutopilotDraft | null
      run: AutopilotRun | null
    }
  }
}
