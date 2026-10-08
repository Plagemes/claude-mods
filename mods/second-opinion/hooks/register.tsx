import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { SecondOpinionReview } from '../types'
import { AGREEMENT_LABELS, REVIEWER_SYSTEM, lastTurn, messageForClaude, parseVerdict, reviewPrompt, reviewerFor, verdictLine, verdictMarkdown } from './review'
import { paneFailure } from './shared/render-safe'

const PANE = 'second-opinion'
const MAX_REPLY_TOKENS = 2_000
const DEFAULT_TIMEOUT_S = 120
const QUESTION_PREVIEW_CHARS = 160
const STALE_GRACE_MS = 30_000
const AGREEMENT_COLORS = { agree: 'success', partly: 'warning', disagree: 'error', unclear: 'inactive' } as const
const SEVERITY_COLORS = { high: 'error', medium: 'warning', low: 'inactive' } as const

const reviewAtom = atom({ plugin: 'second-opinion', key: 'review' } as const, null)

type Settings = { model: string; timeoutMs: number }
/** The running request, so the pane can cancel it. */
type Running = { controller?: AbortController }

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const preview = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > QUESTION_PREVIEW_CHARS ? `${flat.slice(0, QUESTION_PREVIEW_CHARS - 1)}…` : flat
}

/** Starts a review of the last answered turn; says in one line what happened. */
async function startReview($: EngineInterface, settings: Settings, running: Running, focus: string): Promise<string> {
  const current = await read($, reviewAtom)
  const now = await $.clock.now()
  // A review left running by a reload of the module would otherwise block new ones forever.
  if (current?.status === 'running' && now - current.startedAt < settings.timeoutMs + STALE_GRACE_MS) return 'A second opinion is already on its way.'
  const turn = lastTurn(await $.session.messages())
  if (turn === undefined) return 'Nothing to review yet: Claude has not answered in this conversation.'
  const reviewedModel = await $.session.model()
  const model = reviewerFor(settings.model, reviewedModel)
  const review: SecondOpinionReview = {
    status: 'running',
    model,
    reviewedModel,
    focus,
    question: preview(turn.question),
    changes: turn.changes.length,
    startedAt: now,
  }
  await update($, reviewAtom, () => review)
  const prompt = reviewPrompt(turn, focus)
  $.clock.after(0, () => void finishReview($, settings, running, review, prompt))
  const extra = turn.changes.length > 0 ? ` and the ${turn.changes.length} file change${turn.changes.length === 1 ? '' : 's'} it made` : ''
  return `Asking ${model} for a second opinion on the last answer${extra}…`
}

async function finishReview($: EngineInterface, settings: Settings, running: Running, review: SecondOpinionReview, prompt: string): Promise<void> {
  const controller = new AbortController()
  running.controller = controller
  let finished: SecondOpinionReview
  try {
    const reply = await $.model.complete(
      { model: review.model, system: REVIEWER_SYSTEM, prompt, maxTokens: MAX_REPLY_TOKENS, timeoutMs: settings.timeoutMs },
      { signal: controller.signal },
    )
    const tokens = { input: reply.usage.input_tokens + (reply.usage.cache_read_input_tokens ?? 0), output: reply.usage.output_tokens }
    if (reply.isAnswered) {
      const verdict = parseVerdict(reply.text)
      finished = verdict === undefined ? { ...review, status: 'done', raw: reply.text, tokens } : { ...review, status: 'done', verdict, tokens }
    } else {
      const why =
        reply.reason === 'api-error'
          ? `the API answered ${reply.status ?? 'nothing'} (${reply.error})`
          : reply.reason === 'aborted'
            ? controller.signal.aborted
              ? 'cancelled'
              : `no answer within ${Math.round(settings.timeoutMs / 1000)} s`
            : 'the reply was empty'
      finished = { ...review, status: 'failed', error: why }
    }
  } catch (error) {
    finished = { ...review, status: 'failed', error: errorText(error) }
  } finally {
    if (running.controller === controller) running.controller = undefined
  }
  await update($, reviewAtom, current => (current?.startedAt === review.startedAt ? finished : current))
  await hubPublish($, {
    topic: 'agent.finished',
    data: { agentType: 'second-opinion', outcome: finished.status === 'failed' ? 'failed' : 'ok', durationMs: Math.max(0, (await $.clock.now()) - review.startedAt) },
  })
  // A notice through the hub (your phone channel while you are away: it ran in the background); a toast without it.
  await hubNotify(
    $,
    finished.status === 'failed'
      ? { level: 'warning', title: `Second opinion failed: ${finished.error ?? 'unknown error'}` }
      : { level: 'success', title: `Second opinion from ${finished.model}: ${finished.verdict === undefined ? 'see the pane' : verdictLine(finished.verdict)}` },
  )
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

const reviewText = (review: SecondOpinionReview): string =>
  review.verdict === undefined ? `**Second opinion (${review.model}):**\n\n${review.raw ?? ''}` : verdictMarkdown(review.verdict, review.model)

async function sendToClaude($: EngineInterface, review: SecondOpinionReview): Promise<void> {
  await $.prompt.submit({ text: messageForClaude(reviewText(review)), asUser: true })
}

async function copyReview($: EngineInterface, review: SecondOpinionReview, surface: RenderSurface): Promise<void> {
  const copied = await $.ui.copy({ text: reviewText(review), surface })
  $.ui.toast(copied.isCopied ? 'Second opinion copied' : `Could not copy (${copied.reason})`)
}

async function askAgain($: EngineInterface, settings: Settings, running: Running, focus: string): Promise<void> {
  $.ui.toast(await startReview($, settings, running, focus))
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    model: String(options.model ?? 'auto'),
    timeoutMs: Math.min(600, Math.max(10, Number(options.timeoutSeconds) || DEFAULT_TIMEOUT_S)) * 1000,
  }
  const running: Running = {}

  on('session.start', async ($, e, next) => {
    await registerCommand($, {
      name: 'second-opinion',
      description: "Have a different model critique Claude's last answer or plan",
      argumentHint: '[what to focus on]',
    })
    afterStart($, 'second-opinion', () => greetHub($))
    return next(e)
  })

  on('command.run', { command: 'second-opinion' }, async ($, e) => {
    let text: string
    try {
      text = await startReview($, settings, running, e.args.trim())
    } catch (error) {
      return { text: `The second opinion could not start: ${errorText(error)}` }
    }
    if ((await read($, reviewAtom)) !== null) await $.ui.open({ id: PANE, title: 'Second opinion', rows: 24 }).catch(() => undefined)
    return { text }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const review = await read($, reviewAtom)
    if (review === null) return <Text dimColor>Run /second-opinion [focus] after Claude answers.</Text>
    const { verdict } = review

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Box gap={1} flexWrap="wrap">
            <Text bold>Second opinion</Text>
            <Text dimColor>{`${review.model} on ${review.reviewedModel}'s answer${review.focus === '' ? '' : ` · focus: ${review.focus}`}`}</Text>
          </Box>
          {review.question !== '' && <Text dimColor wrap="truncate-end">{`“${review.question}”`}</Text>}
        </Box>
        {review.status === 'running' && (
          <Text color="suggestion">{`Asking ${review.model}${review.changes > 0 ? ` (with ${review.changes} file change${review.changes === 1 ? '' : 's'})` : ''}… keep working, it lands here.`}</Text>
        )}
        {review.status === 'failed' && <Text color="error">{`It failed: ${review.error ?? 'unknown error'}`}</Text>}
        {verdict !== undefined && (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="column">
              <Text bold color={AGREEMENT_COLORS[verdict.agreement]}>{AGREEMENT_LABELS[verdict.agreement]}</Text>
              {verdict.summary !== '' && <Text>{verdict.summary}</Text>}
            </Box>
            {verdict.concerns.length > 0 && (
              <Box key="concerns" flexDirection="column">
                <Text bold>Concerns</Text>
                {verdict.concerns.map(concern => (
                  <Box gap={1}>
                    <Text color={SEVERITY_COLORS[concern.severity]}>{`● ${concern.severity}`}</Text>
                    <Text>{concern.text}</Text>
                  </Box>
                ))}
              </Box>
            )}
            {verdict.suggestions.length > 0 && (
              <Box key="suggestions" flexDirection="column">
                <Text bold>Suggestions</Text>
                {verdict.suggestions.map(suggestion => (
                  <Text>{`→ ${suggestion}`}</Text>
                ))}
              </Box>
            )}
            {verdict.concerns.length === 0 && verdict.suggestions.length === 0 && <Text dimColor>No concerns or suggestions.</Text>}
          </Box>
        )}
        {review.status === 'done' && verdict === undefined && <Markdown key="raw" text={review.raw ?? ''} />}
        {review.tokens !== undefined && <Text dimColor>{`${review.tokens.input} tokens in · ${review.tokens.output} out`}</Text>}
        <Box gap={1} flexWrap="wrap">
          {review.status === 'done' && <Button key="send" label="Send to Claude" hotkey="s" variant="primary" onPress={() => void sendToClaude($, review)} />}
          {review.status === 'done' && <Button key="copy" label="Copy" hotkey="c" onPress={press => void copyReview($, review, press.surface)} />}
          {review.status === 'running' && <Button key="cancel" label="Cancel" hotkey="x" onPress={() => running.controller?.abort()} />}
          {review.status !== 'running' && <Button key="again" label="Ask again" hotkey="r" onPress={() => void askAgain($, settings, running, review.focus)} />}
          <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  }).catch(async ($, e, next) =>
    next.error.kind === 're-entry'
      ? next(e)
      : paneFailure($.ui.resolve(e), { title: 'second-opinion', failure: next.error, below: await next(e).catch(() => null), onRetry: () => $.ui.invalidate('ui.render') }),
  )
}

/** Registers a slash command. A refused name (Claude Code's own, or another mod's) is reported as a notice, never thrown, so the rest of session.start still runs. */
async function registerCommand($: EngineInterface, spec: Parameters<EngineInterface['command']['register']>[0]): Promise<boolean> {
  try {
    await $.command.register(spec)
    return true
  } catch (error) {
    $.ui.log(`${$.plugin.name}: /${spec.name} was not registered (${error instanceof Error ? error.message : String(error)}).`)
    return false
  }
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
