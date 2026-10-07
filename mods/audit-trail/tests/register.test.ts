import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { sha256Hex } from '../hooks/sha256'
import { redact, summarize } from '../hooks/summary'

const NOON = Date.UTC(2026, 9, 7, 12, 0, 0)
const LOG = '/repo/.claude/audit/2026-10-07.jsonl'
const SESSION = 'session-1'

// Built at run time so this file holds nothing a secret scanner would flag.
const fake = (prefix: string, body: string) => prefix + body
const GITHUB_TOKEN = fake('ghp_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8')

type ToolAnswer = { result: unknown; isError?: true; text?: string } | { deny: string }

/** The engine under the plugin: a virtual disk, a mocked clock, and tool calls answered by `answer`. */
const world = (
  on: On,
  files: Map<string, string>,
  answer: (e: { tool: string; command?: string }) => ToolAnswer = () => ({ result: 'ok' }),
  writes: { attempted: string[]; isFailing: boolean } = { attempted: [], isFailing: false },
) => {
  const clock = mock.clock(on, { now: NOON })
  const toasts: string[] = []
  on('session.id', () => ({ value: SESSION }))
  on('session.root', () => ({ value: '/repo' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.call', (_$, e) => answer(e as { tool: string; command?: string }))
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_$, e) => {
    const text = files.get(e.path)
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.write', (_$, e) => {
    writes.attempted.push(e.path)
    if (writes.isFailing) return { deny: 'EACCES' }
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', (_$, e) => {
    const prefix = `${e.path}/`
    const names = [...files.keys()].filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length))
    return { value: names.map(name => ({ name, kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { clock, toasts }
}

const lines = (files: Map<string, string>, path = LOG): Record<string, unknown>[] =>
  (files.get(path) ?? '')
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>)

const submit = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

test('logs a tool call as one JSON line with its summary, outcome and session', async ($, on) => {
  const files = new Map<string, string>()
  const { clock } = world(on, files)
  on('prompt.submit', (_$, e) => ({ text: e.text }))

  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' })
  await clock.settle()

  expect(lines(files)).toEqual([
    { ts: '2026-10-07T12:00:00.000Z', session: SESSION, kind: 'tool', tool: 'Bash', summary: 'npm test', outcome: 'ok' },
    { ts: '2026-10-07T12:00:00.000Z', session: SESSION, kind: 'tool', tool: 'Edit', summary: '/repo/src/app.ts', outcome: 'ok' },
  ])
})

test('marks denied and failed calls, and redacts secrets from the command', async ($, on) => {
  const files = new Map<string, string>()
  const { clock } = world(on, files, e => {
    if (e.command?.startsWith('rm')) return { deny: 'blocked' }
    if (e.command === 'git push') return { result: 'refused', isError: true, text: "Permission to use Bash has been denied by permission rule 'Bash(git push:*)'." }
    return e.command?.startsWith('false') ? { result: 'exit 1', isError: true, text: 'Exit code 1' } : { result: 'ok' }
  })

  await $.tool.call({ tool: 'Bash', command: 'rm -rf /' })
  await $.tool.call({ tool: 'Bash', command: 'git push' })
  await $.tool.call({ tool: 'Bash', command: 'false' })
  await $.tool.call({ tool: 'Bash', command: `curl -H "Authorization: Bearer ${GITHUB_TOKEN}" https://api.example.com --password hunter2` })
  await clock.settle()

  const entries = lines(files)
  expect(entries.map(entry => entry.outcome)).toEqual(['denied', 'denied', 'error', 'ok'])
  expect(String(entries[3]?.summary)).toContain('Authorization: Bearer [redacted]')
  expect(String(entries[3]?.summary)).toContain('--password [redacted]')
  expect(files.get(LOG)).not.toContain(GITHUB_TOKEN)
  expect(files.get(LOG)).not.toContain('hunter2')
})

test('logs the hash of a prompt by default, never its text', async ($, on) => {
  const files = new Map<string, string>()
  const { clock } = world(on, files)
  on('prompt.submit', (_$, e) => ({ text: e.text }))

  await submit($, 'fix the login bug')
  await clock.settle()

  const [entry] = lines(files)
  expect(entry).toMatchObject({ kind: 'prompt', origin: 'composer', outcome: 'ok', chars: 17, sha256: sha256Hex('fix the login bug') })
  expect(files.get(LOG)).not.toContain('login')
})

test('prompts can be logged as redacted text or left out', { options: { prompts: 'text' } }, async ($, on) => {
  const files = new Map<string, string>()
  const { clock } = world(on, files)
  on('prompt.submit', (_$, e) => ({ text: e.text }))

  await submit($, `deploy with TOKEN=${GITHUB_TOKEN} please`)
  await clock.settle()

  const [entry] = lines(files)
  expect(entry?.text).toBe('deploy with TOKEN=[redacted] please')
  expect(entry).not.toHaveProperty('sha256')
})

test('logs a prompt another mod dropped as denied', async ($, on) => {
  const files = new Map<string, string>()
  const { clock } = world(on, files)
  on('prompt.submit', () => ({ drop: 'not now' }))

  await submit($, 'hello')
  await clock.settle()

  expect(lines(files)[0]).toMatchObject({ kind: 'prompt', outcome: 'denied' })
})

test('logs how a turn ended, with its length and tokens', async ($, on) => {
  const files = new Map<string, string>()
  const { clock } = world(on, files)
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  await $.turn.complete({
    answer: 'Done.',
    durationMs: 4200,
    reason: 'answer',
    isAborted: false,
    turnId: 't1',
    usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, model: 'm' },
  })
  await $.turn.complete({ answer: '', durationMs: 900, reason: 'aborted', isAborted: true, turnId: 't2' })
  await clock.settle()

  expect(lines(files)).toEqual([
    expect.objectContaining({ kind: 'turn', outcome: 'ok', durationMs: 4200, inputTokens: 1000, outputTokens: 40 }),
    expect.objectContaining({ kind: 'turn', outcome: 'aborted', durationMs: 900 }),
  ])
})

test('appends to what the day already holds and keeps concurrent calls in order', async ($, on) => {
  const files = new Map([[LOG, '{"kind":"older"}\n']])
  const { clock } = world(on, files)

  await Promise.all([1, 2, 3].map(n => $.tool.call({ tool: 'Bash', command: `echo ${n}` })))
  await clock.settle()

  const entries = lines(files)
  expect(entries).toHaveLength(4)
  expect(entries[0]).toEqual({ kind: 'older' })
  expect(entries.slice(1).map(entry => entry.summary).sort()).toEqual(['echo 1', 'echo 2', 'echo 3'])
})

test('a log that is too big to read moves on to a numbered part', async ($, on) => {
  const files = new Map([[LOG, `${'x'.repeat(1_000_000)}\n`]])
  const { clock } = world(on, files)

  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.settle()

  expect(files.get(LOG)?.length).toBe(1_000_001)
  expect(lines(files, '/repo/.claude/audit/2026-10-07.2.jsonl')).toHaveLength(1)
})

test('writes to the configured directory, under the home folder for ~/', { options: { directory: '~/logs/claude' } }, async ($, on) => {
  const files = new Map<string, string>()
  const { clock } = world(on, files)
  mock.env(on, { HOME: '/home/ana' })

  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.settle()

  expect(lines(files, '/home/ana/logs/claude/2026-10-07.jsonl')).toHaveLength(1)
})

test('never holds up a tool call, and says once when the log cannot be written', async ($, on) => {
  const files = new Map<string, string>()
  const writes = { attempted: [] as string[], isFailing: true }
  const { clock, toasts } = world(on, files, undefined, writes)

  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(ran.deny).toBeUndefined()
  expect(writes.attempted).toEqual([]) // the write waits for the timer: the call did not

  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'ls again' })
  await clock.settle()

  expect(writes.attempted).toHaveLength(2)
  expect(toasts).toEqual(['could not write the audit log; actions are not being recorded'])
})

test('/audit counts today\'s entries and names the file', async ($, on) => {
  const files = new Map<string, string>()
  const { clock } = world(on, files, e => (e.command === 'rm x' ? { deny: 'no' } : { result: 'ok' }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true }).catch(() => undefined)

  await submit($, 'go')
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Bash', command: 'rm x' })
  await clock.settle()

  const shown = await $.command.run({
    command: 'audit',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

  expect(shown.text).toContain('3 entries logged today (2026-10-07)')
  expect(shown.text).toContain('2 tool calls (1 denied, 0 failed) · 1 prompts · 0 turns')
  expect(shown.text).toContain(LOG)
})

test('/audit says so when nothing was logged', async ($, on) => {
  const files = new Map<string, string>()
  world(on, files)

  const shown = await $.command.run({ command: 'audit', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

  expect(shown.text).toBe(`Nothing logged yet today. Entries go to /repo/.claude/audit/2026-10-07.jsonl.`)
})

test('sha256 matches the published test vectors', () => {
  expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  expect(sha256Hex('héllo 😀')).toHaveLength(64)
})

test('redact masks keys, tokens, URL passwords and secret assignments but not ordinary text', () => {
  expect(redact(`git clone https://ana:s3cret@github.com/a/b.git`)).toBe('git clone https://[redacted]@github.com/a/b.git')
  expect(redact(`export API_KEY="abc123" && run`)).toBe('export API_KEY="[redacted]" && run')
  expect(redact(`{"password": "p4ss"}`)).toBe('{"password": "[redacted]"}')
  expect(redact(`key ${fake('AKIA', 'Z7Q3M9XK2P4W8L5N')} here`)).toBe('key [redacted] here')
  expect(redact('npm run build -- --token abc123')).toBe('npm run build -- --token [redacted]')
  expect(redact('git commit -m "rotate tokens weekly"')).toBe('git commit -m "rotate tokens weekly"')
})

test('summarize names the subject of each tool, and only the argument names of an unknown one', () => {
  expect(summarize('Grep', { pattern: 'TODO', path: 'src' }, 200)).toBe('TODO in src')
  expect(summarize('WebFetch', { url: 'https://example.com', prompt: 'x' }, 200)).toBe('https://example.com')
  expect(summarize('TodoWrite', { todos: [{}, {}] }, 200)).toBe('2 todos')
  expect(summarize('mcp__db__query', { tool: 'mcp__db__query', sql: 'select 1' }, 200)).toBe('(sql)')
  expect(summarize('Bash', { command: `echo ${'a'.repeat(300)}` }, 20)).toHaveLength(20)
})

test('regression: redact masks curl -u passwords and mysql -p passwords', () => {
  expect(redact('curl -u admin:hunter2 https://api.example.com')).toBe('curl -u admin:[redacted] https://api.example.com')
  expect(redact('curl --user=admin:hunter2 https://x')).toBe('curl --user=admin:[redacted] https://x')
  expect(redact('mysql -u root -phunter2 shop')).toBe('mysql -u root -p[redacted] shop')
  expect(redact('mysql -u root -p shop && mkdir -p a/b && ssh -p 22 host')).toBe('mysql -u root -p shop && mkdir -p a/b && ssh -p 22 host')
})
