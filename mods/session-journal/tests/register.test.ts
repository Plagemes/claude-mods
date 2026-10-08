import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandRunInput, ModelForkResult, On, SessionMessage, TurnCompleteInput } from 'claude-code'

import { fakeHub } from './hub'

/** The mock clock of the running test, moved on past afterStart's delay so the hub hello is sent. */
let startClock: ReturnType<typeof mock.clock> | undefined

const ROOT = '/home/me/shop'
const TODAY = `${ROOT}/.claude/journal/2026-10-07.md`
const USAGE = { input_tokens: 5, output_tokens: 50, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 }
const SUMMARY = '### Work done\n- Fixed the login redirect loop\n\n### Open questions\n- Should sessions expire after 7 days?'

const MESSAGES: SessionMessage[] = [
  { role: 'user', text: 'Fix the login redirect loop', toolUses: [] },
  {
    role: 'assistant',
    text: 'Fixing it.',
    toolUses: [
      { tool_use_id: 't1', tool: 'Edit', input: { file_path: `${ROOT}/src/auth.ts`, old_string: 'a', new_string: 'b' }, text: 'ok' },
      { tool_use_id: 't2', tool: 'Bash', input: { command: 'npm test' }, text: 'pass' },
      {
        tool_use_id: 't3',
        tool: 'TodoWrite',
        input: {
          todos: [
            { content: 'Fix redirect', status: 'completed', activeForm: 'Fixing' },
            { content: 'Add a regression test', status: 'pending', activeForm: 'Adding' },
          ],
        },
        text: 'ok',
      },
    ],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'ok', isError: false }] },
  { role: 'user', text: 'Now add a regression test', toolUses: [] },
  { role: 'assistant', text: 'Done.', toolUses: [{ tool_use_id: 't4', tool: 'Write', input: { file_path: `${ROOT}/test/auth.test.ts`, content: 'x' }, text: 'ok' }] },
]

const TURN: TurnCompleteInput = { answer: 'Done.', durationMs: 4_000, isAborted: false, turnId: 'turn-2', reason: 'answer' }

type World = { files: Map<string, string>; forks: number }

/** A two-prompt session in /home/me/shop on branch main, on 2026-10-07 at 18:05 local time. */
function world(on: On, reply: ModelForkResult, files: Record<string, string> = {}): World {
  const seen: World = { files: new Map(Object.entries(files)), forks: 0 }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 'abcdef1234567890' }))
  on('session.turns', () => ({ value: 2 }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('model.fork', () => {
    seen.forks += 1
    return { value: reply }
  })
  on('fs.read', ($, e) => {
    const text = seen.files.get(e.path)
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.write', ($, e) => {
    seen.files.set(e.path, e.text)
    return { value: undefined }
  })
  return seen
}

const startAt = (on: On) => (startClock = mock.clock(on, { now: new Date(2026, 9, 7, 18, 5).getTime() }))

async function start($: Engine, isInteractive = true): Promise<void> {
  await $.session.start({ cwd: ROOT, surface: isInteractive ? 'terminal' : null, isInteractive })
}

async function end($: Engine, reason: 'prompt_input_exit' | 'clear' = 'prompt_input_exit'): Promise<void> {
  await $.session.end({ reason, sessionId: 'abcdef1234567890', resume: { id: 'abcdef1234567890' } })
}

const journalCommand: CommandRunInput = {
  command: 'journal',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
}

test('on exit, writes a dated entry with the idle summary, files, requests and open todos', async ($, on) => {
  const clock = startAt(on)
  const seen = world(on, { isAnswered: true, text: `Here you go:\n\n${SUMMARY}`, usage: USAGE })
  await start($)
  await clock.advance(0)

  await $.turn.complete(TURN)
  await clock.advance(90_000)
  expect(seen.forks).toBe(1)
  await end($)

  const entry = seen.files.get(TODAY) ?? ''
  expect(entry.startsWith('# Journal · 2026-10-07\n\n## 18:06 · shop · main\n\n### Work done\n- Fixed the login redirect loop')).toBe(true)
  expect(entry).not.toContain('Here you go')
  expect(entry).toContain('### Files changed\n- `src/auth.ts`\n- `test/auth.test.ts`')
  expect(entry).toContain('### Requests\n- Fix the login redirect loop\n- Now add a regression test')
  expect(entry).toContain('### Open todos\n- [ ] Add a regression test')
  expect(entry).toContain('_2 prompts · 1 command · session abcdef12 · ended: prompt_input_exit_')
})

test('a new prompt before the idle delay cancels the background summary', async ($, on) => {
  const clock = startAt(on)
  const seen = world(on, { isAnswered: true, text: SUMMARY, usage: USAGE })
  await start($)

  await $.turn.complete(TURN)
  await clock.advance(60_000)
  await $.prompt.submit({ text: 'one more thing', wait: false, origin: { kind: 'composer' } })
  await clock.advance(60_000)
  expect(seen.forks).toBe(0)

  await end($)
  expect(seen.files.get(TODAY)).not.toContain('### Work done')
  expect(seen.files.get(TODAY)).toContain('### Requests')
})

test('/journal writes now, appends to the day file, and exit adds no duplicate', async ($, on) => {
  const clock = startAt(on)
  const seen = world(on, { isAnswered: true, text: SUMMARY, usage: USAGE }, { [TODAY]: '# Journal · 2026-10-07\n\n## 09:00 · shop\n\nMorning work.\n' })
  await start($)
  await clock.advance(0)

  const result = await $.command.run(journalCommand)
  expect(result.text).toBe('📓 session-journal: added an entry to .claude/journal/2026-10-07.md.')
  await end($)

  const day = seen.files.get(TODAY) ?? ''
  expect(day).toContain('Morning work.\n\n## 18:05 · shop · main')
  expect(day.match(/^## /gm)).toHaveLength(2)
  expect(day).toContain('written with /journal')
})

test('/clear is skipped by default and failures still leave a factual entry', async ($, on) => {
  const clock = startAt(on)
  const seen = world(on, { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE })
  await start($)
  await clock.advance(0)

  await end($, 'clear')
  expect(seen.files.size).toBe(0)

  const result = await $.command.run(journalCommand)
  expect(result.text).toContain('(no summary: api-error)')
  expect(seen.files.get(TODAY)).toContain('### Files changed')
})

test('journals /clear when asked to', { options: { includeClear: true } }, async ($, on) => {
  startAt(on)
  const seen = world(on, { isAnswered: false, reason: 'nothing-to-fork' })
  await start($)
  await end($, 'clear')
  expect(seen.files.get(TODAY)).toContain('ended: clear')
})

test('headless runs are never journaled', async ($, on) => {
  startAt(on)
  const seen = world(on, { isAnswered: false, reason: 'nothing-to-fork' })
  await start($, false)
  await end($)
  expect(seen.files.size).toBe(0)
})

test('with mods-hub: the entry lists the commits, decisions, lessons and last test run other mods reported, and is published', async ($, on) => {
  const clock = startAt(on)
  const seen = world(on, { isAnswered: true, text: SUMMARY, usage: USAGE })
  const hub = fakeHub(on)
  const at = clock.now()
  hub.events.push(
    { topic: 'git.commit', source: 'commit-composer', at, data: { sha: '1a2b3c4d5e6f', message: 'fix: stop the login redirect loop\n\nbody', branch: 'main', files: 2 } },
    { topic: 'decision.recorded', source: 'decision-log', at, data: { title: 'Expire sessions after 7 days', path: 'docs/decisions/0004-expire-sessions.md' } },
    { topic: 'lesson.learned', source: 'lessons-learned', at, data: { lesson: 'Clear the session cookie in auth tests.' } },
    { topic: 'test.result', source: 'mods-hub', at, data: { runner: 'jest', outcome: 'failed', passed: 10, failed: 1 } },
    { topic: 'test.result', source: 'test-watch', at, data: { runner: 'vitest', outcome: 'passed', passed: 12, failed: 0 } },
    { topic: 'cost.update', source: 'mods-hub', at, data: { turnUsd: 0.1, sessionUsd: 0.4231, model: 'claude-opus-5-5', tokens: 900, isEstimate: false } },
  )

  await start($)
  await startClock?.advance(1_500) // the hello waits for session.start to return (afterStart)
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve()
  expect(hub.hellos[0]?.publishes).toEqual(['x.session-journal.entry'])
  expect(hub.hellos[0]?.consumes).toContain('decision.recorded')
  await end($)

  const entry = seen.files.get(TODAY) ?? ''
  expect(entry).toContain('### Commits\n- `1a2b3c4` fix: stop the login redirect loop')
  expect(entry).toContain('### Decisions\n- Expire sessions after 7 days (`docs/decisions/0004-expire-sessions.md`)')
  expect(entry).toContain('### Lessons\n- Clear the session cookie in auth tests.')
  expect(entry).toContain('### Last test run\n- ✓ 12 passed (vitest)')
  expect(entry).toContain('_2 prompts · 1 command · $0.42 · session abcdef12 · ended: prompt_input_exit_')
  expect(hub.published).toEqual([
    { topic: 'x.session-journal.entry', data: { path: '.claude/journal/2026-10-07.md', project: 'shop', turns: 2, ending: 'ended: prompt_input_exit' }, scope: 'global' },
  ])
})

test('without mods-hub the entry has no bus sections', async ($, on) => {
  startAt(on)
  const seen = world(on, { isAnswered: true, text: SUMMARY, usage: USAGE })
  await start($)
  await end($)
  const entry = seen.files.get(TODAY) ?? ''
  expect(entry).not.toContain('### Commits')
  expect(entry).not.toContain('### Last test run')
  expect(entry).toContain('_2 prompts · 1 command · session abcdef12')
})
