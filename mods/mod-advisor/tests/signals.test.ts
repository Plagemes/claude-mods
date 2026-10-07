import { describe, expect, test } from 'claude-code/testing'

import { hasInstallSignal, SIGNAL_TOPICS, signalPicks } from '../hooks/signals'

describe('signals from the hub', () => {
  test('failing tests point at the test mods, a failed CI at issue drafting; passing runs point at nothing', () => {
    const picks = signalPicks(
      [
        { topic: 'test.result', data: { runner: 'vitest', outcome: 'failed', passed: 10, failed: 2 }, at: 1 },
        { topic: 'ci.result', data: { provider: 'github', workflow: 'test', outcome: 'failed', branch: 'main' }, at: 2 },
        { topic: 'test.result', data: { runner: 'vitest', outcome: 'passed', passed: 12, failed: 0 }, at: 3 },
      ],
      new Set(['ci-watch']),
    )
    expect(picks).toEqual([
      { name: 'issue-drafter', reason: 'CI failed on main' },
      { name: 'test-watch', reason: '2 tests failed' },
      { name: 'flaky-detector', reason: '2 tests failed' },
      { name: 'regression-guard', reason: '2 tests failed' },
    ])
  })

  test('the newest failure gives the reason; installed, dismissed or shown mods are left out', () => {
    const picks = signalPicks(
      [
        { topic: 'test.result', data: { outcome: 'failed', failed: 1 }, at: 1 },
        { topic: 'test.result', data: { outcome: 'error', passed: null, failed: null }, at: 5 },
      ],
      new Set(['test-watch', 'regression-guard']),
    )
    expect(picks).toEqual([{ name: 'flaky-detector', reason: 'your tests could not run' }])
    expect(signalPicks([{ topic: 'git.push', data: {}, at: 1 }], new Set())).toEqual([])
  })

  test('a mod installed anywhere is a signal to refresh; the topics read are the ones the hello names', () => {
    expect(hasInstallSignal([{ topic: 'mod.installed', data: { name: 'x', version: '1.0.0' }, at: 1 }])).toBe(true)
    expect(hasInstallSignal([{ topic: 'test.result', data: {}, at: 1 }])).toBe(false)
    expect([...SIGNAL_TOPICS].sort()).toEqual(['ci.result', 'mod.installed', 'test.result'])
  })
})
