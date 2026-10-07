import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { SecondOpinionReview } from '../types'
import { AGREEMENT_LABELS, REVIEWER_SYSTEM, lastTurn, messageForClaude, parseVerdict, reviewPrompt, reviewerFor, verdictLine, verdictMarkdown } from './review'

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
  $.ui.toast(
    finished.status === 'failed'
      ? `Second opinion failed: ${finished.error ?? 'unknown error'}`
      : `Second opinion from ${finished.model}: ${finished.verdict === undefined ? 'see the pane' : verdictLine(finished.verdict)}`,
  )
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
    await $.command.register({
      name: 'second-opinion',
      description: "Have a different model critique Claude's last answer or plan",
      argumentHint: '[what to focus on]',
    })
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
  })
}
