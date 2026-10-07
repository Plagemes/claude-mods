import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface, Timer } from 'claude-code'

import type { ParallelExploreAngle, ParallelExploreRun } from '../types'
import {
  ANGLE_COUNT,
  FIXED_ANGLES,
  MERGER_SYSTEM,
  PLANNER_SYSTEM,
  SCOUT_PROMPT,
  explorerPrompt,
  formatElapsed,
  mergePrompt,
  messageForClaude,
  parseAngles,
  planPrompt,
  unmergedAnswer,
  whyNotReadOnly,
} from './explore'
import type { Angle } from './explore'

const PANE = 'explore'
const BUILT_IN_TYPE = 'Explore'
const SCOUT = 'scout'
const SCOUT_TYPE = 'parallel-explore:scout'
const SCOUT_TOOLS = ['Read', 'Grep', 'Glob', 'Bash']
const WRITE_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit)$/
const PLAN_MODEL = 'haiku'
const PLAN_TIMEOUT_MS = 20_000
const MERGE_TIMEOUT_MS = 180_000
const MERGE_MAX_TOKENS = 3_000
const TICK_MS = 1_000
const MAX_AGENTS_TRACKED = 60
const DEFAULT_TIMEOUT_MIN = 10
const USAGE = 'Usage: /explore <question about the codebase>'
const GLYPHS = { waiting: '○', running: '◐', done: '✓', failed: '✗' } as const
const GLYPH_COLORS = { waiting: 'inactive', running: 'suggestion', done: 'success', failed: 'error' } as const

const runAtom = atom({ plugin: 'parallel-explore', key: 'run' } as const, null)
const agentsAtom = atom({ plugin: 'parallel-explore', key: 'agents' } as const, [])

type Settings = { planAngles: boolean; mergeModel: string; timeoutMs: number }
/** Timers of the running exploration, and the ids the `agent.spawn` hook saw for this mod's own spawns (by task). */
type Timers = { tick?: Timer; deadline?: Timer; spawned: Map<string, string> }

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const isActive = (run: ParallelExploreRun | null): boolean => run !== null && (run.phase === 'planning' || run.phase === 'exploring' || run.phase === 'merging')

async function patchRun($: EngineInterface, id: number, change: (run: ParallelExploreRun) => ParallelExploreRun): Promise<void> {
  await update($, runAtom, run => (run?.id === id ? change(run) : run))
}

async function patchAngle($: EngineInterface, id: number, index: number, change: Partial<ParallelExploreAngle>): Promise<void> {
  await patchRun($, id, run => ({ ...run, angles: run.angles.map((angle, at) => (at === index ? { ...angle, ...change } : angle)) }))
}

function stopTimers(timers: Timers): void {
  timers.tick?.cancel()
  timers.deadline?.cancel()
  timers.tick = undefined
  timers.deadline = undefined
}

/** Three angles from a quick planning call, or the fixed ones. */
async function planAngles($: EngineInterface, settings: Settings, question: string): Promise<Angle[]> {
  if (!settings.planAngles) return [...FIXED_ANGLES]
  try {
    const reply = await $.model.complete({ model: PLAN_MODEL, system: PLANNER_SYSTEM, prompt: planPrompt(question), maxTokens: 600, timeoutMs: PLAN_TIMEOUT_MS })
    return (reply.isAnswered ? parseAngles(reply.text) : undefined) ?? [...FIXED_ANGLES]
  } catch {
    return [...FIXED_ANGLES]
  }
}

/** Starts one explorer: the built-in Explore agent, else this mod's read-only scout. */
async function spawnAngle($: EngineInterface, settings: Settings, timers: Timers, id: number, index: number, question: string, angle: Angle): Promise<void> {
  let why = 'no agent type could start it'
  const prompt = explorerPrompt(question, angle, index)
  for (const subagentType of [BUILT_IN_TYPE, SCOUT_TYPE]) {
    const spawned = await $.agent
      .spawn({ subagentType, prompt, description: `Explore: ${angle.title}` })
      .catch((error: unknown) => ({ deny: errorText(error), agentId: undefined }))
    const agentId = spawned.agentId ?? (spawned.deny === undefined ? timers.spawned.get(prompt) : undefined)
    timers.spawned.delete(prompt)
    if (agentId !== undefined) {
      await update($, agentsAtom, ids => [...ids.filter(one => one !== agentId), agentId].slice(-MAX_AGENTS_TRACKED))
      await patchAngle($, id, index, { status: 'running', agentId, agentType: subagentType, startedAt: await $.clock.now() })
      return
    }
    why = spawned.deny ?? why
  }
  await patchAngle($, id, index, { status: 'failed', error: why, finishedAt: await $.clock.now() })
  await maybeMerge($, settings, timers, id)
}

/** Plans the angles and starts the three explorers; their answers arrive at `turn.complete`. */
async function explore($: EngineInterface, settings: Settings, timers: Timers, run: ParallelExploreRun): Promise<void> {
  try {
    const angles = await planAngles($, settings, run.question)
    await patchRun($, run.id, current => ({
      ...current,
      phase: 'exploring',
      angles: angles.slice(0, ANGLE_COUNT).map(angle => ({ ...angle, status: 'waiting' as const })),
    }))
    stopTimers(timers)
    timers.tick = $.clock.every(TICK_MS, () => $.ui.invalidate('ui.render'))
    timers.deadline = $.clock.after(settings.timeoutMs, () => void timeOut($, settings, timers, run.id))
    await Promise.all(angles.slice(0, ANGLE_COUNT).map((angle, index) => spawnAngle($, settings, timers, run.id, index, run.question, angle)))
  } catch (error) {
    stopTimers(timers)
    await patchRun($, run.id, current => ({ ...current, phase: 'failed', error: errorText(error) }))
  }
}

/** The deadline: explorers still running are given up on, and what came back is merged. */
async function timeOut($: EngineInterface, settings: Settings, timers: Timers, id: number): Promise<void> {
  const now = await $.clock.now()
  const minutes = Math.round(settings.timeoutMs / 60_000)
  await patchRun($, id, run => ({
    ...run,
    angles: run.angles.map(angle => (angle.status === 'running' || angle.status === 'waiting' ? { ...angle, status: 'failed', error: `no report within ${minutes} min`, finishedAt: now } : angle)),
  }))
  await maybeMerge($, settings, timers, id)
}

/** Once every explorer has reported (or failed), merges the reports into one answer. */
async function maybeMerge($: EngineInterface, settings: Settings, timers: Timers, id: number): Promise<void> {
  let isMine = false
  await update($, runAtom, run => {
    isMine = false
    if (run?.id !== id || run.phase !== 'exploring' || run.angles.some(angle => angle.status === 'running' || angle.status === 'waiting')) return run
    isMine = true
    return { ...run, phase: 'merging' as const }
  })
  if (!isMine) return
  const run = (await read($, runAtom)) as ParallelExploreRun
  timers.deadline?.cancel()
  const finish = async (change: Partial<ParallelExploreRun>, toast: string) => {
    stopTimers(timers)
    const finishedAt = await $.clock.now()
    await patchRun($, id, current => ({ ...current, ...change, finishedAt }))
    $.ui.toast(toast)
  }
  if (run.angles.every(angle => angle.status === 'failed')) {
    await finish({ phase: 'failed', error: 'none of the explorers reported back' }, 'Explore failed: no explorer reported back')
    return
  }
  try {
    const model = settings.mergeModel === 'inherit' ? await $.session.model() : settings.mergeModel
    const reply = await $.model.complete({ model, system: MERGER_SYSTEM, prompt: mergePrompt(run.question, run.angles), maxTokens: MERGE_MAX_TOKENS, timeoutMs: MERGE_TIMEOUT_MS })
    if (reply.isAnswered && reply.text.trim() !== '') {
      await finish({ phase: 'done', answer: reply.text.trim() }, 'Explore: findings merged')
      return
    }
  } catch {
    // Fall through to the reports side by side.
  }
  await finish({ phase: 'done', answer: unmergedAnswer(run.angles), isUnmerged: true }, 'Explore: merging failed, the reports are shown side by side')
}

async function startExplore($: EngineInterface, settings: Settings, timers: Timers, question: string): Promise<string> {
  const current = await read($, runAtom)
  const now = await $.clock.now()
  // A run whose timers a module reload dropped would otherwise block new ones forever.
  const isStale = current !== null && now - current.startedAt > settings.timeoutMs + MERGE_TIMEOUT_MS + PLAN_TIMEOUT_MS
  if (isActive(current) && !isStale) return `An exploration is still running ("${current?.question}"). Its findings will land in the Explore pane.`
  const run: ParallelExploreRun = { id: now + Math.random(), question, phase: 'planning', angles: [], startedAt: now, showReports: false }
  await update($, runAtom, () => run)
  await openPane($)
  // Planned and spawned inside the command's own dispatch: this mod's `agent.spawn` hook then sees its spawns.
  await explore($, settings, timers, run)
  const started = (await read($, runAtom))?.angles.filter(angle => angle.status !== 'failed') ?? []
  if (started.length === 0) return 'No explorer could be started; see the Explore pane.'
  return `Exploring with ${started.length} agents in parallel: ${started.map(angle => angle.title).join(' · ')}. The merged findings land in the Explore pane.`
}

async function registerScout($: EngineInterface): Promise<void> {
  const available = new Set((await $.tool.list().catch(() => [])).map(tool => tool.name))
  await $.agent.register({
    name: SCOUT,
    description: 'Read-only code explorer used by /explore when the built-in Explore agent is unavailable.',
    prompt: SCOUT_PROMPT,
    tools: SCOUT_TOOLS.filter(tool => available.size === 0 || available.has(tool)),
    model: 'inherit',
  })
}

async function copyAnswer($: EngineInterface, text: string, surface: RenderSurface): Promise<void> {
  const copied = await $.ui.copy({ text, surface })
  $.ui.toast(copied.isCopied ? 'Findings copied' : `Could not copy (${copied.reason})`)
}

async function sendToClaude($: EngineInterface, run: ParallelExploreRun): Promise<void> {
  await $.prompt.submit({ text: messageForClaude(run.question, run.answer ?? ''), asUser: true })
}

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Explore', rows: 30 }).catch(() => undefined)
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    planAngles: options.planAngles !== false,
    mergeModel: String(options.mergeModel ?? '').trim() || 'inherit',
    timeoutMs: Math.min(60, Math.max(1, Number(options.timeoutMinutes) || DEFAULT_TIMEOUT_MIN)) * 60_000,
  }
  const timers: Timers = { spawned: new Map() }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'explore', description: 'Send three read-only agents to investigate the codebase in parallel and merge their findings', argumentHint: '<question>' })
    try {
      await registerScout($)
    } catch (error) {
      $.ui.log(`parallel-explore: the fallback scout agent is unavailable: ${errorText(error)}`, { to: 'debug' })
    }
    return next(e)
  })

  // The scout is this mod's own fallback, not an agent type for the model to pick.
  on('agent.offer', { agent: SCOUT_TYPE }, () => ({ isOffered: false }))

  // Notes the id of each explorer this mod starts, by its task, for a spawn whose answer does not carry it.
  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.agentId !== undefined && e.description.startsWith('Explore: ') && e.prompt.includes('investigating this codebase in parallel')) {
      timers.spawned.set(e.prompt, spawned.agentId)
    }
    return spawned
  }).catch(($, e, next) => next(e)) // after `next`, this replays its answer: nothing is spawned twice

  on('command.run', { command: 'explore' }, async ($, e) => {
    const question = e.args.trim()
    if (question === '') {
      if ((await read($, runAtom)) === null) return { text: USAGE }
      await openPane($)
      return { text: 'The Explore pane shows the last exploration.' }
    }
    return { text: await startExplore($, settings, timers, question) }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    const run = await read($, runAtom)
    const index = run?.angles.findIndex(angle => angle.agentId === e.agentId && angle.status === 'running') ?? -1
    if (run === null || index === -1) return next(e)
    const report = e.answer.trim()
    const finishedAt = await $.clock.now()
    await patchAngle(
      $,
      run.id,
      index,
      e.reason === 'answer' && report !== '' ? { status: 'done', report, finishedAt } : { status: 'failed', error: `it stopped (${e.reason}) without a report`, finishedAt },
    )
    // Merging is a model call of its own: it runs after this agent's turn has ended, not inside it.
    $.clock.after(0, () => void maybeMerge($, settings, timers, run.id))
    return next(e)
  })

  // The explorers' reports come back here, merged: their own completion notices need not wake the main conversation.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'task-notification') return next(e)
    const ids = await read($, agentsAtom)
    return ids.some(id => e.text.includes(id)) ? { drop: 'parallel-explore: an explorer finished; its findings are in the Explore pane.' } : next(e)
  }).catch(($, e, next) => next(e))

  // Explorers only read: no edits, and shell commands held to read-only programs.
  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined || !(await read($, agentsAtom)).includes(e.agentId)) return next(e)
    const tool = String(e.tool)
    if (WRITE_TOOLS.test(tool)) return { deny: `parallel-explore: explorers are read-only (${tool} refused).` }
    if (tool === 'Bash' && 'command' in e && typeof e.command === 'string') {
      const why = whyNotReadOnly(e.command)
      if (why !== undefined) return { deny: `parallel-explore: explorers are read-only (${why}). Use Read, Grep, Glob or a read command such as rg, grep, find, cat.` }
    }
    return next(e)
  }).catch(($, e, next) =>
    next.called || e.agentId === undefined || !(WRITE_TOOLS.test(String(e.tool)) || String(e.tool) === 'Bash')
      ? next(e)
      : { deny: 'parallel-explore: could not confirm that this explorer call is read-only.' },
  )

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const run = await read($, runAtom)
    if (run === null) return <Text dimColor>{USAGE}</Text>
    const now = await $.clock.now()
    const done = run.angles.filter(angle => angle.status === 'done' || angle.status === 'failed').length
    const elapsed = formatElapsed((run.finishedAt ?? now) - run.startedAt)
    const phase =
      run.phase === 'planning'
        ? 'Planning three angles…'
        : run.phase === 'exploring'
          ? `Exploring · ${done} of ${run.angles.length} reported · ${elapsed}`
          : run.phase === 'merging'
            ? `Merging the findings… · ${elapsed}`
            : run.phase === 'done'
              ? `Done in ${elapsed}${run.isUnmerged ? ' · reports not merged' : ''}`
              : `Failed: ${run.error ?? 'unknown error'}`

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold wrap="truncate-end">{`🔭 ${run.question}`}</Text>
          <Text color={run.phase === 'failed' ? 'error' : run.phase === 'done' ? 'success' : 'suggestion'}>{phase}</Text>
        </Box>
        {run.angles.length > 0 && (
          <Box key="angles" flexDirection="column">
            {run.angles.map(angle => (
              <Box flexDirection="column">
                <Box gap={1}>
                  <Text color={GLYPH_COLORS[angle.status]}>{GLYPHS[angle.status]}</Text>
                  <Text bold>{angle.title}</Text>
                  {angle.startedAt !== undefined && <Text dimColor>{formatElapsed((angle.finishedAt ?? now) - angle.startedAt)}</Text>}
                  {angle.agentType === SCOUT_TYPE && <Text dimColor>(scout)</Text>}
                </Box>
                <Text dimColor wrap="truncate-end">{angle.status === 'failed' ? `  ${angle.error ?? 'failed'}` : `  ${angle.focus}`}</Text>
              </Box>
            ))}
          </Box>
        )}
        {run.answer !== undefined && <Markdown key="answer" text={run.answer} />}
        {run.showReports && (
          <Box key="reports" flexDirection="column" gap={1}>
            {run.angles.map(angle => (
              <Markdown text={`### ${angle.title}\n\n${angle.report ?? `_No report: ${angle.error ?? 'not finished yet'}._`}`} />
            ))}
          </Box>
        )}
        <Box gap={1} flexWrap="wrap">
          {run.phase === 'done' && <Button key="send" label="Send to Claude" hotkey="s" variant="primary" onPress={() => void sendToClaude($, run)} />}
          {run.phase === 'done' && <Button key="copy" label="Copy" hotkey="c" onPress={press => void copyAnswer($, run.answer ?? '', press.surface)} />}
          {run.angles.some(angle => angle.report !== undefined) && !run.isUnmerged && (
            <Button
              key="reports"
              label={run.showReports ? 'Hide reports' : 'Show reports'}
              hotkey="t"
              onPress={() => void patchRun($, run.id, current => ({ ...current, showReports: !current.showReports }))}
            />
          )}
          <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}
