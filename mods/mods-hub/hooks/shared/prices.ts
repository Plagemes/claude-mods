// @vendored shared/prices.ts sha256:97703d44d76c by scripts/sync-shared.mjs: edit the source, then run `node scripts/sync-shared.mjs`; never this copy.
/**
 * shared/prices.ts — the ONE price table (cost-meter, token-budget, daily-spend, smart-router, mods-hub ...).
 *
 * Extracted from mods/smart-router/hooks/pricing.ts (regex table, overrides, families) and
 * mods/cost-meter/hooks/pricing.ts (`isKnownModel`, the spend label), with the rates checked against
 * Anthropic's first-party price list (2026-09-25). Before this, four copies disagreed on the fallback
 * (Opus 5.5 vs Sonnet 5 rates) and only one knew the legacy Opus 4/4.1 rate.
 * Pure: no `$`, no I/O. Vendored into mods by scripts/sync-shared.mjs.
 */

/** US dollars per million tokens, at Anthropic's first-party API rates. */
export type Price = { input: number; output: number; cacheWrite: number; cacheRead: number }
/** A price table: the first pattern that matches a (lowercased) model id prices it. */
export type PriceTable = readonly (readonly [RegExp, Price])[]
/** The four token counts as the API (and `ModelUsage`) spells them. */
export type TokenUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}
export type ModelFamily = 'haiku' | 'sonnet' | 'opus' | 'fable' | 'other'
export type Costed = { usd: number; tokens: number; isKnownModel: boolean }

const PER_MILLION = 1_000_000
/** A five-minute cache write costs 1.25 times the input rate (the usage report does not say which TTL was used). */
export const CACHE_WRITE_FACTOR = 1.25
/** A cache read costs a tenth of the input rate where a model's rate is not listed otherwise. */
export const CACHE_READ_FACTOR = 0.1

const price = (input: number, output: number, cacheRead = input * CACHE_READ_FACTOR): Price => ({
  input,
  output,
  cacheWrite: input * CACHE_WRITE_FACTOR,
  cacheRead,
})

/** First match wins, so the more specific ids come first. */
export const PRICES: PriceTable = [
  [/(?:fable|mythos)-5-1/, price(10, 50, 0.25)],
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

/** An id no pattern knows is priced as the default model, Claude Opus 5.5, and flagged `isKnownModel: false`. */
export const FALLBACK_PRICE: Price = price(4, 20, 0.2)

const finite = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined)

/**
 * The table with user overrides in front: a JSON object of model-id substrings to
 * `{ input, output, cacheRead?, cacheWrite? }` in $ per million tokens. Bad entries are skipped.
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
    overrides.push([
      pattern,
      { input, output, cacheRead: finite(entry.cacheRead) ?? input * CACHE_READ_FACTOR, cacheWrite: finite(entry.cacheWrite) ?? input * CACHE_WRITE_FACTOR },
    ])
  }
  return [...overrides, ...PRICES]
}

/** The rate of a model id, and whether the table knows it. */
export function priceOf(model: string, table: PriceTable = PRICES): { price: Price; isKnownModel: boolean } {
  const found = table.find(([pattern]) => pattern.test(model.toLowerCase()))
  return found === undefined ? { price: FALLBACK_PRICE, isKnownModel: false } : { price: found[1], isKnownModel: true }
}

/** What a usage costs on `model`, in US dollars; `tokens` counts all four kinds. */
export function costOf(usage: TokenUsage, model: string, table: PriceTable = PRICES): Costed {
  const { price: rate, isKnownModel } = priceOf(model, table)
  const usd =
    (usage.input_tokens * rate.input +
      usage.output_tokens * rate.output +
      usage.cache_creation_input_tokens * rate.cacheWrite +
      usage.cache_read_input_tokens * rate.cacheRead) /
    PER_MILLION
  const tokens = usage.input_tokens + usage.output_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens
  return { usd, tokens, isKnownModel }
}

/** Fresh tokens: input, output and cache writes (cache reads re-read context already paid for). */
export const freshTokensOf = (usage: TokenUsage): number => usage.input_tokens + usage.output_tokens + usage.cache_creation_input_tokens

/** The family of a model alias or id; `other` for one this table does not know. */
export function familyOf(model: string): ModelFamily {
  const id = model.toLowerCase()
  return /fable|mythos/.test(id) ? 'fable' : /opus/.test(id) ? 'opus' : /sonnet/.test(id) ? 'sonnet' : /haiku/.test(id) ? 'haiku' : 'other'
}

const FAMILY_RANK: Record<ModelFamily, number | undefined> = { haiku: 0, sonnet: 1, opus: 2, fable: 3, other: undefined }

/** How strong a model is, haiku 0 to fable 3; undefined for an id no family names. */
export const modelRank = (model: string): number | undefined => FAMILY_RANK[familyOf(model)]

/** `$0.42`, `<$0.01`, or `~$0.42` when some of it was priced as a guess. */
export function formatUsd(usd: number, isGuess = false): string {
  const dollars = usd > 0 && usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`
  return isGuess ? `~${dollars}` : dollars
}

/** `950`, `128k`, `1.2M`. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  if (tokens < PER_MILLION) return `${Math.round(tokens / 1000)}k`
  return `${(tokens / PER_MILLION).toFixed(1)}M`
}
