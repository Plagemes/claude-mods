import type { Register } from 'claude-code'

const FANFARE = { asset: 'assets/celebrate.wav' } as const

/** A runner as the command a shell segment runs, after env assignments and launchers (`npx`, `python -m`, `poetry run`, ...). */
const TEST_RUNNER = new RegExp(
  String.raw`^\s*(?:\w+=\S*\s+|(?:sudo|time|env|nice|command|npx|pnpx|bunx|yarn|pnpm|bun)\s+|timeout\s+\S+\s+|(?:python3?|py)\s+-m\s+|(?:poetry|uv|pipenv|pdm|hatch|rye)\s+run\s+|(?:bundle|pnpm|yarn|npm)\s+exec\s+(?:--\s+)?)*?` +
    String.raw`(?:[\w.~-]*\/)*` +
    String.raw`(jest|vitest|pytest|mocha|rspec|phpunit|tox|ctest|go test|cargo (?:test|nextest)|deno test|bun test|dotnet test|mvn test|gradle test|(?:npm|yarn|pnpm)(?: run)? test)(?![\w./])`,
)
const SEGMENTS = /&&|\|\||[;|&\n(){}]/
// A runner that printed failures but still exited 0 (e.g. `npm test | tail`).
const FAILURE_REPORT = /\b[1-9]\d* (?:failed|failing|failures?)\b|^FAIL\b|\bFAILED\b/m

/** The runner a command runs ("npm run test" and "npm test" are the same one); `cat jest.config.js` or `grep -r pytest` runs none. */
const runnerOf = (command: string): string | undefined => {
  for (const segment of command.split(SEGMENTS)) {
    const runner = TEST_RUNNER.exec(segment)?.[1]
    if (runner !== undefined) return runner.replace(' run ', ' ')
  }
  return undefined
}

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
      // Not awaited (the call resolves when the clip ends), and started outside this dispatch so it is not cut off with it.
      if (isSoundOn) $.clock.after(0, () => void $.audio.play(FANFARE).catch(() => undefined))
    }
    return ran
  })
}
