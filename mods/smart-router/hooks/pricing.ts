// Prices per model family (copied from mods/token-budget) and what a usage costs. Pure: no `$` here.

import type { ModelUsage } from 'claude-code'

import type { SmartRouterFamily } from '../types'

/** US dollars per million tokens, at Anthropic's first-party API rates. */
export type Price = { input: number; output: number; cacheWrite: number; cacheRead: number }
/** A price table: the first pattern that matches a model id prices it. */
export type PriceTable = readonly (readonly [RegExp, Price])[]

const PER_MILLION = 1_000_000
/** A five-minute cache write costs 1.25 times the input rate. */
const CACHE_WRITE_FACTOR = 1.25
/** A cache read costs a tenth of the input rate, when an override leaves it out. */
const CACHE_READ_FACTOR = 0.1

const price = (input: number, output: number, cacheRead: number): Price => ({
  input,
  output,
  cacheWrite: input * CACHE_WRITE_FACTOR,
  cacheRead,
})

/** First match wins, so the more specific ids come first. */
export const PRICES: PriceTable = [
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

const finite = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined)

/**
 * The table with the configured overrides in front: a JSON object of model-id
 * substrings to `{ input, output, cacheRead?, cacheWrite? }` in $ per million
 * tokens. Entries that are not that shape are skipped.
 */
export function pricesWith(json: string): PriceTable {
  if (json.trim() === '') return PRICES
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return PRICES
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return PRICES
  const overrides: (readonly [RegExp, Price])[] = []
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = (value ?? {}) as Record<string, unknown>
    const input = finite(entry.input)
    const output = finite(entry.output)
    if (name.trim() === '' || input === undefined || output === undefined) continue
    const pattern = new RegExp(name.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    overrides.push([pattern, { input, output, cacheRead: finite(entry.cacheRead) ?? input * CACHE_READ_FACTOR, cacheWrite: finite(entry.cacheWrite) ?? input * CACHE_WRITE_FACTOR }])
  }
  return [...overrides, ...PRICES]
}

const priceOf = (model: string, table: PriceTable): Price => table.find(([pattern]) => pattern.test(model.toLowerCase()))?.[1] ?? FALLBACK

/** What a usage costs on `model`, in US dollars. */
export const costOf = (usage: ModelUsage, model: string, table: PriceTable = PRICES): number => {
  const rate = priceOf(model, table)
  return (
    (usage.input_tokens * rate.input +
      usage.output_tokens * rate.output +
      usage.cache_creation_input_tokens * rate.cacheWrite +
      usage.cache_read_input_tokens * rate.cacheRead) /
    PER_MILLION
  )
}

/** Fresh tokens: input, output and cache writes; cache reads re-read context already paid for. */
export const tokensOf = (usage: ModelUsage): number => usage.input_tokens + usage.output_tokens + usage.cache_creation_input_tokens

/** The family of a model alias or id; `other` for one this table does not know. */
export const familyOf = (model: string): SmartRouterFamily => {
  const id = model.toLowerCase()
  return /fable|mythos/.test(id) ? 'fable' : /opus/.test(id) ? 'opus' : /sonnet/.test(id) ? 'sonnet' : /haiku/.test(id) ? 'haiku' : 'other'
}

const FAMILY_RANK: Record<SmartRouterFamily, number | undefined> = { haiku: 0, sonnet: 1, opus: 2, fable: 3, other: undefined }

/** How strong a model is, haiku 0 to fable 3; undefined for an id no family names. */
export const modelRank = (model: string): number | undefined => FAMILY_RANK[familyOf(model)]
