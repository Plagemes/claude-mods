import { expect, test } from 'claude-code/testing'

import { bar, bump, currentStreak, dayBefore, emptyPending, emptyProgress, merge, noteToolCall, readProgress, settleDays, statsOf, unlockReached } from '../hooks/progress'
import { ACHIEVEMENTS, bashCounts, isPluginInstall, languageOf, reportsFailure, testRunnerOf } from '../hooks/table'

test('the table has about 25 achievements with unique ids and reachable goals', () => {
  expect(ACHIEVEMENTS.length).toBeGreaterThanOrEqual(24)
  expect(new Set(ACHIEVEMENTS.map(achievement => achievement.id)).size).toBe(ACHIEVEMENTS.length)
  expect(ACHIEVEMENTS.every(achievement => achievement.goal >= 1 && achievement.title !== '' && achievement.description !== '')).toBe(true)
})

test('reads what a shell command counts toward', () => {
  expect(bashCounts('git add -A && git commit -m "feat: x" && git push origin main')).toEqual({ commits: 1, pushes: 1 })
  expect(bashCounts('git commit --dry-run')).toEqual({})
  expect(bashCounts('git checkout -b feat/login')).toEqual({ branches: 1 })
  expect(bashCounts('git switch -c fix/bug && git branch spare')).toEqual({ branches: 2 })
  expect(bashCounts('git branch -d old')).toEqual({})
  expect(bashCounts('gh pr create --fill')).toEqual({ prs: 1 })
  expect(bashCounts('claude plugin install celebrate@claude-mods --scope user')).toEqual({ mods: 1 })
  expect(testRunnerOf('npm run test -- --watch=false')).toBe('npm test')
  expect(testRunnerOf('pnpm build')).toBeUndefined()
  expect(reportsFailure('Tests: 2 failed, 10 passed')).toBe(true)
  expect(reportsFailure('Tests: 0 failed, 10 passed')).toBe(false)
  expect(isPluginInstall(['/opt/claude-code/bin/claude', 'plugin', 'install', 'x@claude-mods', '--json'], 0)).toBe(true)
  expect(isPluginInstall(['/opt/claude-code/bin/claude', 'plugin', 'install', 'x@claude-mods'], 1)).toBe(false)
  expect(isPluginInstall(['git', 'plugin', 'install'], 0)).toBe(false)
  expect([languageOf('/a/b.tsx'), languageOf('main.go'), languageOf('README.md'), languageOf('.env')]).toEqual(['TypeScript', 'Go', undefined, undefined])
})

test('streaks count back over month ends; a missed day breaks them', () => {
  expect(dayBefore('2026-03-01')).toBe('2026-02-28')
  expect(dayBefore('2026-01-01')).toBe('2025-12-31')
  expect(currentStreak(['2026-02-27', '2026-02-28', '2026-03-01'], '2026-03-01')).toBe(3)
  expect(currentStreak(['2026-02-27', '2026-02-28'], '2026-03-01')).toBe(2)
  expect(currentStreak(['2026-02-26', '2026-02-28'], '2026-03-02')).toBe(0)
})

test('sessions saving side by side add their counts up instead of overwriting', () => {
  const stored = readProgress({ counters: { prompts: 10, bestStreak: 4 }, unlocked: { 'first-prompt': 5 }, languages: ['Go'] })
  const memory = readProgress({ counters: { prompts: 7, bestStreak: 2 }, unlocked: { 'green-1': 9 }, languages: ['Rust'] })
  const pending = emptyPending()
  bump(memory, pending, 'prompts', 2)
  noteToolCall(memory, pending, '2026-10-06', false)

  const merged = merge(stored, memory, pending)
  expect(merged.counters).toEqual({ prompts: 12, bestStreak: 4 })
  expect(merged.unlocked).toEqual({ 'green-1': 9, 'first-prompt': 5 })
  expect(merged.languages).toEqual(['Go', 'Rust'])
  expect(merged.daily).toEqual({ '2026-10-06': { tools: 1, errors: 0 } })
  expect(readProgress('garbage')).toEqual(emptyProgress())
})

test('reaching goals unlocks achievements, ten of them unlock the hunter too; finished clean days are flawless', () => {
  const progress = emptyProgress()
  const pending = emptyPending()
  for (let call = 0; call < 25; call += 1) noteToolCall(progress, pending, '2026-10-06', false)
  settleDays(progress, '2026-10-06')
  expect(progress.flawlessDays).toEqual([])
  settleDays(progress, '2026-10-07')
  expect(progress.flawlessDays).toEqual(['2026-10-06'])

  for (const counter of ['prompts', 'commits', 'greenRuns', 'prs', 'subagents', 'checklists', 'mods'] as const) bump(progress, pending, counter)
  progress.counters.nightOwl = 1
  progress.counters.weekend = 1
  const unlocked = unlockReached(progress, '2026-10-07', 42)
  expect(unlocked.map(achievement => achievement.id)).toEqual([
    'first-prompt', 'first-subagent', 'first-mod', 'first-commit', 'first-pr', 'green-1', 'checklist', 'flawless-day', 'night-owl', 'weekend', 'hunter-10',
  ])
  expect(progress.unlocked['hunter-10']).toBe(42)
  expect(unlockReached(progress, '2026-10-07', 43)).toEqual([])
  expect(statsOf(progress, '2026-10-07').unlocked).toBe(11)
  expect(bar(4, 10, 10)).toBe('████░░░░░░')
  expect(bar(12, 10, 5)).toBe('█████')
})

test('regression: only a command that runs a test runner counts as a test run', () => {
  expect(testRunnerOf('npx jest --watch=false')).toBe('jest')
  expect(testRunnerOf('cd app && CI=1 npm test')).toBe('npm test')
  expect(testRunnerOf('python -m pytest -x')).toBe('pytest')
  expect(testRunnerOf('poetry run pytest')).toBe('pytest')
  expect(testRunnerOf('npm run test:unit')).toBe('npm test')
  expect(testRunnerOf('cat jest.config.js')).toBeUndefined()
  expect(testRunnerOf('npm install -D vitest')).toBeUndefined()
  expect(testRunnerOf('pip install pytest')).toBeUndefined()
  expect(testRunnerOf('grep -rn pytest .')).toBeUndefined()
  expect(testRunnerOf('rm -rf .pytest_cache')).toBeUndefined()
})
