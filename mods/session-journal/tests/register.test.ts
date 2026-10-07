import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandRunInput, ModelForkResult, On, SessionMessage, TurnCompleteInput } from 'claude-code'

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

const startAt = (on: On) => mock.clock(on, { now: new Date(2026, 9, 7, 18, 5).getTime() })

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
