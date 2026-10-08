import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ReviewState } from '../types'
import { countSeverities, describeCounts, isSafeRef, REVIEWER_DESCRIPTION, REVIEWER_PROMPT, SEVERITIES, whyNotReadOnly } from './review'

const NAME = 'review-agent'
const AGENT = 'reviewer'
const AGENT_TYPE = 'review-agent:reviewer'
const PANE = 'review'
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'Bash']
const GIT_TIMEOUT_MS = 20_000
const MAX_INLINE_DIFF = 60_000
const MAX_REVIEWERS_TRACKED = 50
/** `/review 123` or a pull request URL still reaches Claude Code's own pull request review. */
const PULL_REQUEST = /^(#?\d+|https?:\/\/\S+\/pulls?\/\d+\S*)$/
const COMMAND_DESCRIPTION = 'Review your changes with the read-only reviewer subagent (/review <PR#> reviews a pull request)'
const SEVERITY_COLORS = { critical: 'error', major: 'warning', minor: 'suggestion', nit: 'inactive' } as const

/** The latest reviewer the agent.spawn hook saw start, for a spawn whose answer does not name it. */
const lastSpawn: { agentId?: string } = {}

const reviewAtom = atom({ plugin: 'review-agent', key: 'review' } as const, null)
const reviewersAtom = atom({ plugin: 'review-agent', key: 'reviewers' } as const, [])

type Settings = { model: string; maxTurns: number }
type Target = { label: string; diffArgs: string[]; stat: string; diff: string }

/** The agent type a spawn names: `subagentType`, or the Agent tool's own `subagent_type` spelling. */
const spawnedType = (e: { subagentType?: string }): string | undefined => {
  const spelled = (e as Record<string, unknown>).subagent_type
  return e.subagentType ?? (typeof spelled === 'string' ? spelled : undefined)
}

async function git($: EngineInterface, args: readonly string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const run = await $.process.run(['git', ...args], { timeoutMs: GIT_TIMEOUT_MS })
    return { ok: run.exitCode === 0, out: run.stdout }
  } catch {
    return { ok: false, out: '' }
  }
}

/** What /review [base] looks at: the working tree against HEAD, or against where it forked from base. */
async function resolveTarget($: EngineInterface, base: string): Promise<Target | { error: string }> {
  if (!(await git($, ['rev-parse', '--show-toplevel'])).ok) return { error: 'Not inside a git repository.' }
  let diffArgs = ['HEAD']
  let label = 'uncommitted changes'
  if (base !== '') {
    if (!isSafeRef(base)) return { error: `"${base}" is not a branch, tag or commit name.` }
    const forkPoint = await git($, ['merge-base', base, 'HEAD'])
    if (!forkPoint.ok) return { error: `Cannot find "${base}" or its common ancestor with HEAD.` }
    diffArgs = [forkPoint.out.trim()]
    label = `changes since ${base}`
  }
  const stat = await git($, ['diff', '--shortstat', ...diffArgs])
  if (!stat.ok) return { error: 'Git diff failed (is there a first commit yet?).' }
  if (stat.out.trim() === '') {
    return {
      error: base === ''
        ? 'Nothing to review: no uncommitted changes. Try /review main to review your branch.'
        : `Nothing to review: no changes since ${base}.`,
    }
  }
  const diff = await git($, ['diff', '--no-color', '--no-ext-diff', ...diffArgs])
  return { label, diffArgs, stat: stat.out.trim(), diff: diff.out }
}

const taskFor = (target: Target): string => {
  const command = `git diff ${target.diffArgs.join(' ')}`
  const isCut = target.diff.length > MAX_INLINE_DIFF
  return [
    `Review the ${target.label} (${target.stat}).`,
    `Diff command: \`${command}\``,
    '',
    isCut
      ? `The diff is too long to include; run \`${command} --stat\` and then \`${command} -- <path>\` file by file.`
      : ['```diff', target.diff.trimEnd(), '```'].join('\n'),
    '',
    'Report in the format from your instructions.',
  ].join('\n')
}

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Says hello to mods-hub when it is installed. */
async function greetHub($: EngineInterface): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: ['agent.finished'], consumes: [] })
}

async function rememberReviewer($: EngineInterface, agentId: string): Promise<void> {
  await update($, reviewersAtom, ids => [...ids.filter(id => id !== agentId), agentId].slice(-MAX_REVIEWERS_TRACKED))
}

async function startReview($: EngineInterface, base: string): Promise<string> {
  const target = await resolveTarget($, base)
  if ('error' in target) return target.error
  const startedAt = await $.clock.now()
  lastSpawn.agentId = undefined
  const spawned = await $.agent.spawn({ subagentType: AGENT_TYPE, prompt: taskFor(target), description: `Review ${target.label}` })
  const agentId = spawned.agentId ?? lastSpawn.agentId
  const review = { base, label: target.label, stat: target.stat, startedAt }
  if (spawned.deny !== undefined || agentId === undefined) {
    const why = spawned.deny ?? 'no agent was started'
    await update($, reviewAtom, (): ReviewState => ({ ...review, status: 'failed', report: why }))
    return `Could not start the reviewer: ${why}`
  }
  await rememberReviewer($, agentId)
  await update($, reviewAtom, (): ReviewState => ({ ...review, status: 'running', report: '', agentId }))
  return `Reviewing ${target.label} (${target.stat}) in the background. Findings appear in the Review pane.`
}

async function registerReviewer($: EngineInterface, settings: Settings): Promise<void> {
  const available = new Set((await $.tool.list().catch(() => [])).map(tool => tool.name))
  const tools = READ_ONLY_TOOLS.filter(tool => available.size === 0 || available.has(tool))
  await $.agent.register({
    name: AGENT,
    description: REVIEWER_DESCRIPTION,
    prompt: REVIEWER_PROMPT,
    tools,
    model: settings.model,
    maxTurns: settings.maxTurns,
  })
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    model: String(options.model ?? '').trim() || 'inherit',
    maxTurns: Math.max(5, Math.min(200, Math.round(Number(options.maxTurns) || 40))),
  }

  on('session.start', async ($, e, next) => {
    afterStart($, 'review-agent', () => greetHub($))
    try {
      await registerReviewer($, settings)
    } catch (error) {
      $.ui.log(`${NAME}: could not register the reviewer agent: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      // Claude Code ships its own /review (pull requests): that registration is refused, and the hooks below share it.
      await $.command.register({ name: 'review', description: COMMAND_DESCRIPTION, argumentHint: '[base | PR#]' })
    } catch {
      $.ui.log(`${NAME}: /review is Claude Code's own; diff reviews ride on it, PR numbers still go to it.`, { to: 'debug' })
    }
    return next(e)
  })

  on('command.describe', { command: 'review' }, async ($, e, next) => {
    const described = await next(e)
    return { ...described, description: COMMAND_DESCRIPTION, argumentHint: '[base | PR#]' }
  })

  // Reviewers the model starts through the Agent tool are read-only too.
  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawnedType(e) === AGENT_TYPE && spawned.agentId !== undefined) {
      lastSpawn.agentId = spawned.agentId
      await rememberReviewer($, spawned.agentId)
    }
    return spawned
  }).catch(($, e, next) => next(e)) // after `next`, this replays its answer: nothing is spawned twice

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.agentId === undefined || !(await read($, reviewersAtom)).includes(e.agentId)) return next(e)
    const why = whyNotReadOnly(e.command)
    return why === undefined ? next(e) : { deny: `${NAME}: the reviewer is read-only (${why}). Use Read, Grep, Glob or a git read command.` }
  }).catch(($, e, next) =>
    next.called || e.agentId === undefined || whyNotReadOnly(e.command) === undefined
      ? next(e)
      : { deny: `${NAME}: could not confirm that this subagent command is read-only.` },
  )

  on('turn.complete', async ($, e, next) => {
    const review = await read($, reviewAtom)
    if (e.agentId === undefined || review?.status !== 'running' || review.agentId !== e.agentId) return next(e)
    const isDone = e.reason === 'answer' && e.answer.trim() !== ''
    const report = isDone ? e.answer.trim() : `The reviewer stopped (${e.reason}) before reporting.`
    await update($, reviewAtom, () => ({ ...review, status: isDone ? 'done' : 'failed', report }))
    await hubPublish($, {
      topic: 'agent.finished',
      data: { agentType: AGENT_TYPE, outcome: isDone ? 'ok' : 'failed', durationMs: Math.max(0, (await $.clock.now()) - review.startedAt), agentId: e.agentId },
    })
    // A success notice through the hub (your phone channel while you are away: the review ran in the background); a toast without it.
    await hubNotify($, isDone ? { level: 'success', title: `Review ready, ${describeCounts(countSeverities(report))}` } : { level: 'warning', title: 'The review did not finish' })
    try {
      if (!(await $.ui.panes()).some(pane => pane.id === PANE)) await $.ui.open({ id: PANE, title: 'Review' })
    } catch {
      // The toast already said it; the pane opens with /review.
    }
    return next(e)
  })

  on('command.run', { command: 'review' }, async ($, e, next) => {
    if (PULL_REQUEST.test(e.args.trim())) return next(e)
    const current = await read($, reviewAtom)
    if (current?.status === 'running') {
      await $.ui.open({ id: PANE, title: 'Review' })
      return { text: `A review of ${current.label} is still running.` }
    }
    const text = await startReview($, e.args.trim())
    if ((await read($, reviewAtom))?.status === 'running') await $.ui.open({ id: PANE, title: 'Review', rows: 24 })
    return { text }
  }).catch(($, e, next) =>
    next.called ? next(e) : { text: `The review could not start (${next.error.message ?? next.error.kind}).` },
  )

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const review: ReviewState | null = await read($, reviewAtom)
    if (review === null) return <Text dimColor>Run /review [base] to review your changes.</Text>
    const counts = countSeverities(review.report)
    const askToFix = async () => {
      const text = `Please address these code review findings (most severe first), then summarise what you changed:\n\n${review.report}`
      await $.prompt.submit({ text, asUser: true })
    }
    const copy = async (surface: typeof e.surface) => {
      const copied = await $.ui.copy({ text: review.report, surface })
      $.ui.toast(copied.isCopied ? 'Findings copied' : `Could not copy (${copied.reason})`)
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold wrap="truncate-end">{`Review · ${review.label}`}</Text>
          <Text dimColor wrap="truncate-end">{review.stat}</Text>
        </Box>
        {review.status === 'running' && <Text color="suggestion">Reviewing in the background… keep working, the findings land here.</Text>}
        {review.status === 'failed' && <Text color="error">{review.report}</Text>}
        {review.status === 'done' && (
          <Box gap={2} flexWrap="wrap">
            {SEVERITIES.map(severity => (
              <Text color={SEVERITY_COLORS[severity]} dimColor={counts[severity] === 0}>{`${counts[severity]} ${severity}`}</Text>
            ))}
          </Box>
        )}
        {review.status === 'done' && <Markdown key="report" text={review.report} />}
        <Box gap={1} flexWrap="wrap">
          {review.status === 'done' && describeCounts(counts) !== 'no issues' && (
            <Button key="fix" label="Ask Claude to fix" hotkey="f" variant="primary" onPress={() => void askToFix()} />
          )}
          {review.status === 'done' && <Button key="copy" label="Copy" hotkey="c" onPress={press => void copy(press.surface)} />}
          {review.status !== 'running' && (
            <Button key="again" label="Review again" hotkey="r" onPress={() => void startReview($, review.base)} />
          )}
          <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}

// #region @vendored shared/hub-client.ts sha256:6b153e2e759f: edit the source, then run `node scripts/sync-shared.mjs`.
// mods-hub client (docs/MOD_CONTRACT.md): uses the hub when it is installed, keeps working when it is not.

type HubMods = EngineInterface['mods']

/** Publishes an event on the hub's bus; false when there is no hub or it refused the event. */
async function hubPublish($: EngineInterface, input: Parameters<HubMods['publish']>[0]): Promise<boolean> {
  try {
    await $.mods.publish(input)
    return true
  } catch {
    return false
  }
}

/**
 * Routes a notification through the hub (channels, silent, night, presence), or shows it as a toast when there is
 * no hub: `title — body`, for `fallback.timeoutMs` when given (the toast's own option).
 */
async function hubNotify($: EngineInterface, input: Parameters<HubMods['notify']>[0], fallback: { timeoutMs?: number } = {}): Promise<void> {
  try {
    await $.mods.notify(input)
  } catch {
    const text = input.body === undefined || input.body === '' ? input.title : `${input.title} — ${input.body}`
    if (fallback.timeoutMs === undefined) $.ui.toast(text)
    else $.ui.toast(text, { timeoutMs: fallback.timeoutMs })
  }
}

/** The global mode (presence, silent, night, interaction), or undefined when there is no hub. */
async function hubMode($: EngineInterface): Promise<Awaited<ReturnType<HubMods['mode']>> | undefined> {
  try {
    return await $.mods.mode()
  } catch {
    return undefined
  }
}

/** Announces this mod to the hub, with its panel tab when it has one; call once from `session.start`. */
async function hubHello($: EngineInterface, hello: Parameters<HubMods['hello']>[0], tab?: Parameters<HubMods['registerTab']>[0]): Promise<boolean> {
  try {
    await $.mods.hello(hello)
    if (tab !== undefined) await $.mods.registerTab(tab)
    return true
  } catch {
    return false
  }
}

/** Opens the shared panel on this mod's tab; false when there is no hub (open your own pane then). */
async function hubShowTab($: EngineInterface, id: string): Promise<boolean> {
  try {
    return (await $.mods.showTab({ id })).isPlaced
  } catch {
    return false
  }
}

/**
 * Stops, pauses or resumes the automatic work (`control.stop` / `control.pause` / `control.resume`) in this session
 * or, with `scope: 'all'`, in every session; false when there is no hub (stop what you run yourself then).
 */
async function hubStop($: EngineInterface, input: Parameters<HubMods['stop']>[0]): Promise<boolean> {
  try {
    await $.mods.stop(input)
    return true
  } catch {
    return false
  }
}

/** Puts a fact on the hub's blackboard as `<this mod>.<name>`; false when there is no hub or it refused the fact. */
async function hubShareFact($: EngineInterface, input: Parameters<HubMods['share']>[0]): Promise<boolean> {
  try {
    await $.mods.share(input)
    return true
  } catch {
    return false
  }
}

/** A fact from the hub's blackboard by its full key (`stack-detector.stack`); undefined when there is no hub or no such fact. */
async function hubReadFact($: EngineInterface, key: string): Promise<Awaited<ReturnType<HubMods['read']>> | undefined> {
  try {
    return (await $.mods.read({ key })) ?? undefined
  } catch {
    return undefined
  }
}

/** Whether the shared panel shows tab `id` now; read while drawing, it subscribes the drawing. */
async function hubTabIs($: EngineInterface, id: string): Promise<boolean> {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
  return value === id
}
/**
 * Runs a mod's start-up work (the hub hello, a first scan, loading what it keeps) once `session.start` has returned,
 * after a short delay staggered by the mod's name (0.15–1.35 s), so ~200 mods sharing one hooks worker do not all wait
 * on the hub, a process or the disk inside the session.start chain (`ran past its 10s budget`). A failure is logged
 * to the debug log. Call it from `session.start` in place of `await work()`; never await the hub there
 * (scripts/check-startup.mjs).
 */
function afterStart($: EngineInterface, mod: string, work: () => Promise<unknown>): void {
  let hash = 7
  for (let i = 0; i < mod.length; i += 1) hash = (hash * 31 + mod.charCodeAt(i)) % 1_200
  $.clock.after(150 + hash, () => {
    void work().catch(error => $.ui.log(`${mod}: start-up work failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' }))
  })
}
// #endregion @vendored shared/hub-client.ts
