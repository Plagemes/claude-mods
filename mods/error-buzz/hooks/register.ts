import type { Register } from 'claude-code'

const BUZZ_SOUND = { asset: 'assets/buzz.wav' } as const
const DEFAULT_COOLDOWN_SECONDS = 10

/** A runner as the command a shell segment runs, after env assignments and launchers (`npx`, `python -m`, `poetry run`, ...). */
const TEST_RUNNER = new RegExp(
  String.raw`^\s*(?:\w+=\S*\s+|(?:sudo|time|env|nice|command|npx|pnpx|bunx|yarn|pnpm|bun)\s+|timeout\s+\S+\s+|(?:python3?|py)\s+-m\s+|(?:poetry|uv|pipenv|pdm|hatch|rye)\s+run\s+|(?:bundle|pnpm|yarn|npm)\s+exec\s+(?:--\s+)?)*?` +
    String.raw`(?:[\w.~-]*\/)*` +
    String.raw`(?:jest|vitest|pytest|py\.test|mocha|rspec|phpunit|tox|ctest|go test|cargo (?:test|nextest)|deno test|bun test|dotnet test|mvn test|gradle test|(?:npm|yarn|pnpm)(?: run)? test)(?![\w./])`,
)
const SEGMENTS = /&&|\|\||[;|&\n(){}]/
// A runner that printed failures but still exited 0 (e.g. `npm test || true`).
const FAILURE_REPORT = /\b[1-9]\d* (?:failed|failing|failures?)\b|^FAIL\b|\bFAILED\b/m

/** Whether the command runs tests (`npm test`, `cd web && npx vitest run`), not merely names a runner (`cat jest.config.js`, `npm i -D vitest`). */
const isTestCommand = (command: string): boolean => command.split(SEGMENTS).some(segment => TEST_RUNNER.test(segment))

export const register: Register = (on, options) => {
  const cooldownMs = (typeof options.cooldownSeconds === 'number' ? options.cooldownSeconds : DEFAULT_COOLDOWN_SECONDS) * 1000
  const isTestsOnly = options.onlyTests === true
  let lastBuzzAt = Number.NEGATIVE_INFINITY

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran

    const isTestRun = isTestCommand(e.command)
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
