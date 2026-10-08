import type { EngineInterface, Register } from 'claude-code'

/** Prompts typed by a person, as opposed to notifications, scheduled runs and other plugins. */
const PERSON_ORIGINS: readonly string[] = ['composer', 'bridge']
const TOAST_MS = 7000
const SHORT_PROMPT_WORDS = 3
const BROKEN_REPORT_WORDS = 8
const SHORT_PROMPT_CHARS = 12

/** A prompt for a built-in mode (slash command, `!` shell, `#` memory), which is not a request to lint. */
const NOT_A_REQUEST = /^\s*[/!#]/
const LATIN_ONLY = /^[\u0000-ɏ]*$/

/** Signs that the prompt names something: a file, path, identifier, number, link, quote or @mention. */
const NAMES_A_TARGET = /[\w-]+\.[a-z]{1,5}\b|[\\/]\S|`[^`]+`|[a-z][A-Z]|\w_\w|@\S|#\d|https?:|"[^"]+"|\d/
const BROKEN_REPORT =
  /\b(doesn'?t|does not|don'?t|do not|isn'?t|is not|won'?t|still not|not) (work|working|works)\b|\b(still )?(broken|failing|crash(es|ing)?)\b/
const VAGUE_FIX =
  /^(please )?(can you |could you )?(fix|solve|debug|improve|update|change|check|handle|finish|redo) (it|this|that|them|these|those|everything|things?|stuff)( (up|now|please|again))?$/

const ACTION_VERBS = new Set([
  'fix', 'add', 'update', 'change', 'refactor', 'improve', 'implement', 'write', 'make', 'optimize', 'optimise',
  'clean', 'rewrite', 'remove', 'delete', 'rename', 'debug', 'handle', 'finish', 'build', 'create',
])
const PRONOUN_WORDS = new Set([
  'it', 'this', 'that', 'them', 'these', 'those', 'there', 'here', 'the', 'a', 'please', 'pls', 'now', 'again',
  'too', 'also', 'and', 'then', 'just', 'so', 'one', 'thing', 'things', 'stuff', 'something', 'anything', 'everything',
])
/** Short replies and one-word commands that are complete requests on their own. */
const COMPLETE_SHORT_PROMPTS = new Set([
  'yes', 'no', 'ok', 'okay', 'y', 'n', 'yep', 'nope', 'sure', 'thanks', 'thank you', 'thx', 'continue', 'go', 'go on',
  'go ahead', 'proceed', 'stop', 'cancel', 'done', 'next', 'retry', 'again', 'undo', 'revert', 'commit', 'push', 'test',
  'tests', 'build', 'lint', 'status', 'diff', 'lgtm', 'great', 'nice', 'cool', 'perfect', 'good', 'fine', 'right',
  'correct', 'exactly',
])

/** The tip for the first way a prompt looks vague; undefined when it looks specific enough. */
const tipFor = (text: string): string | undefined => {
  if (NOT_A_REQUEST.test(text) || !LATIN_ONLY.test(text)) return undefined

  const plain = text.toLowerCase().replace(/[.!,]+/g, ' ').replace(/\s+/g, ' ').trim()
  const words = plain.match(/[a-z0-9']+/g) ?? []
  const hasTarget = NAMES_A_TARGET.test(text)
  const isQuestion = text.trim().endsWith('?')

  if (words.length <= BROKEN_REPORT_WORDS && BROKEN_REPORT.test(plain) && !hasTarget) {
    return 'Say what happened versus what you expected, and paste the exact error.'
  }
  if (VAGUE_FIX.test(plain.replace(/\?$/, ''))) {
    return 'Say what to change and where: a file, a function or an error message.'
  }
  if (words.length > 0 && words.every(word => PRONOUN_WORDS.has(word))) {
    return 'Name what you mean: a file, a function, an error or a ticket.'
  }
  if (words.length <= SHORT_PROMPT_WORDS && ACTION_VERBS.has(words[0] ?? '') && !hasTarget) {
    return 'Name the file, function or ticket you mean.'
  }
  const isTinyAndUnclear =
    words.length <= 2 && plain.length < SHORT_PROMPT_CHARS && !hasTarget && !isQuestion && !COMPLETE_SHORT_PROMPTS.has(plain)
  return isTinyAndUnclear ? 'Add the goal and any constraint, so Claude does not have to guess.' : undefined
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
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: [] })
}

/** The toast, with its own timeout, when there is no hub; an `info` notification through mods-hub when it is installed. */
async function notice($: EngineInterface, title: string, timeoutMs: number): Promise<void> {
  if ((await hubMode($)) === undefined) $.ui.toast(title, { timeoutMs })
  else await hubNotify($, { level: 'info', title })
}

export const register: Register = (on, options) => {
  const isStrict = options.strict === true
  let heldBack: string | undefined

  on('session.start', async ($, e, next) => {
    afterStart($, 'prompt-lint', () => greetHub($))
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const isOrdinary =
      PERSON_ORIGINS.includes(e.origin.kind) && e.turnId === undefined && (e.attachments?.length ?? 0) === 0
    const tip = isOrdinary ? tipFor(e.text) : undefined
    if (tip === undefined) return next(e)

    if (!isStrict) {
      await notice($, tip, TOAST_MS)
      return next(e)
    }

    if (heldBack === e.text) {
      heldBack = undefined
      return next(e)
    }
    heldBack = e.text
    return { drop: `prompt-lint: this prompt looks vague. ${tip} Send it again unchanged to go ahead anyway.` }
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
