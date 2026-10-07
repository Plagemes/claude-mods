import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { ModelAdvisorHint, ModelAdvisorTier } from '../types'
import { CLASSIFIER_SYSTEM, classifyLocally, tierFromReply } from './classify'
import type { Verdict } from './classify'

const NAME = 'model-advisor'
/** Prompts before a suggestion that was dismissed or replaced may show again. */
const REPEAT_AFTER = 4
const CLASSIFY_TIMEOUT_MS = 10_000
const CLASSIFY_MAX_TOKENS = 5
const MAX_CLASSIFIED_CHARS = 4_000
const DEFAULT_CLASSIFIER = 'haiku'
const DISPLAYS = ['band', 'toast', 'both'] as const
/** The prompts a person typed, at the terminal or through Remote Control. */
const PERSON_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge'])
const RANK: Record<ModelAdvisorTier, number> = { light: 0, standard: 1, heavy: 2 }
const ALIAS: Record<ModelAdvisorTier, string> = { light: 'haiku', standard: 'sonnet', heavy: 'opus' }

const hint = atom({ plugin: 'model-advisor', key: 'hint' } as const, null)
const prompts = atom({ plugin: 'model-advisor', key: 'prompts' } as const, 0)
const lastSuggested = atom({ plugin: 'model-advisor', key: 'lastSuggested' } as const, {})
const isMuted = atom({ plugin: 'model-advisor', key: 'isMuted' } as const, false)

type Settings = { useModel: boolean; classifierModel: string; display: (typeof DISPLAYS)[number] }

/** The tier of the model the session runs, from its id or alias; an unknown one counts as standard. */
const tierOfModel = (model: string): ModelAdvisorTier =>
  /haiku/i.test(model) ? 'light' : /opus|fable|mythos/i.test(model) ? 'heavy' : 'standard'

/** The alias worth switching to, if any: down for a simple task, up for a harder one. */
const suggestionFor = (needed: ModelAdvisorTier, running: ModelAdvisorTier): string | undefined =>
  needed === 'light' ? (running === 'light' ? undefined : ALIAS.light) : RANK[needed] > RANK[running] ? ALIAS[needed] : undefined

const headline = ({ tier, model, reason }: ModelAdvisorHint): string =>
  tier === 'light'
    ? `Simple task (${reason}): /model ${model} would do`
    : tier === 'heavy'
      ? `Hard task (${reason}): /model ${model} is stronger`
      : `More than a quick edit: /model ${model} is safer`

/** The local verdict, or the classifier model's when it is asked and answers; none for a continuation. */
async function verdictFor($: EngineInterface, text: string, settings: Settings): Promise<Verdict | undefined> {
  const local = classifyLocally(text)
  if (local === undefined || !settings.useModel) return local

  const reply = await $.model.complete({
    model: settings.classifierModel,
    system: CLASSIFIER_SYSTEM,
    prompt: `<request>\n${text.slice(0, MAX_CLASSIFIED_CHARS)}\n</request>`,
    maxTokens: CLASSIFY_MAX_TOKENS,
    effort: 'low',
    timeoutMs: CLASSIFY_TIMEOUT_MS,
  })
  const tier = reply.isAnswered ? tierFromReply(reply.text) : undefined

  if (tier === undefined) return local

  return { tier, reason: tier === local.tier ? local.reason : `rated ${tier} by ${settings.classifierModel}` }
}

/** Classifies one prompt and shows, keeps or clears the suggestion. */
async function advise($: EngineInterface, text: string, settings: Settings): Promise<void> {
  if (await read($, isMuted)) return

  const count = await update($, prompts, n => n + 1)
  const verdict = await verdictFor($, text, settings)
  const model = verdict && suggestionFor(verdict.tier, tierOfModel(await $.session.model()))
  const showing = await read($, hint)
  const last = model === undefined ? undefined : (await read($, lastSuggested))[model]
  const isFresh = model !== undefined && showing?.model !== model
  const isRecent = last !== undefined && count - last < REPEAT_AFTER

  if (verdict === undefined || model === undefined || (isFresh && isRecent)) {
    await update($, hint, () => null)
    return
  }

  const shown: ModelAdvisorHint = { tier: verdict.tier, model, reason: verdict.reason, prompt: count }
  await update($, lastSuggested, before => ({ ...before, [model]: count }))
  await update($, hint, () => shown)

  if (isFresh && settings.display !== 'band') $.ui.toast(headline(shown))
}

/** `advise`, its failure logged rather than thrown: a suggestion is never worth an error. */
async function adviseQuietly($: EngineInterface, text: string, settings: Settings): Promise<void> {
  try {
    await advise($, text, settings)
  } catch (error) {
    $.ui.log(`${NAME}: no suggestion for this prompt: ${String(error)}`, { to: 'debug' })
  }
}

/** Puts `/model <alias>` in the prompt box for the person to send, and clears the hint. */
async function typeSwitch($: EngineInterface, model: string): Promise<void> {
  const filled = await $.prompt.fill({ text: `/model ${model}` })
  if (!filled.isFilled) $.ui.toast(`Type /model ${model} to switch`)
  await update($, hint, () => null)
}

export const register: Register = (on, options: PluginOptions) => {
  const display = DISPLAYS.find(one => one === options.display) ?? 'band'
  const settings: Settings = {
    useModel: options.useModel === true,
    classifierModel:
      typeof options.classifierModel === 'string' && options.classifierModel.trim() !== ''
        ? options.classifierModel.trim()
        : DEFAULT_CLASSIFIER,
    display,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'model-advisor',
      description: 'Turn model suggestions on or off for this session',
      argumentHint: '[on | off]',
      immediate: true,
    })

    return next(e)
  })

  on('command.run', { command: 'model-advisor' }, async ($, e) => {
    const word = e.args.trim().toLowerCase()
    const willMute = word === 'off' ? true : word === 'on' ? false : !(await read($, isMuted))
    await update($, isMuted, () => willMute)
    if (willMute) await update($, hint, () => null)

    return { text: willMute ? 'Suggestions off for this session.' : 'Suggestions on.' }
  })

  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)

    if (entered.drop === undefined && PERSON_ORIGINS.has(e.origin.kind)) {
      // The turn starts once this hook returns: the classifier model's call (up to 10 s) runs after it, the local rules at once.
      if (settings.useModel) $.clock.after(0, () => void adviseQuietly($, entered.text, settings))
      else await adviseQuietly($, entered.text, settings)
    }

    return entered
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (settings.display === 'toast' || e.props.hasSurvey) return next(e)

    const shown = await read($, hint)
    if (shown === null || (await read($, isMuted))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const isCheaper = shown.tier === 'light'
    // Other plugins' bands draw beneath this one rather than being replaced by it.
    const below = await next(e)

    return (
      <Box flexDirection="column">
        <Box gap={1} flexWrap="wrap">
          <Text color={isCheaper ? 'success' : 'warning'}>{isCheaper ? '↓' : '↑'}</Text>
          <Text wrap="truncate-end">{headline(shown)}</Text>
          <Button key="use" label={`Type /model ${shown.model}`} hotkey="u" onPress={() => void typeSwitch($, shown.model)} />
          <Button key="dismiss" label="Dismiss" hotkey="d" onPress={() => void update($, hint, () => null)} />
          <Button key="mute" label="Mute" hotkey="m" onPress={() => void update($, isMuted, () => true)} />
        </Box>
        {below}
      </Box>
    )
  })
}
