import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { ModelAdvisorHint, ModelAdvisorTier } from '../types'
import { CLASSIFIER_SYSTEM, classifyLocally, tierFromReply } from './classify'
import type { Verdict } from './classify'
import { familyOf } from './shared/prices'

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
/** smart-router's routing policy on mods-hub's blackboard: its tiers' models are the ones worth suggesting. */
const ROUTER_POLICY = 'smart-router.policy'

const hint = atom({ plugin: 'model-advisor', key: 'hint' } as const, null)
const prompts = atom({ plugin: 'model-advisor', key: 'prompts' } as const, 0)
const lastSuggested = atom({ plugin: 'model-advisor', key: 'lastSuggested' } as const, {})
const isMuted = atom({ plugin: 'model-advisor', key: 'isMuted' } as const, false)

type Settings = { useModel: boolean; classifierModel: string; display: (typeof DISPLAYS)[number] }

/** The tier of the model the session runs, from its id or alias; an unknown one counts as standard. */
const tierOfModel = (model: string): ModelAdvisorTier =>
  /haiku/i.test(model) ? 'light' : /opus|fable|mythos/i.test(model) ? 'heavy' : 'standard'

/**
 * The alias worth switching to, if any: down for a simple task, up for a harder one. `aliases` are the models
 * of each tier (smart-router's when it shares them); one of the model already running is never suggested.
 */
const suggestionFor = (needed: ModelAdvisorTier, runningModel: string, aliases: Record<ModelAdvisorTier, string> = ALIAS): string | undefined => {
  const running = tierOfModel(runningModel)
  const alias = needed === 'light' ? (running === 'light' ? undefined : aliases.light) : RANK[needed] > RANK[running] ? aliases[needed] : undefined
  return alias === undefined || (familyOf(alias) !== 'other' && familyOf(alias) === familyOf(runningModel)) ? undefined : alias
}

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

// ── mods-hub: the router's models, and suggestions on the bus ───────────────────────────────────────

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
  await hubHello($, { version: await ownVersion($), publishes: ['x.model-advisor.suggested'], consumes: [ROUTER_POLICY] })
}

/**
 * The model of each tier, from smart-router's policy when mods-hub has it (its light/standard/deep models, so
 * the session and its subagents follow one profile: Saver, Fast, Max...); the defaults otherwise.
 */
async function tierAliases($: EngineInterface): Promise<Record<ModelAdvisorTier, string>> {
  try {
    const fact = await $.mods.read({ key: ROUTER_POLICY })
    const models = (fact?.value as { models?: Record<string, unknown> } | undefined)?.models
    const pick = (value: unknown, fallback: string): string => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)
    if (models === undefined || models === null) return ALIAS
    return { light: pick(models.light, ALIAS.light), standard: pick(models.standard, ALIAS.standard), heavy: pick(models.deep, ALIAS.heavy) }
  } catch {
    return ALIAS
  }
}

/** Classifies one prompt and shows, keeps or clears the suggestion. */
async function advise($: EngineInterface, text: string, settings: Settings): Promise<void> {
  if (await read($, isMuted)) return

  const count = await update($, prompts, n => n + 1)
  const verdict = await verdictFor($, text, settings)
  const model = verdict && suggestionFor(verdict.tier, await $.session.model(), await tierAliases($))
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

  if (!isFresh) return
  if (settings.display !== 'band') await hubNotify($, { level: 'info', title: headline(shown), audience: 'terminal' })
  await hubPublish($, { topic: 'x.model-advisor.suggested', data: { tier: shown.tier, model, reason: shown.reason } })
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
    await greetHub($)

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

// #region @vendored shared/hub-client.ts sha256:0acb840d81b7: edit the source, then run `node scripts/sync-shared.mjs`.
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
// #endregion @vendored shared/hub-client.ts
