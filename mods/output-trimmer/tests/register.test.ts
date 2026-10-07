import { test, expect } from 'claude-code/testing'
import type { On } from 'claude-code'

/** A build log of `count` lines with a failure buried in the middle. */
const buildLog = (count: number): string =>
  Array.from({ length: count }, (_, i) =>
    i === 500 ? 'src/app.ts(12,3): error TS2345: wrong argument' : i === 501 ? 'npm WARN deprecated left-pad' : `compiling module ${i + 1}`,
  ).join('\n')

/** Stands for Bash beneath the plugin: it prints `output.stdout`; the status lines are recorded. */
const answerBash = (on: On, stdout: string) => {
  const output = { stdout, status: [] as (string | undefined)[] }
  on('tool.call', () => ({ result: { stdout: output.stdout, stderr: '', interrupted: false } }))
  on('ui.status', ($, e) => {
    output.status.push(e.text)
    return { value: undefined }
  })

  return output
}

const stdoutOf = (ran: { result?: unknown }): string => (ran.result as { stdout: string }).stdout

test('a huge output keeps its head, tail and error lines, and the status counts the saving', async ($, on) => {
  const log = buildLog(2_000)
  const { status } = answerBash(on, log)

  const ran = await $.tool.call({ tool: 'Bash', command: 'npm run build' })
  const stdout = stdoutOf(ran)
  const lines = stdout.split('\n')

  expect(stdout.length).toBeLessThan(log.length / 5)
  expect(lines[0]).toBe('compiling module 1')
  expect(lines[59]).toBe('compiling module 60')
  expect(lines.at(-1)).toBe('compiling module 2000')
  expect(stdout).toContain('1,860 lines cut (lines 61-1,920)')
  expect(stdout).toContain('501: src/app.ts(12,3): error TS2345: wrong argument')
  expect(stdout).toContain('502: npm WARN deprecated left-pad')
  expect(stdout).not.toContain('compiling module 1000')
  expect(status.at(-1)).toMatch(/^✂ [\d.]+k tokens trimmed from 1 output$/)
})

test('short outputs and "# no-trim" commands pass through whole', async ($, on) => {
  const log = buildLog(2_000)
  const { status } = answerBash(on, log)

  expect(stdoutOf(await $.tool.call({ tool: 'Bash', command: 'cat build.log # no-trim' }))).toBe(log)
  expect(status).toHaveLength(0)
})

test('the thresholds come from the configuration', { options: { maxChars: 100_000, headLines: 5, tailLines: 5 } }, async ($, on) => {
  const output = answerBash(on, buildLog(2_000))
  expect(stdoutOf(await $.tool.call({ tool: 'Bash', command: 'npm run build' }))).not.toContain('output-trimmer')

  output.stdout = buildLog(30_000)
  const lines = stdoutOf(await $.tool.call({ tool: 'Bash', command: 'npm run build' })).split('\n')
  expect(lines[4]).toBe('compiling module 5')
  expect(lines[5]).toContain('29,990 lines cut')
  expect(lines.at(-1)).toBe('compiling module 30000')
})

test('an errored result is trimmed where its row is kept, for the model only', async ($, on) => {
  const stored: unknown[] = []
  on('ui.status', () => ({ value: undefined }))
  on('session.append', ($, e, next) => {
    stored.push(e.message.content)
    return next(e)
  })

  const failure = `Exit code 1\n${buildLog(2_000)}`
  // The kit keeps no rows beneath the plugins, so the append rejects at the bottom;
  // what reached the bottom is the row the model would read.
  const appended = $.session.append({
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'Bash' },
    uuid: 'row-1',
    message: {
      type: 'user',
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call-1', is_error: true, content: failure }],
    },
  })
  await appended.catch(() => undefined)

  const [block] = stored[0] as { content: string; is_error: boolean }[]
  expect(block?.is_error).toBe(true)
  expect(block?.content.startsWith('Exit code 1\ncompiling module 1\n')).toBe(true)
  expect(block?.content).toContain('502: src/app.ts(12,3): error TS2345: wrong argument')
  expect(block?.content.length).toBeLessThan(failure.length / 5)
})
