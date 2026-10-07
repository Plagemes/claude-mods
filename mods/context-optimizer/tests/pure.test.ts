import { expect, test } from 'claude-code/testing'

import { carryText, compactInstructions, decisionsIn, focusOf, isEmptyCarry, makeCarry, remember } from '../hooks/carry'
import { detectMoment, isNewTopic, keywords, milestoneOf } from '../hooks/moments'
import type { MomentInput } from '../hooks/moments'
import { checkRead, dedupeNote, readKey } from '../hooks/reads'
import { isTrimmable, resultText, toolPatterns, trimText } from '../hooks/trim'

test('trimming keeps head, tail and the error lines; short results and never-trimmed tools are left alone', () => {
  const lines = Array.from({ length: 2_000 }, (_, i) => (i === 1_200 ? 'src/app.ts:12 error TS2304: cannot find name' : `match ${i}: const value = ${i}`))
  const text = lines.join('\n')
  const trimmed = trimText(text, { maxChars: 4_000, tool: 'Grep' }) ?? ''
  expect(trimmed.length).toBeLessThan(5_200)
  expect(trimmed.startsWith('match 0:')).toBe(true)
  expect(trimmed.endsWith('match 1999: const value = 1999')).toBe(true)
  expect(trimmed).toContain('1201: src/app.ts:12 error TS2304')
  expect(trimmed).toContain('[context-optimizer: lines')
  expect(trimText('short', { maxChars: 4_000, tool: 'Grep' })).toBeUndefined()
  expect(trimText(text, { maxChars: 0, tool: 'Grep' })).toBeUndefined()

  const blob = `{"items":[${'1,'.repeat(20_000)}2]}`
  const cut = trimText(blob, { maxChars: 1_000, tool: 'mcp__db__query' }) ?? ''
  expect(cut).toContain('characters of this mcp__db__query result cut')
  expect(cut.length).toBeLessThan(1_300)

  const patterns = toolPatterns('Bash, Grep ,mcp__*')
  expect(isTrimmable('Grep', patterns)).toBe(true)
  expect(isTrimmable('mcp__github__search', patterns)).toBe(true)
  expect(isTrimmable('WebFetch', patterns)).toBe(false)
  expect(isTrimmable('Read', toolPatterns('*'))).toBe(false)
  expect(resultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb')
  expect(resultText([{ type: 'image', source: {} }])).toBeUndefined()
})

test('compaction moments: commit, green tests, a finished todo list, a new topic; never below the threshold or twice in a row', () => {
  expect(milestoneOf('git add -A && git commit -m "feat: login"', '')).toBe('commit')
  expect(milestoneOf('gh pr create --fill', '')).toBe('commit')
  expect(milestoneOf('npx vitest run', ' Test Files  3 passed (3)\n      Tests  41 passed (41)')).toBe('tests')
  expect(milestoneOf('npx vitest run', ' Tests  2 failed | 39 passed (41)')).toBeUndefined()
  expect(milestoneOf('cat jest.config.js', '')).toBeUndefined()

  const base: MomentInput = { percent: 70, suggestAt: 55, milestone: undefined, isTodoListDone: false, isTopicChange: false, openTodos: 0, turn: 10, lastSuggestedTurn: undefined, cooldownTurns: 6 }
  expect(detectMoment({ ...base, milestone: 'commit' })).toBe('commit')
  expect(detectMoment({ ...base, milestone: 'tests' })).toBe('tests')
  expect(detectMoment({ ...base, isTodoListDone: true })).toBe('todos')
  expect(detectMoment({ ...base, isTopicChange: true, milestone: 'commit' })).toBe('topic')
  expect(detectMoment(base)).toBeUndefined()
  expect(detectMoment({ ...base, milestone: 'commit', percent: 40 })).toBeUndefined()
  expect(detectMoment({ ...base, milestone: 'commit', percent: undefined })).toBeUndefined()
  expect(detectMoment({ ...base, milestone: 'commit', openTodos: 2 })).toBeUndefined()
  expect(detectMoment({ ...base, milestone: 'commit', lastSuggestedTurn: 7 })).toBeUndefined()
  expect(detectMoment({ ...base, milestone: 'commit', lastSuggestedTurn: 4 })).toBe('commit')

  const recent = [keywords('Fix the login form validation so empty passwords are rejected'), keywords('Also show the validation error under the password field')]
  expect(isNewTopic(recent, 'Now the password reset email: the validation error text is wrong')).toBe(false)
  expect(isNewTopic(recent, 'Set up a GitHub Actions workflow that deploys the docs site to Pages nightly')).toBe(true)
  expect(isNewTopic(recent, 'ok thanks')).toBe(false)
  expect(isNewTopic([], 'Set up a GitHub Actions workflow that deploys the docs site')).toBe(false)
})

test('carry-over: decisions from prompts, the focus string, the note and the compaction instructions', () => {
  expect(decisionsIn("Let's use pnpm instead of npm. The build is slow? Never commit the .env file! ok")).toEqual(["Let's use pnpm instead of npm.", 'Never commit the .env file!'])
  expect(remember(['a', 'b'], ['c', 'a'], 3)).toEqual(['a', 'c', 'b'])

  const carry = makeCarry({ at: 1, turn: 14, decisions: ['Use pnpm, not npm'], todos: ['Add the reset email', 'Write the migration'], files: ['src/auth.ts', 'src/email.ts'], tests: '✓ 41 passed' })
  expect(focusOf(carry)).toBe('Keep the decisions (Use pnpm, not npm), the open todos (Add the reset email; Write the migration), the files in play (src/auth.ts, src/email.ts).')
  const note = carryText(carry)
  expect(note).toContain('(turn 14)')
  expect(note).toContain('- Decisions: Use pnpm, not npm')
  expect(note).toContain('- Open todos: Add the reset email | Write the migration')
  expect(note).toContain('- Files in play: src/auth.ts, src/email.ts')
  expect(note).toContain('- Last test run: ✓ 41 passed')
  expect(compactInstructions(carry)).toContain('- Files in play: src/auth.ts, src/email.ts')
  const empty = makeCarry({ at: 1, turn: 1, decisions: [], todos: [], files: [] })
  expect(isEmptyCarry(empty)).toBe(true)
  expect(focusOf(empty)).toBe('Keep the current task, what is done and what is next.')
})

test('repeated reads: same range, same file, same epoch, recent, and not right after a note', () => {
  const key = readKey({ file_path: '/app/a.ts', offset: 10, limit: 50 })
  expect(key).not.toBe(readKey({ file_path: '/app/a.ts' }))
  const entry = { turn: 3, mtimeMs: 100, size: 2_000, epoch: 0 }
  const now = { turn: 5, epoch: 0 }
  expect(checkRead(entry, { mtimeMs: 100, size: 2_000 }, now, false)).toEqual({ isRepeat: true, turn: 3 })
  expect(checkRead(entry, { mtimeMs: 101, size: 2_000 }, now, false).isRepeat).toBe(false)
  expect(checkRead(entry, { mtimeMs: 100, size: 2_000 }, { turn: 5, epoch: 1 }, false).isRepeat).toBe(false)
  expect(checkRead(entry, { mtimeMs: 100, size: 2_000 }, { turn: 40, epoch: 0 }, false).isRepeat).toBe(false)
  expect(checkRead(entry, { mtimeMs: 100, size: 2_000 }, now, true).isRepeat).toBe(false)
  expect(checkRead(undefined, { mtimeMs: 100, size: 2_000 }, now, false).isRepeat).toBe(false)
  expect(dedupeNote('src/a.ts', 3, 12_345)).toContain('already read src/a.ts at turn 3; unchanged since, so this 12,345-character copy was left out')
})
