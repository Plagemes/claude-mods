import type { EngineInterface, PluginOptions, Register } from 'claude-code'

const MOD = 'speak-summary'
const COMMAND = 'speak'
const ENABLED_KEY = 'enabled'
const MAX_WORDS = 15
const ANSWER_EXCERPT_CHARS = 4_000
const SUMMARY_TIMEOUT_MS = 12_000
const SUMMARY_MAX_TOKENS = 80
const DEFAULT_MIN_SECONDS = 20
const DEFAULT_MODEL = 'haiku'
const TEST_PHRASE = 'Speak summary is working.'
const FALLBACK_PHRASE = 'Claude has finished.'

const SUMMARY_SYSTEM =
  'You write one short sentence that will be read aloud by a speech synthesizer. ' +
  `At most ${MAX_WORDS} words, plain words only: no markdown, no file paths, no code, no quotes. ` +
  'Describe what the assistant did, in the past tense, as if telling a colleague.'

type Settings = { minDurationMs: number; voice: string | undefined; model: string }

/** Per-load flags: one utterance at a time, and one warning when speech is missing. */
type Speaker = { isSpeaking: boolean; hasWarned: boolean }

function readSettings(options: PluginOptions): Settings {
  const seconds = typeof options.minDurationSec === 'number' ? options.minDurationSec : DEFAULT_MIN_SECONDS
  const voice = typeof options.voice === 'string' ? options.voice.trim() : ''
  const model = typeof options.model === 'string' ? options.model.trim() : ''

  return { minDurationMs: Math.max(0, seconds) * 1000, voice: voice || undefined, model: model || DEFAULT_MODEL }
}

/** Strips markdown and noise so the synthesizer reads clean words, capped at MAX_WORDS. */
function toSpeakable(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_#>|~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .trim()
  const words = plain.split(' ').filter(Boolean)
  if (words.length <= MAX_WORDS) return plain

  return `${words.slice(0, MAX_WORDS).join(' ').replace(/[,;:.]$/, '')}.`
}

/** The answer's first sentence, used when the model cannot be reached. */
function firstSentence(answer: string): string {
  return toSpeakable(answer.split(/(?<=[.!?])\s|\n/)[0] ?? '') || FALLBACK_PHRASE
}

async function isEnabled($: EngineInterface): Promise<boolean> {
  return (await $.store.get(ENABLED_KEY)) !== false
}

/** Speaks `text`; resolves the failure reason, or undefined once spoken. */
async function say($: EngineInterface, text: string, voice: string | undefined): Promise<string | undefined> {
  try {
    await $.audio.speak(text, { voice })
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function summarize($: EngineInterface, answer: string, settings: Settings): Promise<string> {
  if (!answer.trim()) return FALLBACK_PHRASE

  const reply = await $.model.complete({
    model: settings.model,
    system: SUMMARY_SYSTEM,
    prompt: `The assistant's final message:\n\n${answer.slice(0, ANSWER_EXCERPT_CHARS)}`,
    maxTokens: SUMMARY_MAX_TOKENS,
    effort: 'low',
    timeoutMs: SUMMARY_TIMEOUT_MS,
  })

  return (reply.isAnswered ? toSpeakable(reply.text) : '') || firstSentence(answer)
}

async function speakTurn($: EngineInterface, answer: string, settings: Settings, speaker: Speaker): Promise<void> {
  if (speaker.isSpeaking) return
  speaker.isSpeaking = true
  try {
    const failure = await say($, await summarize($, answer, settings), settings.voice)
    if (failure !== undefined && !speaker.hasWarned) {
      speaker.hasWarned = true
      $.ui.toast(`🔇 ${MOD}: cannot speak here (${failure}). /${COMMAND} off to silence.`)
    }
  } catch {
    // A failed summary never interrupts the session; the next long turn tries again.
  } finally {
    speaker.isSpeaking = false
  }
}

async function runCommand($: EngineInterface, args: string, settings: Settings): Promise<string> {
  const action = args.trim().toLowerCase()
  if (action === 'on' || action === 'off') {
    await $.store.set(ENABLED_KEY, action === 'on')
    return action === 'on' ? `🔊 ${MOD} is on.` : `🔇 ${MOD} is off.`
  }
  if (action === 'test') {
    const failure = await say($, TEST_PHRASE, settings.voice)
    return failure === undefined ? `🔊 ${MOD}: spoke a test phrase.` : `🔇 ${MOD}: cannot speak here (${failure}).`
  }
  if (action !== '' && action !== 'status') return `${MOD}: usage /${COMMAND} [on|off|test]`

  const state = (await isEnabled($)) ? '🔊 on' : '🔇 off'
  const seconds = settings.minDurationMs / 1000

  return `${MOD} is ${state} · speaks after turns of ${seconds}s or more · voice: ${settings.voice ?? 'system default'}`
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)
  const speaker: Speaker = { isSpeaking: false, hasWarned: false }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'speak',
      description: 'Speak a one-line summary when long turns end',
      argumentHint: '[on|off|test]',
    })

    return next(e)
  })

  on('command.run', { command: 'speak' }, async ($, e) => ({ text: await runCommand($, e.args, settings) }))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const isWorthSpeaking =
      e.agentId === undefined && e.reason === 'answer' && e.durationMs >= settings.minDurationMs

    if (isWorthSpeaking && !speaker.isSpeaking && (await isEnabled($))) {
      const answer = e.answer
      $.clock.after(0, () => void speakTurn($, answer, settings, speaker))
    }

    return result
  })
}
