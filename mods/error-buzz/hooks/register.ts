import type { Register } from 'claude-code'

const BUZZ_SOUND = { asset: 'assets/buzz.wav' } as const
const DEFAULT_COOLDOWN_SECONDS = 10

const TEST_RUNNER =
  /\b(jest|vitest|pytest|mocha|rspec|phpunit|tox|ctest|go test|cargo (?:test|nextest)|deno test|bun test|dotnet test|mvn test|gradle test|(?:npm|yarn|pnpm)(?: run)? test)\b/
// A runner that printed failures but still exited 0 (e.g. `npm test || true`).
const FAILURE_REPORT = /\b[1-9]\d* (?:failed|failing|failures?)\b|^FAIL\b|\bFAILED\b/m

export const register: Register = (on, options) => {
  const cooldownMs = (typeof options.cooldownSeconds === 'number' ? options.cooldownSeconds : DEFAULT_COOLDOWN_SECONDS) * 1000
  const isTestsOnly = options.onlyTests === true
  let lastBuzzAt = Number.NEGATIVE_INFINITY

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran

    const isTestRun = TEST_RUNNER.test(e.command)
    const hasFailed = ran.isError === true || (isTestRun && FAILURE_REPORT.test(ran.text ?? ''))
    if (!hasFailed || (isTestsOnly && !isTestRun)) return ran

    const now = await $.clock.now()
    if (now - lastBuzzAt >= cooldownMs) {
      lastBuzzAt = now
      // Not awaited: the call resolves when the clip ends, and the tool result must not wait for it.
      $.audio.play(BUZZ_SOUND).catch(() => undefined)
    }
    return ran
  })
}
