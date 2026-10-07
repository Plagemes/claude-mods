import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

type Run = { argv: readonly string[]; env?: Record<string, string> }

const KERNELS: Record<string, string> = { macos: 'Darwin\n', linux: 'Linux\n' }

// Stands for the engine: answers uname with the given kernel and records every other command.
const host = (on: On, kernel: string, options: { isNotifierBroken?: boolean } = {}) => {
  const runs: Run[] = []
  mock.env(on, kernel === 'windows' ? { OS: 'Windows_NT' } : {})
  on('session.cwd', () => ({ value: '/home/me/shop' }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.Notification', () => ({}))
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'uname') {
      return { value: { exitCode: 0, stdout: KERNELS[kernel] ?? 'Plan9\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    runs.push({ argv: e.argv, env: e.init?.env })
    return options.isNotifierBroken === true
      ? { deny: 'no such program' }
      : { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return runs
}

const longTurn = { answer: 'All 12 tests pass now.', durationMs: 95_000, isAborted: false, turnId: 't1', reason: 'answer' } as const

test('runs notify-send on Linux when a long turn finishes', async ($, on) => {
  const runs = host(on, 'linux')

  await $.turn.complete(longTurn)

  expect(runs).toHaveLength(1)
  expect(runs[0]?.argv.slice(0, 3)).toEqual(['notify-send', '--app-name', 'Claude Code'])
  expect(runs[0]?.argv).toContain('Claude Code · shop')
  expect(runs[0]?.argv.at(-1)).toBe('Finished in 1m 35s: All 12 tests pass now.')
})

test('stays quiet for short, aborted and subagent turns', async ($, on) => {
  const runs = host(on, 'linux')

  await $.turn.complete({ ...longTurn, durationMs: 4_000 })
  await $.turn.complete({ ...longTurn, isAborted: true, reason: 'aborted' })
  await $.turn.complete({ ...longTurn, agentId: 'agent-1' })

  expect(runs).toHaveLength(0)
})

test('hands osascript the text as arguments on macOS', async ($, on) => {
  const runs = host(on, 'macos')

  await $.turn.complete({ ...longTurn, answer: 'Renamed "foo" to \\"bar\\"' })

  const argv = runs[0]?.argv ?? []
  expect(argv[0]).toBe('osascript')
  expect(argv.join(' ')).toContain('display notification (item 1 of argv) with title (item 2 of argv)')
  expect(argv.at(-2)).toBe('Finished in 1m 35s: Renamed "foo" to \\"bar\\"')
  expect(argv.at(-1)).toBe('Claude Code · shop')
})

test('shows a PowerShell toast on Windows, text in the environment', async ($, on) => {
  const runs = host(on, 'windows')

  await $.turn.complete(longTurn)

  expect(runs[0]?.argv[0]).toBe('powershell')
  expect(runs[0]?.argv.at(-1)).toContain('ToastNotificationManager')
  // A registered AppUserModelID: an arbitrary one makes Windows drop the toast silently.
  expect(runs[0]?.argv.at(-1)).toContain("CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe')")
  expect(runs[0]?.env?.CLAUDE_NOTIFY_TITLE).toBe('Claude Code · shop')
  expect(runs[0]?.env?.CLAUDE_NOTIFY_BODY).toContain('Finished in 1m 35s')
})

test('notifies when Claude needs you, with no length threshold', async ($, on) => {
  const runs = host(on, 'linux')

  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
  await $.classic.Notification({ message: 'Signed in', notification_type: 'auth_success' })

  expect(runs).toHaveLength(1)
  expect(runs[0]?.argv.at(-1)).toBe('Claude needs your permission to use Bash')
})

test('attention notifications can be switched off', { options: { attention: false, minSeconds: 30 } }, async ($, on) => {
  const runs = host(on, 'linux')

  await $.classic.Notification({ message: 'Claude is waiting for your input', notification_type: 'idle_prompt' })

  expect(runs).toHaveLength(0)
})

test('fails silently when the notifier program is missing', async ($, on) => {
  const missing = host(on, 'linux', { isNotifierBroken: true })
  await expect($.turn.complete(longTurn)).resolves.toEqual({ text: '' })
  expect(missing).toHaveLength(1)
})

test('does nothing on an unknown platform', async ($, on) => {
  const runs = host(on, 'plan9')

  await expect($.turn.complete(longTurn)).resolves.toEqual({ text: '' })
  expect(runs).toHaveLength(0)
})

test('minSeconds sets the threshold', { options: { minSeconds: 5, attention: true } }, async ($, on) => {
  const runs = host(on, 'linux')

  await $.turn.complete({ ...longTurn, durationMs: 6_000 })

  expect(runs).toHaveLength(1)
})
