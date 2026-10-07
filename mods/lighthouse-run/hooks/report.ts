import type { LighthouseRunAudit as Audit, LighthouseRunResult as Result } from '../types'

export const CATEGORY_IDS = ['performance', 'accessibility', 'best-practices', 'seo'] as const
export const CATEGORY_SHORT: Record<string, string> = { performance: 'Perf', accessibility: 'A11y', 'best-practices': 'Best', seo: 'SEO' }
const METRICS: [id: string, label: string][] = [
  ['first-contentful-paint', 'FCP'],
  ['largest-contentful-paint', 'LCP'],
  ['total-blocking-time', 'TBT'],
  ['cumulative-layout-shift', 'CLS'],
  ['speed-index', 'SI'],
]
const SKIPPED_GROUPS = new Set(['hidden', 'metrics'])
const TOP_AUDITS = 5
const ITEM_HINTS = 3

type Json = Record<string, unknown>

const objectAt = (value: unknown, key: string): Json | undefined => {
  const found = typeof value === 'object' && value !== null ? (value as Json)[key] : undefined
  return typeof found === 'object' && found !== null && !Array.isArray(found) ? (found as Json) : undefined
}
const stringAt = (value: Json | undefined, key: string): string | undefined => (typeof value?.[key] === 'string' ? (value[key] as string) : undefined)
const numberAt = (value: Json | undefined, key: string): number | undefined => (typeof value?.[key] === 'number' ? (value[key] as number) : undefined)

/** `[Learn more](https://…)` → `Learn more`, and the first sentence only. */
export const plainDescription = (markdown: string): string =>
  (markdown.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/`/g, '').split(/(?<=\.)\s/)[0] ?? '').trim()

/** Which elements or resources an audit points at: URLs, selectors or HTML snippets. */
const itemHints = (audit: Json): string[] => {
  const items = objectAt(audit, 'details')?.items
  if (!Array.isArray(items)) return []
  return items
    .slice(0, ITEM_HINTS)
    .map(item => {
      const node = objectAt(item, 'node')
      return stringAt(item as Json, 'url') ?? stringAt(node, 'snippet') ?? stringAt(node, 'selector') ?? ''
    })
    .filter(hint => hint !== '')
    .map(hint => (hint.length > 140 ? `${hint.slice(0, 139)}…` : hint))
}

/** Expected time savings of an audit, in ms: its own estimate or the largest metric it would improve. */
const savingsMs = (audit: Json): number => {
  const own = numberAt(objectAt(audit, 'details'), 'overallSavingsMs') ?? 0
  const metrics = objectAt(audit, 'metricSavings')
  const fromMetrics = Math.max(0, ...['LCP', 'FCP', 'TBT', 'INP'].map(key => numberAt(metrics, key) ?? 0))
  return Math.max(own, fromMetrics)
}

/**
 * Reads a Lighthouse JSON report: the four category scores (0–100), the core
 * metrics, and the failing audits most worth fixing, biggest win first.
 */
export const parseReport = (json: string): Result | { error: string } => {
  let lhr: Json
  try {
    lhr = JSON.parse(json) as Json
  } catch {
    return { error: 'Lighthouse did not print a JSON report.' }
  }
  const runtimeError = objectAt(lhr, 'runtimeError')
  if (runtimeError !== undefined) return { error: `Lighthouse could not load the page: ${stringAt(runtimeError, 'message') ?? stringAt(runtimeError, 'code') ?? 'unknown error'}` }
  const categories = objectAt(lhr, 'categories') ?? {}
  const audits = objectAt(lhr, 'audits') ?? {}

  const refs = new Map<string, { category: string; weight: number }>()
  for (const id of CATEGORY_IDS) {
    const auditRefs = objectAt(categories, id)?.auditRefs
    if (!Array.isArray(auditRefs)) continue
    for (const ref of auditRefs as Json[]) {
      const auditId = stringAt(ref, 'id') ?? ''
      if (SKIPPED_GROUPS.has(stringAt(ref, 'group') ?? '') || refs.has(auditId)) continue
      refs.set(auditId, { category: id, weight: numberAt(ref, 'weight') ?? 0 })
    }
  }

  const failing: (Audit & { impact: number })[] = []
  for (const [id, ref] of refs) {
    const audit = objectAt(audits, id)
    const score = numberAt(audit, 'score')
    const mode = stringAt(audit, 'scoreDisplayMode') ?? ''
    if (audit === undefined || score === undefined || score >= 0.9 || !['numeric', 'binary', 'metricSavings'].includes(mode)) continue
    const savings = savingsMs(audit)
    failing.push({
      id,
      title: stringAt(audit, 'title') ?? id,
      description: plainDescription(stringAt(audit, 'description') ?? ''),
      category: ref.category,
      displayValue: stringAt(audit, 'displayValue')?.replace(/\u00a0/g, ' ') ?? null,
      savingsMs: savings > 0 ? Math.round(savings) : null,
      items: itemHints(audit),
      impact: savings / 100 + ref.weight * (1 - score),
    })
  }
  failing.sort((a, b) => b.impact - a.impact)

  return {
    url: stringAt(lhr, 'finalDisplayedUrl') ?? stringAt(lhr, 'finalUrl') ?? stringAt(lhr, 'requestedUrl') ?? '',
    formFactor: stringAt(objectAt(lhr, 'configSettings'), 'formFactor') === 'desktop' ? 'desktop' : 'mobile',
    version: stringAt(lhr, 'lighthouseVersion') ?? '',
    scores: Object.fromEntries(
      CATEGORY_IDS.map(id => {
        const score = numberAt(objectAt(categories, id), 'score')
        return [id, score === undefined ? null : Math.round(score * 100)]
      }),
    ),
    metrics: METRICS.flatMap(([id, label]) => {
      const value = stringAt(objectAt(audits, id), 'displayValue')
      return value === undefined ? [] : [{ label, value: value.replace(/ /g, ' '), score: numberAt(objectAt(audits, id), 'score') ?? null }]
    }),
    audits: failing.slice(0, TOP_AUDITS).map(({ impact, ...audit }) => audit),
    warnings: Array.isArray(lhr.runWarnings) ? (lhr.runWarnings as unknown[]).filter((item): item is string => typeof item === 'string').slice(0, 3) : [],
  }
}

/** Lighthouse's own color bands: 90+ good, 50–89 needs work, below 50 poor. */
export const band = (score: number | null): 'success' | 'warning' | 'error' | 'inactive' =>
  score === null ? 'inactive' : score >= 90 ? 'success' : score >= 50 ? 'warning' : 'error'

const BAND_HEX = { success: '#0cce6b', warning: '#ffa400', error: '#ff4e42', inactive: '#9aa0a6' }

/** A Lighthouse-style score ring for surfaces that draw SVG. */
export const gaugeSvg = (score: number | null, label: string): string => {
  const color = BAND_HEX[band(score)]
  const radius = 34
  const circumference = 2 * Math.PI * radius
  const filled = score === null ? 0 : (circumference * score) / 100
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="112" viewBox="0 0 96 112">',
    `<circle cx="48" cy="44" r="${radius}" fill="${color}" fill-opacity="0.1" stroke="${color}" stroke-opacity="0.2" stroke-width="7"/>`,
    `<circle cx="48" cy="44" r="${radius}" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${filled.toFixed(1)} ${circumference.toFixed(1)}" transform="rotate(-90 48 44)"/>`,
    `<text x="48" y="52" text-anchor="middle" font-family="system-ui, sans-serif" font-size="24" font-weight="600" fill="${color}">${score ?? '?'}</text>`,
    `<text x="48" y="104" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#888">${label}</text>`,
    '</svg>',
  ].join('')
}

/** `+5`, `−3`, `±0`, or `new` when there is nothing to compare with. */
export const deltaText = (now: number | null, before: number | null | undefined): string => {
  if (now === null || before === null || before === undefined) return before === undefined ? 'new' : ''
  const delta = now - before
  return delta > 0 ? `+${delta}` : delta < 0 ? `−${-delta}` : '±0'
}

/** The prompt that asks Claude to fix the top issues. */
export const fixPrompt = (result: Result): string =>
  [
    `Lighthouse (${result.formFactor}) on ${result.url} scored ${CATEGORY_IDS.map(id => `${CATEGORY_SHORT[id]} ${result.scores[id] ?? '?'}`).join(', ')}.`,
    'Fix these top issues in this project\'s code (find the components, templates or config that produce them), then tell me what you changed:',
    '',
    ...result.audits.flatMap((audit, index) => [
      `${index + 1}. [${audit.category}] ${audit.title}${audit.displayValue === null ? '' : ` (${audit.displayValue})`}`,
      `   ${audit.description}`,
      ...audit.items.map(item => `   - ${item}`),
    ]),
  ].join('\n')
