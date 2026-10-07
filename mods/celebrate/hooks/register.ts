import type { Register } from 'claude-code'

const FANFARE = { asset: 'assets/celebrate.wav' } as const

const TEST_RUNNER =
  /\b(jest|vitest|pytest|mocha|rspec|phpunit|tox|ctest|go test|cargo (?:test|nextest)|deno test|bun test|dotnet test|mvn test|gradle test|(?:npm|yarn|pnpm)(?: run)? test)\b/
// A runner that printed failures but still exited 0 (e.g. `npm test | tail`).
const FAILURE_REPORT = /\b[1-9]\d* (?:failed|failing|failures?)\b|^FAIL\b|\bFAILED\b/m

// "npm run test" and "npm test" are the same runner.
const runnerOf = (command: string): string | undefined =>
  TEST_RUNNER.exec(command)?.[1]?.replace(' run ', ' ')

export const register: Register = (on, options) => {
  const isSoundOn = options.sound !== false
  // Which runners went red and have not been green since.
  const failing = new Set<string>()

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const runner = runnerOf(e.command)
    if (runner === undefined || ran.deny !== undefined) return ran

    const hasFailed = ran.isError === true || FAILURE_REPORT.test(ran.text ?? '')
    if (hasFailed) {
      failing.add(runner)
    } else if (failing.delete(runner)) {
      $.ui.toast(`🎉 All green: ${runner} passes again`)
      // Not awaited: the call resolves when the clip ends, and the tool result must not wait for it.
      if (isSoundOn) $.audio.play(FANFARE).catch(() => undefined)
    }
    return ran
  })
}
