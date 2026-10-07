import { atom, read, update } from 'claude-code'
import type { CommandRunResult, EngineInterface, PromptOrigin, Register, Timer } from 'claude-code'

import { bar, bump, emptyPending, emptyProgress, localDate, merge, noteActiveDay, noteLanguage, noteToolCall, raise, readProgress, settleDays, statsOf, unlockReached } from './progress'
import type { Pending, Progress } from './progress'
import { ACHIEVEMENTS, GROUPS, bashCounts, isPluginInstall, languageOf, reportsFailure, testRunnerOf } from './table'
import type { Achievement, SumCounter } from './table'

type Dollar = EngineInterface
/** A change to the progress, applied once it is loaded: `now` and the local `day` it happened. */
type Change = (progress: Progress, pending: Pending, now: number, day: string) => void
/** What this load keeps between events: the progress, what to save, and this session's own tallies. */
type Tracker = {
  memory: Progress | null
  loading: Promise<Progress> | null
  pending: Pending
  saveTimer: Timer | null
  saving: Promise<void>
  sessionFiles: Set<string>
  failingRunners: Set<string>
  lastChecklist: string
}
type Settings = { isSoundOn: boolean }

const PANE = 'achievements'
const PANE_TITLE = 'Achievements'
const STORE_KEY = 'progress'
const SOUND = { asset: 'assets/unlock.wav' } as const
const SAVE_DELAY_MS = 2_000
const TOAST_MS = 6_000
const DEEP_WORK_MS = 10 * 60_000
const CHECKLIST_ITEMS = 5
const CARD_COLUMNS = 30
const CARD_GAP = 1
const BAR_CELLS = 10
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const AGENT_TOOLS = new Set(['Agent', 'Task'])
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])
const FILTER_ALL = 'all'
const FILTER_UNLOCKED = 'unlocked'
const FILTER_LOCKED = 'locked'

const progressState = atom({ plugin: 'achievements', key: 'progress' } as const, null)
const viewState = atom({ plugin: 'achievements', key: 'view' } as const, { filter: FILTER_ALL })

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const isPerson = (origin: PromptOrigin): boolean => PERSON_ORIGINS.has(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)

function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} days ago`
}

// ── Progress: loaded once, changed in memory, saved merged ──────────────────

async function progressOf($: Dollar, tracker: Tracker): Promise<Progress> {
  if (tracker.memory !== null) return tracker.memory
  tracker.loading ??= (async () => {
    let stored: unknown
    try {
      stored = await $.store.get(STORE_KEY)
    } catch {
      stored = undefined
    }
    const progress = readProgress(stored)
    tracker.memory ??= progress
    return tracker.memory
  })()

  return tracker.loading
}

/** Writes this session's progress merged into what the store holds now; one save at a time. */
function save($: Dollar, tracker: Tracker): Promise<void> {
  tracker.saveTimer?.cancel()
  tracker.saveTimer = null
  const run = tracker.saving.then(async () => {
    if (tracker.memory === null) return
    const sending = tracker.pending
    tracker.pending = emptyPending()
    try {
      const stored = readProgress(await $.store.get(STORE_KEY))
      const merged = merge(stored, tracker.memory, sending)
      await $.store.set(STORE_KEY, merged)
      tracker.memory = merge(merged, tracker.memory, tracker.pending)
    } catch (error) {
      for (const [counter, by] of Object.entries(sending.sums)) {
        tracker.pending.sums[counter as SumCounter] = (tracker.pending.sums[counter as SumCounter] ?? 0) + by
      }
      for (const [day, counts] of Object.entries(sending.daily)) {
        const known = tracker.pending.daily[day] ?? { tools: 0, errors: 0 }
        tracker.pending.daily[day] = { tools: known.tools + counts.tools, errors: known.errors + counts.errors }
      }
      throw error
    }
    await update($, progressState, () => tracker.memory)
  })
  tracker.saving = run.catch(() => undefined)

  return run
}

function scheduleSave($: Dollar, tracker: Tracker, delayMs: number): void {
  if (tracker.saveTimer !== null && delayMs > 0) return
  tracker.saveTimer?.cancel()
  tracker.saveTimer = $.clock.after(delayMs, () => void save($, tracker).catch(error => $.ui.log(`could not save progress: ${describe(error)}`, { to: 'debug' })))
}

function announce($: Dollar, settings: Settings, unlocked: readonly Achievement[]): void {
  const [first] = unlocked
  if (first === undefined) return
  const text = unlocked.length === 1
    ? `🏆 Unlocked: ${first.icon} ${first.title} · ${first.description}`
    : `🏆 Unlocked ${unlocked.length}: ${unlocked.map(achievement => `${achievement.icon} ${achievement.title}`).join(', ')}`
  $.ui.toast(text, { timeoutMs: TOAST_MS })
  if (settings.isSoundOn) $.clock.after(0, () => void $.audio.play(SOUND).catch(() => undefined))
}

async function record($: Dollar, tracker: Tracker, settings: Settings, change: Change): Promise<void> {
  const progress = await progressOf($, tracker)
  const now = await $.clock.now()
  const day = localDate(now)
  change(progress, tracker.pending, now, day)
  settleDays(progress, day)
  const unlocked = unlockReached(progress, day, now)
  if (unlocked.length > 0) {
    announce($, settings, unlocked)
    await update($, progressState, () => progress)
  }
  scheduleSave($, tracker, unlocked.length > 0 ? 0 : SAVE_DELAY_MS)
}

/** Records a change after the hook returns, so no event waits on the store. */
function later($: Dollar, tracker: Tracker, settings: Settings, change: Change): void {
  $.clock.after(0, () => void record($, tracker, settings, change).catch(error => $.ui.log(`could not record progress: ${describe(error)}`, { to: 'debug' })))
}

// ── What each event counts toward ────────────────────────────────────────────

const promptChange: Change = (progress, pending, now, day) => {
  bump(progress, pending, 'prompts')
  noteActiveDay(progress, day)
  const date = new Date(now)
  const hour = date.getHours()
  if (hour < 4) raise(progress, 'nightOwl', 1)
  if (hour >= 5 && hour < 7) raise(progress, 'earlyBird', 1)
  if (date.getDay() === 0 || date.getDay() === 6) raise(progress, 'weekend', 1)
}

/** The change one finished tool call makes; `output` is what the model read. */
function toolChange(tracker: Tracker, tool: string, input: Record<string, unknown>, hasFailed: boolean, output: string): Change {
  return (progress, pending, now, day) => {
    bump(progress, pending, 'tools')
    noteToolCall(progress, pending, day, hasFailed)
    if (tool === 'Bash' && typeof input.command === 'string') {
      const command = input.command
      if (!hasFailed) {
        for (const [counter, by] of Object.entries(bashCounts(command))) bump(progress, pending, counter as SumCounter, by)
      }
      const runner = testRunnerOf(command)
      if (runner !== undefined && (hasFailed || reportsFailure(output))) {
        tracker.failingRunners.add(runner)
      } else if (runner !== undefined) {
        bump(progress, pending, 'greenRuns')
        if (tracker.failingRunners.delete(runner)) bump(progress, pending, 'redToGreen')
      }
    } else if (EDIT_TOOLS.has(tool) && !hasFailed) {
      const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : ''
      if (path !== '') {
        tracker.sessionFiles.add(path)
        raise(progress, 'sessionFiles', tracker.sessionFiles.size)
        const language = languageOf(path)
        if (language !== undefined) noteLanguage(progress, language)
      }
    } else if (AGENT_TOOLS.has(tool)) {
      bump(progress, pending, 'subagents')
    } else if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
      const todos = input.todos.filter((todo): todo is { content: string; status: string } => typeof todo?.content === 'string')
      const fingerprint = todos.map(todo => todo.content).join('\n')
      const isDone = todos.length >= CHECKLIST_ITEMS && todos.every(todo => todo.status === 'completed')
      if (isDone && fingerprint !== tracker.lastChecklist) {
        tracker.lastChecklist = fingerprint
        bump(progress, pending, 'checklists')
      }
    }
  }
}

// ── The command and the pane ─────────────────────────────────────────────────

const isUnlocked = (progress: Progress, achievement: Achievement): boolean => progress.unlocked[achievement.id] !== undefined

function filtered(progress: Progress, filter: string): Achievement[] {
  if (filter === FILTER_UNLOCKED) return ACHIEVEMENTS.filter(achievement => isUnlocked(progress, achievement))
  if (filter === FILTER_LOCKED) return ACHIEVEMENTS.filter(achievement => !isUnlocked(progress, achievement))
  return filter in GROUPS ? ACHIEVEMENTS.filter(achievement => achievement.group === filter) : [...ACHIEVEMENTS]
}

function listText(progress: Progress, now: number): string {
  const stats = statsOf(progress, localDate(now))
  const unlocked = ACHIEVEMENTS.filter(achievement => isUnlocked(progress, achievement))
    .sort((a, b) => (progress.unlocked[b.id] ?? 0) - (progress.unlocked[a.id] ?? 0))
  const locked = ACHIEVEMENTS.filter(achievement => !isUnlocked(progress, achievement))

  return [
    `🏆 ${unlocked.length} of ${ACHIEVEMENTS.length} achievements unlocked`,
    ...unlocked.map(achievement => `✓ ${achievement.icon} ${achievement.title}: ${achievement.description} (${ago(now - (progress.unlocked[achievement.id] ?? now))})`),
    ...locked.map(achievement => `· ${achievement.icon} ${achievement.title}: ${achievement.description} (${Math.min(stats[achievement.stat], achievement.goal)}/${achievement.goal})`),
  ].join('\n')
}

async function openAchievements($: Dollar, tracker: Tracker): Promise<CommandRunResult> {
  const progress = await progressOf($, tracker)
  await save($, tracker).catch(() => undefined)
  await update($, progressState, () => tracker.memory ?? progress)
  const opened = await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true, closeOnEscape: true })
  if (!opened.isPlaced) return { text: listText(tracker.memory ?? progress, await $.clock.now()) }
  const unlocked = Object.keys((tracker.memory ?? progress).unlocked).length

  return { text: `🏆 ${unlocked} of ${ACHIEVEMENTS.length} achievements unlocked.` }
}

export const register: Register = (on, options) => {
  const settings: Settings = { isSoundOn: options.sound !== false }
  const tracker: Tracker = {
    memory: null,
    loading: null,
    pending: emptyPending(),
    saveTimer: null,
    saving: Promise.resolve(),
    sessionFiles: new Set(),
    failingRunners: new Set(),
    lastChecklist: '',
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'achievements', description: 'Show your achievements and how close you are to the next ones' })
    $.clock.after(0, () => void progressOf($, tracker).then(progress => update($, progressState, () => progress)).catch(() => undefined))

    return next(e)
  })

  on('command.run', { command: 'achievements' }, async $ => openAchievements($, tracker))

  on('prompt.submit', async ($, e, next) => {
    if (isPerson(e.origin)) later($, tracker, settings, promptChange)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined) {
      const input: Record<string, unknown> = { ...e }
      later($, tracker, settings, toolChange(tracker, String(e.tool), input, ran.isError === true, ran.text ?? ''))
    }

    return ran
  })

  on('process.run', async ($, e, next) => {
    const ran = await next(e)
    if ('value' in ran && ran.value !== undefined && isPluginInstall(e.argv, ran.value.exitCode)) {
      later($, tracker, settings, (progress, pending) => bump(progress, pending, 'mods'))
    }

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && !e.isAborted && e.durationMs >= DEEP_WORK_MS) {
      later($, tracker, settings, progress => raise(progress, 'deepWork', 1))
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    try {
      await save($, tracker)
    } catch {
      // Ending stays fast; what was saved before stands.
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const [stored, view, now] = await Promise.all([read($, progressState), read($, viewState), $.clock.now()])
    const progress = stored ?? emptyProgress()
    const stats = statsOf(progress, localDate(now))
    const unlockedCount = ACHIEVEMENTS.filter(achievement => isUnlocked(progress, achievement)).length
    const latest = ACHIEVEMENTS.filter(achievement => isUnlocked(progress, achievement))
      .sort((a, b) => (progress.unlocked[b.id] ?? 0) - (progress.unlocked[a.id] ?? 0))[0]
    const width = e.props.bodyColumns
    const perRow = Math.max(1, Math.floor((width + CARD_GAP) / (CARD_COLUMNS + CARD_GAP)))
    const cardWidth = perRow === 1 ? width : CARD_COLUMNS
    const shown = filtered(progress, view.filter)
    const rows: Achievement[][] = []
    for (let index = 0; index < shown.length; index += perRow) rows.push(shown.slice(index, index + perRow))

    const picker = e.surface === 'mobile' ? null : (() => {
      const { Select } = $.ui.resolve(e)
      const options = [
        { value: FILTER_ALL, label: `All (${ACHIEVEMENTS.length})` },
        { value: FILTER_UNLOCKED, label: `Unlocked (${unlockedCount})` },
        { value: FILTER_LOCKED, label: `Locked (${ACHIEVEMENTS.length - unlockedCount})` },
        ...Object.entries(GROUPS).map(([value, label]) => ({ value, label })),
      ]
      return <Select key="filter" label="Show" options={options} value={view.filter} onSelect={filter => update($, viewState, () => ({ filter }))} />
    })()

    const card = (achievement: Achievement) => {
      const isDone = isUnlocked(progress, achievement)
      const value = Math.min(stats[achievement.stat], achievement.goal)
      return (
        <Box
          key={`card:${achievement.id}`}
          flexDirection="column"
          width={cardWidth}
          borderStyle="round"
          borderColor={isDone ? 'success' : 'subtle'}
          paddingX={1}
        >
          <Text bold={isDone} dimColor={!isDone} wrap="truncate-end">
            {achievement.icon} {achievement.title}
          </Text>
          <Text dimColor wrap="truncate-end">{achievement.description}</Text>
          {isDone
            ? <Text color="success" wrap="truncate-end">✓ unlocked {ago(now - (progress.unlocked[achievement.id] ?? now))}</Text>
            : <Text dimColor wrap="truncate-end">{bar(value, achievement.goal, BAR_CELLS)} {value}/{achievement.goal}</Text>}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={2}>
          <Text bold color="claude">🏆 Achievements</Text>
          <Text>
            <Text color="success">{bar(unlockedCount, ACHIEVEMENTS.length, BAR_CELLS * 2)}</Text>
            <Text> {unlockedCount}/{ACHIEVEMENTS.length} unlocked</Text>
          </Text>
        </Box>
        {latest === undefined
          ? <Text dimColor>Nothing unlocked yet: send a prompt to get the first one.</Text>
          : <Text dimColor wrap="truncate-end">Latest: {latest.icon} {latest.title} · {ago(now - (progress.unlocked[latest.id] ?? now))}</Text>}
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {picker}
          <Button key="close" label="Close" plain hotkey="q" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
        {shown.length === 0 ? <Text dimColor>None here yet.</Text> : null}
        {rows.map((row, index) => (
          <Box key={`row:${index}`} flexDirection="row" columnGap={CARD_GAP}>
            {row.map(card)}
          </Box>
        ))}
      </Box>
    )
  })
}
