// Sizing an issue: a compact re-implementation of smart-router's tier rules (nothing is imported from it), plus
// its learned rules when it left them in a file, and a rough effort and cost forecast. Pure: no `$` here.

import type { IssuePilotEstimate, IssuePilotSize, IssuePilotTier } from '../types'
import { costOf } from './shared/prices'
import type { PriceTable } from './shared/prices'

/** A learned correction, as smart-router keeps them: two of its keywords (all, for a shorter rule) decide the tier. */
export type LearnedRule = { keywords: string[]; tier: IssuePilotTier }

export type SizingInput = { title: string; body: string; labels: readonly string[]; points: number | null; criteria: number }

type Rule = readonly [tag: string, pattern: RegExp]

/** smart-router's default models per tier. */
export const TIER_MODELS: Record<IssuePilotTier, string> = { light: 'haiku', standard: 'sonnet', deep: 'opus' }
const TIER_ORDER: readonly IssuePilotTier[] = ['light', 'standard', 'deep']

// Work that needs the strongest model: risky subjects, root causes, design, many modules.
const DEEP: readonly Rule[] = [
  ['security', /\bsecurity\b|\bvulnerab\w*|\bcve-\d|\bxss\b|\bcsrf\b|\bssrf\b|\binjection\b|\bprivilege escalation\b/],
  ['auth', /\bauth(entication|orization)?\b|\boauth2?\b|\bsso\b|\bsaml\b|\bjwt\b|\bpermissions? model\b|\bencrypt\w*/],
  ['data', /\b(data|database|schema) migrations?\b|\bmigrate (the )?(data|database|users|records)\b|\bbackfill\w*\b|\bdata loss\b|\bdrop (the )?(table|column)\b/],
  ['concurrency', /\brace conditions?\b|\bdeadlocks?\b|\bconcurren(t|cy)\b|\bthread[- ]safe\w*\b|\bmutex\b/],
  ['performance', /\bmemory leaks?\b|\bbottlenecks?\b|\bperformance regression\b|\blatency\b|\bthroughput\b|\bout of memory\b|\bp9[59]\b/],
  ['architecture', /\barchitect\w*\b|\bredesign\b|\brewrite (the|our)\b|\bbreaking changes?\b|\bpublic api\b|\bacross (the )?(whole |entire )?(codebase|app|services)\b/],
  ['root cause', /\broot[- ]cause\b|\bintermittent(ly)?\b|\bflaky\b|\bnon-?deterministic\b|\binvestigat\w*\b|\bspike\b|\brfc\b|\btrade-?offs?\b/],
]
// Work a small model does well: docs, wording, mechanical chores.
const LIGHT: readonly Rule[] = [
  ['docs', /\btypos?\b|\bspelling\b|\breadme\b|\bdocs?\b|\bdocumentation\b|\bchangelog\b|\bcomments?\b/],
  ['copy', /\bwording\b|\bcopy (change|text)\b|\b(button|label|error) (text|copy|message)\b|\btranslat\w*\b|\bi18n\b/],
  ['chore', /\bbump\b|\bupgrade (the )?(dependency|dependencies|deps|version)\b|\brename\b|\blint( errors| warnings)?\b|\bformatting\b/],
]
// Ordinary engineering: a bug with a repro, a feature with a spec, tests, a refactor.
const STANDARD = /\bbug\b|\bfix\w*\b|\bcrash\w*\b|\bbroken\b|\berror\b|\bregression\b|\bimplement\w*\b|\badd\b|\bsupport\b|\bfeature\b|\brefactor\w*\b|\btests?\b|\bendpoint\b/

const DEEP_LABELS = /^(security|epic|architecture|breaking[- ]change|performance|spike|research|rfc|needs[- ]design)$/i
const LIGHT_LABELS = /^(documentation|docs|good first issue|typo|chore|dependencies|copy|i18n|trivial)$/i

const SIZE_FACTOR: Record<IssuePilotSize, number> = { S: 0.5, M: 1, L: 2.2, XL: 4.5 }
/** Minutes of Claude's work on an M issue, per tier. */
const BASE_MINUTES: Record<IssuePilotTier, number> = { light: 10, standard: 30, deep: 75 }
/** Tokens of an M issue's whole session per tier (tool results re-read from the prompt cache dominate). */
const BASE_TOKENS: Record<IssuePilotTier, number> = { light: 150_000, standard: 500_000, deep: 1_400_000 }
const SHARES = { input: 0.12, cached: 0.84, output: 0.04 }
const FILE_PATH = /(?:^|[\s`'"(])((?:[\w.-]+\/)+[\w.-]+\.\w{1,5})(?=$|[\s`'",:;).])/g

const hits = (text: string, rules: readonly Rule[]): string[] => rules.filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag)
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The learned rule a text matches best (newest wins a tie): smart-router's matching, re-implemented. */
export function learnedTier(text: string, rules: readonly LearnedRule[]): LearnedRule | undefined {
  const lower = text.toLowerCase()
  let best: { rule: LearnedRule; count: number } | undefined
  for (const rule of rules) {
    const count = rule.keywords.filter(word => new RegExp(`\\b${escape(word.toLowerCase())}`).test(lower)).length
    if (count > 0 && count >= Math.min(2, rule.keywords.length) && (best === undefined || count > best.count)) best = { rule, count }
  }
  return best?.rule
}

/** Reads smart-router's learned rules file (an array, or `{ rules: [...] }`); bad entries are skipped. */
export function parseLearnedRules(json: string | undefined): LearnedRule[] {
  if (json === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { rules?: unknown } | null)?.rules
  if (!Array.isArray(list)) return []
  return list.flatMap(item => {
    const entry = (item ?? {}) as { keywords?: unknown; tier?: unknown }
    const keywords = Array.isArray(entry.keywords) ? entry.keywords.filter((word): word is string => typeof word === 'string' && word !== '') : []
    const tier = TIER_ORDER.find(one => one === entry.tier)
    return keywords.length > 0 && tier !== undefined ? [{ keywords, tier }] : []
  })
}

/** The tier the work needs, and why. */
export function tierOf(input: SizingInput, rules: readonly LearnedRule[] = []): { tier: IssuePilotTier; reason: string } {
  const text = `${input.title}\n${input.body}`.toLowerCase()
  const learned = learnedTier(text, rules)
  if (learned !== undefined) return { tier: learned.tier, reason: `learned rule: ${learned.keywords.join(' + ')}` }
  const deepLabel = input.labels.find(label => DEEP_LABELS.test(label.trim()))
  if (deepLabel !== undefined) return { tier: 'deep', reason: `label ${deepLabel}` }
  const deep = hits(text, DEEP)
  if (deep.length > 0) return { tier: 'deep', reason: deep.join(', ') }
  const lightLabel = input.labels.find(label => LIGHT_LABELS.test(label.trim()))
  const light = hits(`${input.title}`.toLowerCase(), LIGHT)
  if (lightLabel !== undefined) return { tier: 'light', reason: `label ${lightLabel}` }
  if (light.length > 0 && !/\bbug\b|\bcrash\w*\b|\bbroken\b/.test(text)) return { tier: 'light', reason: light.join(', ') }
  return { tier: 'standard', reason: STANDARD.test(text) ? 'ordinary engineering' : 'no strong signal' }
}

/** How much work: story points when the tracker has them, else criteria, length and files named. */
export function sizeOf(input: SizingInput): IssuePilotSize {
  if (input.points !== null && input.points > 0) {
    return input.points <= 1 ? 'S' : input.points <= 3 ? 'M' : input.points <= 8 ? 'L' : 'XL'
  }
  const files = new Set([...input.body.matchAll(FILE_PATH)].map(match => match[1])).size
  const units = input.criteria + Math.floor(input.body.length / 700) + files
  return units <= 1 ? 'S' : units <= 4 ? 'M' : units <= 9 ? 'L' : 'XL'
}

/** A big job of a lighter kind still needs more than a small model's attention. */
const settle = (tier: IssuePilotTier, size: IssuePilotSize): IssuePilotTier => (tier === 'light' && (size === 'L' || size === 'XL') ? 'standard' : tier)

/** Tier, size, minutes and dollars for one issue. */
export function estimate(input: SizingInput, rules: readonly LearnedRule[] = [], prices?: PriceTable): IssuePilotEstimate {
  const rated = tierOf(input, rules)
  const size = sizeOf(input)
  const tier = settle(rated.tier, size)
  const factor = SIZE_FACTOR[size]
  const tokens = Math.round(BASE_TOKENS[tier] * factor)
  const model = TIER_MODELS[tier]
  const usage = {
    input_tokens: Math.round(tokens * SHARES.input),
    output_tokens: Math.round(tokens * SHARES.output),
    cache_read_input_tokens: Math.round(tokens * SHARES.cached),
    cache_creation_input_tokens: 0,
  }
  return {
    tier,
    size,
    minutes: Math.max(5, Math.round((BASE_MINUTES[tier] * factor) / 5) * 5),
    usd: Math.round(costOf(usage, model, prices).usd * 100) / 100,
    tokens,
    model,
    reason: tier === rated.tier ? rated.reason : `${rated.reason}; size ${size}`,
  }
}

/** `~25 min`, `~2 h`, `~1.5 h`. */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `~${minutes} min`
  const hours = Math.round((minutes / 60) * 2) / 2
  return `~${hours} h`
}
