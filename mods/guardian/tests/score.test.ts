import { expect, test } from 'claude-code/testing'

import { computeScore } from '../hooks/score'
import type { GuardStatus, ScoreInput } from '../hooks/score'

const guard = (name: string, weight: 1 | 2 | 3, patch: Partial<GuardStatus> = {}): GuardStatus => ({
  name, weight, isRecommended: true, isRelevant: true, isInstalled: true, isConfigured: true, isCoveredByFallback: false, ...patch,
})
const base: ScoreInput = { level: 'standard', guards: [], blocks: 0, secrets: 0, riskyAllowed: 0, isInstalledKnown: true }

test('everything installed and configured, nothing risky: 100 (A)', () => {
  const score = computeScore({ ...base, guards: [guard('rm-rf-guard', 3), guard('secret-shield', 3), guard('sql-safety', 1)] })
  expect(score.score).toBe(100)
  expect(score.grade).toBe('A')
  expect(score.fixes).toEqual([])
})

test('missing and unconfigured guards, secrets and risky commands cost points; the biggest fixes come first', () => {
  const score = computeScore({
    ...base,
    guards: [
      guard('rm-rf-guard', 3, { isInstalled: false }),
      guard('secret-shield', 3, { isConfigured: false }),
      guard('sql-safety', 1, { isInstalled: false }),
      guard('venv-guard', 1, { isInstalled: false, isRelevant: false }),
      guard('offline-mode', 1, { isInstalled: false, isRecommended: false }),
    ],
    blocks: 2,
    secrets: 1,
    riskyAllowed: 1,
  })
  // coverage 55*3/7 = 23.6, configuration 0, secrets 10, risky 5, blocks 3
  expect(score.score).toBe(42)
  expect(score.grade).toBe('D')
  expect(score.parts.map(part => part.points)).toEqual([23.6, 0, 10, 5, 3])
  expect(score.parts[0]?.detail).toContain('missing rm-rf-guard, sql-safety')
  expect(score.fixes.map(fix => fix.text)).toEqual(['Install rm-rf-guard', 'Apply the standard policy to 1 guard', 'Install sql-safety'])
  expect(score.fixes[0]).toMatchObject({ gain: 24, action: { kind: 'install', name: 'rm-rf-guard' } })
})

test('the strict fallback counts half for a missing guard it covers', () => {
  const missing = computeScore({ ...base, level: 'strict', guards: [guard('rm-rf-guard', 3, { isInstalled: false }), guard('x', 2)] })
  const covered = computeScore({ ...base, level: 'strict', guards: [guard('rm-rf-guard', 3, { isInstalled: false, isCoveredByFallback: true }), guard('x', 2)] })
  expect(covered.score - missing.score).toBe(17)
  expect(covered.fixes[0]?.gain).toBe(17)
})
