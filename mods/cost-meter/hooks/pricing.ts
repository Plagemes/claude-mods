/** USD per million tokens. */
export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type PriceTable = ReadonlyArray<readonly [fragment: string, price: Price]>

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export type Costed = { usd: number; tokens: number; isKnownModel: boolean }

const MILLION = 1_000_000

// First fragment found in the model id wins, so the specific ones come first. Cache writes are the
// 5-minute rate (1.25x input); the usage report does not say how long a write is cached for.
const BUILT_IN: PriceTable = [
  ['fable-5-1', { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }],
  ['mythos-5-1', { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }],
  ['fable', { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }],
  ['mythos', { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }],
  ['opus-5-5', { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }],
  ['opus', { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ['sonnet-5', { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
  ['sonnet', { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ['haiku', { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
]
const FALLBACK: Price = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** The user's override table from JSON; entries that are not `{ input, output, ... }` are ignored. */
export function parseOverrides(json: string): PriceTable {
  if (json.trim() === '') return []
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null) return []
    return Object.entries(parsed).flatMap(([fragment, raw]): Array<readonly [string, Price]> => {
      const entry = raw as Record<string, unknown> | null
      if (entry === null || typeof entry !== 'object' || !isNumber(entry.input) || !isNumber(entry.output)) return []
      return [[
        fragment.toLowerCase(),
        {
          input: entry.input,
          output: entry.output,
          cacheRead: isNumber(entry.cacheRead) ? entry.cacheRead : entry.input * 0.1,
          cacheWrite: isNumber(entry.cacheWrite) ? entry.cacheWrite : entry.input * 1.25,
        },
      ]]
    })
  } catch {
    return []
  }
}

export function costOf(model: string, usage: Usage, overrides: PriceTable): Costed {
  const id = model.toLowerCase()
  const found = [...overrides, ...BUILT_IN].find(([fragment]) => id.includes(fragment))
  const price = found?.[1] ?? FALLBACK
  const usd =
    (usage.input_tokens * price.input +
      usage.output_tokens * price.output +
      usage.cache_read_input_tokens * price.cacheRead +
      usage.cache_creation_input_tokens * price.cacheWrite) /
    MILLION
  const tokens = usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  return { usd, tokens, isKnownModel: found !== undefined }
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  if (tokens < MILLION) return `${Math.round(tokens / 1000)}k`
  return `${(tokens / MILLION).toFixed(1)}M`
}

/** `$0.42 · 128k tok`, or `~$0.42 · 128k tok` when some turn was priced as a guess. */
export function formatSpend(spend: { usd: number; tokens: number; hasUnpricedModel: boolean }, showTokens: boolean): string {
  const dollars = spend.usd > 0 && spend.usd < 0.01 ? '<$0.01' : `$${spend.usd.toFixed(2)}`
  const guess = spend.hasUnpricedModel ? '~' : ''
  return showTokens ? `${guess}${dollars} · ${formatTokens(spend.tokens)} tok` : `${guess}${dollars}`
}
