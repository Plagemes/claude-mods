import { expect, test } from 'claude-code/testing'

import { classify } from '../hooks/classify'
import { HALF_LIFE_MS, EMPTY_PROJECT, isUnreliable, mergeDaily, opusShareOf, recordOutcome, scoreNow, TEST_COMMAND, weakSpots } from '../hooks/learning'
import { costOf, pricesWith } from '../hooks/shared/prices'
import { budgetAlertOf, decideRoute, guidanceText, PROFILES, tuningFor, withEffort } from '../hooks/routing'
import type { RouteSettings, SpawnFacts } from '../hooks/routing'

const SETTINGS: RouteSettings = { mode: 'auto', override: 'never', protectDeep: true, models: { light: 'haiku', standard: 'sonnet', deep: 'opus' }, budgetBias: 5, opusShare: 0 }
const FACTS: SpawnFacts = { subagentType: 'general-purpose', parentModel: 'claude-opus-5-5', isFork: false, isWorkflow: false, isTeammate: false }
const NO_HISTORY = { spentUsd: 0 }
const verdictOf = (prompt: string, subagentType?: string) => classify({ prompt, subagentType })

test('routes by tier; Explore goes to haiku; deep stays on opus', () => {
  expect(decideRoute(verdictOf('Find where the session cookie is set', 'Explore'), { ...FACTS, subagentType: 'Explore' }, SETTINGS, NO_HISTORY)).toEqual(expect.objectContaining({ action: 'routed', tier: 'light', model: 'haiku' }))
  expect(decideRoute(verdictOf('Write unit tests for slugify'), FACTS, SETTINGS, NO_HISTORY)).toEqual(expect.objectContaining({ action: 'routed', model: 'sonnet' }))
  expect(decideRoute(verdictOf('Do a security review of the upload endpoint'), FACTS, SETTINGS, NO_HISTORY)).toEqual(expect.objectContaining({ tier: 'deep', model: 'opus' }))
})

test('deep work is never routed below the main model while protect deep is on', () => {
  const deep = verdictOf('Design the architecture of the sync engine')
  const onFable = decideRoute(deep, { ...FACTS, parentModel: 'claude-fable-5' }, SETTINGS, NO_HISTORY)
  expect(onFable).toEqual(expect.objectContaining({ action: 'routed', tier: 'deep', model: undefined }))
  expect(onFable.reason).toContain('protect deep')
  expect(decideRoute(deep, { ...FACTS, parentModel: 'claude-fable-5' }, { ...SETTINGS, protectDeep: false }, NO_HISTORY).model).toBe('opus')
  expect(decideRoute(deep, { ...FACTS, parentModel: 'gateway-model-x' }, SETTINGS, NO_HISTORY).model).toBeUndefined()
})

test('an explicit model, a fork, a custom agent and a teammate keep their model; override=always routes them', () => {
  const light = verdictOf('List the TODO comments')
  expect(decideRoute(light, { ...FACTS, model: 'opus' }, SETTINGS, NO_HISTORY)).toEqual(expect.objectContaining({ action: 'kept', model: 'opus', tag: 'explicit' }))
  expect(decideRoute(light, { ...FACTS, model: 'opus' }, { ...SETTINGS, override: 'always' }, NO_HISTORY)).toEqual(expect.objectContaining({ action: 'routed', model: 'haiku' }))
  expect(decideRoute(light, { ...FACTS, isFork: true }, { ...SETTINGS, override: 'always' }, NO_HISTORY).action).toBe('kept')
  expect(decideRoute(light, { ...FACTS, subagentType: 'my-reviewer' }, SETTINGS, NO_HISTORY)).toEqual(expect.objectContaining({ action: 'kept', tag: 'own model' }))
  expect(decideRoute(light, { ...FACTS, isTeammate: true }, SETTINGS, NO_HISTORY).action).toBe('kept')
})

test('suggest mode and workflow agents only suggest', () => {
  const light = verdictOf('List the TODO comments')
  expect(decideRoute(light, FACTS, { ...SETTINGS, mode: 'suggest' }, NO_HISTORY)).toEqual(expect.objectContaining({ action: 'suggested', model: 'haiku' }))
  const workflow = decideRoute(light, { ...FACTS, isWorkflow: true }, SETTINGS, NO_HISTORY)
  expect(workflow).toEqual(expect.objectContaining({ action: 'suggested', model: 'haiku' }))
  expect(workflow.reason).toContain('opts.model')
})

test('a failed run is retried one tier up; twice failed is deep; a running twin is no retry', () => {
  const light = verdictOf('List the TODO comments')
  expect(decideRoute(light, FACTS, SETTINGS, { previous: { tier: 'light', failures: 1, outcome: 'failed' }, spentUsd: 0 })).toEqual(expect.objectContaining({ tier: 'standard', tag: 'retry↑', model: 'sonnet', isRetry: true }))
  expect(decideRoute(light, FACTS, SETTINGS, { previous: { tier: 'standard', failures: 2, outcome: 'failed' }, spentUsd: 0 })).toEqual(expect.objectContaining({ tier: 'deep', model: 'opus' }))
  expect(decideRoute(light, FACTS, SETTINGS, { previous: { tier: 'light', failures: 0, outcome: 'ok' }, spentUsd: 0 }).tier).toBe('standard')
  expect(decideRoute(light, FACTS, SETTINGS, { previous: { tier: 'light', failures: 0, outcome: 'running' }, spentUsd: 0 }).tier).toBe('light')
})

test('easy streaks drop one tier, never below light or for deep categories', () => {
  const tests = verdictOf('Write unit tests for slugify')
  expect(decideRoute(tests, FACTS, SETTINGS, { streak: { tier: 'standard', successes: 3 }, spentUsd: 0 })).toEqual(expect.objectContaining({ tier: 'light', tag: 'repeat↓' }))
  expect(decideRoute(tests, FACTS, SETTINGS, { streak: { tier: 'standard', successes: 2 }, spentUsd: 0 }).tier).toBe('standard')
  const security = verdictOf('Do a security review of the upload endpoint')
  expect(decideRoute(security, FACTS, SETTINGS, { streak: { tier: 'deep', successes: 9 }, spentUsd: 0 }).tier).toBe('deep')
})

test('budget bias moves only borderline work down, and says so', () => {
  const borderline = verdictOf('Update the config')
  const biased = decideRoute(borderline, FACTS, SETTINGS, { spentUsd: 6 })
  expect(biased).toEqual(expect.objectContaining({ tier: 'light', tag: 'budget↓', model: 'haiku' }))
  expect(biased.reason).toContain('session spend $6.00 passed the $5.00 budget bias')
  expect(decideRoute(borderline, FACTS, { ...SETTINGS, budgetBias: 0 }, { spentUsd: 60 }).tier).toBe('standard')
  expect(decideRoute(verdictOf('Write unit tests for slugify'), FACTS, SETTINGS, { spentUsd: 60 }).tier).toBe('standard')
})

test('unreliable kinds and fresh regressions go one tier up; the opus quota trims borderline deep work', () => {
  const tests = verdictOf('Write unit tests for slugify')
  expect(decideRoute(tests, FACTS, SETTINGS, { spentUsd: 0, isUnreliable: true })).toEqual(expect.objectContaining({ tier: 'deep', tag: 'unreliable↑' }))
  expect(decideRoute(tests, FACTS, SETTINGS, { spentUsd: 0, isRegression: true })).toEqual(expect.objectContaining({ tier: 'deep', tag: 'regression↑' }))
  expect(decideRoute(verdictOf('List the TODO comments'), FACTS, SETTINGS, { spentUsd: 0, isRegression: true }).tier).toBe('light')
  const weakDeep = verdictOf('Analyze why the dashboard is slow')
  expect(weakDeep).toEqual(expect.objectContaining({ tier: 'deep', isBorderline: true }))
  expect(decideRoute(weakDeep, FACTS, { ...SETTINGS, opusShare: 30 }, { spentUsd: 0, opusShare: 0.4 })).toEqual(expect.objectContaining({ tier: 'standard', tag: 'quota↓' }))
  expect(decideRoute(verdictOf('Do a security review of the upload endpoint'), FACTS, { ...SETTINGS, opusShare: 30 }, { spentUsd: 0, opusShare: 0.9 }).tier).toBe('deep')
})

test('the effort lever runs a well-scoped deep task on sonnet, nothing else', () => {
  const scoped = verdictOf('Fix the race condition in src/queue/worker.ts')
  const routed = decideRoute(scoped, FACTS, SETTINGS, NO_HISTORY)
  expect(withEffort(routed, scoped, SETTINGS.models)).toEqual(expect.objectContaining({ model: 'sonnet', tag: 'effort' }))
  const design = verdictOf('Design the architecture of the sync engine')
  expect(withEffort(decideRoute(design, FACTS, SETTINGS, NO_HISTORY), design, SETTINGS.models).model).toBe('opus')
})

test('profiles preset the tuning; Balanced is the configuration', () => {
  const base = { models: SETTINGS.models, protectDeep: true, maxParallel: 5, budgetBias: 5, opusShare: 0, auditRate: 10 }
  expect(tuningFor(base, 'balanced')).toBe(base)
  expect(tuningFor(base, 'saver')).toEqual(expect.objectContaining({ opusShare: 20, maxParallel: 3, budgetBias: 2 }))
  expect(tuningFor(base, 'max').models).toEqual(PROFILES.max.models)
  expect(tuningFor(base, 'fast')).toEqual(expect.objectContaining({ maxParallel: 8, auditRate: 0 }))
})

test('the guidance is stable and names the rules, the models and the workflow opt-in', () => {
  const text = guidanceText({ models: SETTINGS.models, maxParallel: 5, hasWorkflow: true, isAuto: true })
  expect(text).toBe(guidanceText({ models: SETTINGS.models, maxParallel: 5, hasWorkflow: true, isAuto: true }))
  expect(text).toContain('send all their Agent calls in ONE message')
  expect(text).toContain('- light → haiku:')
  expect(text).toContain('never start one on your own')
  expect(text).toContain('same shared context block')
  expect(text).toContain('ONE light agent as a list')
  expect(guidanceText({ models: { ...SETTINGS.models, deep: 'inherit' }, maxParallel: 3, hasWorkflow: false, isAuto: false })).not.toContain('Workflow')
})

test('outcome learning: failures lower a score, two make it unreliable, and time heals', () => {
  let project = recordOutcome(EMPTY_PROJECT, 'tests', 'light', false, 0)
  expect(isUnreliable(project, 'tests', 'light', 0)).toBe(false)
  project = recordOutcome(project, 'tests', 'light', false, 0)
  expect(isUnreliable(project, 'tests', 'light', 0)).toBe(true)
  expect(weakSpots(project, 0)[0]).toEqual(expect.objectContaining({ category: 'tests', tier: 'light', runs: 2, isLow: true }))
  expect(isUnreliable(project, 'tests', 'light', 2 * HALF_LIFE_MS)).toBe(false)
  const entry = project.reliability['tests|light']
  expect(entry === undefined ? 0 : scoreNow(entry, HALF_LIFE_MS)).toBeGreaterThan(entry?.score ?? 1)
  expect(isUnreliable(recordOutcome(project, 'tests', 'light', true, 0), 'tests', 'light', 0)).toBe(false)
  expect(opusShareOf({ haiku: 100, opus: 300 })).toBe(0.75)
  expect(TEST_COMMAND.test('cd app && npm test -- --watch=false')).toBe(true)
  expect(TEST_COMMAND.test('pytest -q tests/')).toBe(true)
  expect(TEST_COMMAND.test('git status')).toBe(false)
})

test('the daily summary adds only what changed since the last write, and starts over on a new day', () => {
  const first = mergeDaily(undefined, '2026-10-07', { saved: 1, spent: 3, byModel: { haiku: { calls: 2, tokens: 100, usd: 0.5 } } }, { saved: 0, spent: 0, byModel: {} })
  expect(first).toEqual({ date: '2026-10-07', saved: 1, spent: 3, byModel: { haiku: { calls: 2, tokens: 100, usd: 0.5 } } })
  const second = mergeDaily(first, '2026-10-07', { saved: 1.5, spent: 4, byModel: { haiku: { calls: 3, tokens: 150, usd: 0.6 } } }, { saved: 1, spent: 3, byModel: { haiku: { calls: 2, tokens: 100, usd: 0.5 } } })
  expect(second).toEqual({ date: '2026-10-07', saved: 1.5, spent: 4, byModel: { haiku: { calls: 3, tokens: 150, usd: 0.6 } } })
  expect(mergeDaily(second, '2026-10-08', { saved: 2, spent: 5, byModel: {} }, { saved: 1.5, spent: 4, byModel: {} }).spent).toBe(1)
})

test('prices: the built-in table, and overrides in front of it', () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  expect(costOf(usage, 'claude-haiku-4-5').usd).toBe(1)
  expect(costOf(usage, 'claude-haiku-4-5', pricesWith('{"haiku": {"input": 0.5, "output": 2}}')).usd).toBe(0.5)
  expect(costOf(usage, 'claude-sonnet-5', pricesWith('not json')).usd).toBe(2)
})

test('a budget alert from another mod (budget.threshold) moves borderline work down, unless the bias is off', () => {
  const alert = budgetAlertOf({ kind: 'usd', scope: 'session', used: 8.5, limit: 10, percent: 85 })
  expect(alert).toBe('the session dollar budget is 85% used')
  expect(budgetAlertOf({ kind: 'usd', scope: 'day', used: 5, limit: 10, percent: 50 })).toBeUndefined()
  expect(budgetAlertOf({ kind: 'tokens', scope: 'day', used: 2e6, limit: 1e6, percent: 200 })).toBe('the daily token budget is 200% used')

  const borderline = verdictOf('Update the config')
  const biased = decideRoute(borderline, FACTS, SETTINGS, { spentUsd: 0, budgetAlert: alert })
  expect(biased).toEqual(expect.objectContaining({ tier: 'light', tag: 'budget↓', model: 'haiku' }))
  expect(biased.reason).toContain('the session dollar budget is 85% used: borderline, one tier down')
  expect(decideRoute(borderline, FACTS, { ...SETTINGS, budgetBias: 0 }, { spentUsd: 0, budgetAlert: alert }).tier).toBe('standard')
  expect(decideRoute(verdictOf('Write unit tests for slugify'), FACTS, SETTINGS, { spentUsd: 0, budgetAlert: alert }).tier).toBe('standard')
})
