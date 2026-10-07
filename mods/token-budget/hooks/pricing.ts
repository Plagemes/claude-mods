import type { ModelUsage } from 'claude-code'

/** US dollars per million tokens, at Anthropic's first-party API rates. */
type Price = { input: number; output: number; cacheWrite: number; cacheRead: number }

const PER_MILLION = 1_000_000
/** A five-minute cache write costs 1.25 times the input rate. */
const CACHE_WRITE_FACTOR = 1.25

const price = (input: number, output: number, cacheRead: number): Price => ({
  input,
  output,
  cacheWrite: input * CACHE_WRITE_FACTOR,
  cacheRead,
})

/** First match wins, so the more specific ids come first. */
const PRICES: readonly (readonly [RegExp, Price])[] = [
  [/(fable|mythos)-5-1/, price(10, 50, 0.25)],
  [/fable|mythos/, price(10, 50, 1)],
  [/opus-5-5/, price(4, 20, 0.2)],
  [/opus-4-[01]\b|opus-4-20\d{6}|3-opus/, price(15, 75, 1.5)],
  [/opus/, price(5, 25, 0.5)],
  [/sonnet-5/, price(2, 10, 0.2)],
  [/sonnet/, price(3, 15, 0.3)],
  [/3-5-haiku/, price(0.8, 4, 0.08)],
  [/3-haiku/, price(0.25, 1.25, 0.03)],
  [/haiku/, price(1, 5, 0.1)],
]

/** An id none of the patterns knows is priced as the default model, Opus 5.5. */
const FALLBACK = price(4, 20, 0.2)

const priceOf = (model: string): Price =>
  PRICES.find(([pattern]) => pattern.test(model.toLowerCase()))?.[1] ?? FALLBACK

/** What one turn's usage cost, in US dollars. */
export const costOf = (usage: ModelUsage & { model: string }): number => {
  const rate = priceOf(usage.model)

  return (
    (usage.input_tokens * rate.input +
      usage.output_tokens * rate.output +
      usage.cache_creation_input_tokens * rate.cacheWrite +
      usage.cache_read_input_tokens * rate.cacheRead) /
    PER_MILLION
  )
}

/** Fresh tokens: input, output and cache writes; cache reads re-read context already paid for. */
export const tokensOf = (usage: ModelUsage): number =>
  usage.input_tokens + usage.output_tokens + usage.cache_creation_input_tokens
