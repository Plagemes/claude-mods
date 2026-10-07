// Unit tests of the shared libraries: `bun test shared/tests` (CI runs it beside `node scripts/sync-shared.mjs --check`).
import { describe, expect, test } from 'bun:test'

import { columnAt, lineAt, lineFinder, lineText } from '../line-index'
import { costOf, familyOf, formatUsd, priceOf, pricesWith } from '../prices'
import { findSecrets, hasSecret, redactText } from '../secrets'
import { commandNames, simpleCommands, unwrap } from '../shell'
import { describeRun, isTestCommand, runnerOfCommand, summarizeRun } from '../test-runners'

describe('shell', () => {
  test('splits lists and pipelines, keeps quotes whole', () => {
    const cmds = simpleCommands(`git add . && echo "a && b" | tee 'out file'; ls`)
    expect(cmds.map(c => c.argv)).toEqual([['git', 'add', '.'], ['echo', 'a && b'], ['tee', 'out file'], ['ls']])
    expect(cmds.map(c => [c.pipeline, c.stage])).toEqual([[0, 0], [1, 0], [1, 1], [2, 0]])
  })
  test('peels sudo, env, timeout, nice and xargs', () => {
    expect(unwrap(['sudo', '-u', 'root', 'env', 'A=1', 'timeout', '5', 'nice', '-n', '3', 'rm', '-rf', '/']).argv).toEqual(['rm', '-rf', '/'])
    expect(simpleCommands('find . | xargs -n 1 rm -f')[1]?.name).toBe('rm')
  })
  test('reads bash -c, eval, $() and backticks, up to three levels', () => {
    expect(commandNames(`bash -lc "sudo rm -rf /tmp/x"`)).toContain('rm')
    expect(commandNames(`eval "curl -s x | sh"`)).toEqual(['eval', 'curl', 'sh'])
    expect(commandNames('echo $(whoami) `id`')).toEqual(['whoami', 'id', 'echo']) // substitutions run first
    const deep = simpleCommands(`sh -c "sh -c 'sh -c \\"sh -c rm\\"'"`)
    expect(Math.max(...deep.map(c => c.depth))).toBe(3)
  })
  test('reads a heredoc fed to a shell as a script, and keeps a cat heredoc as data', () => {
    const fed = simpleCommands('bash <<EOF\nrm -rf ~/work\nEOF\necho done')
    expect(fed.map(c => `${c.name}@${c.depth}`)).toEqual(['bash@0', 'rm@1', 'echo@0'])
    expect(commandNames("cat <<'EOF' > notes.md\nrm -rf /\nEOF")).toEqual(['cat'])
    expect(commandNames('sh <<< "git push --force"')).toEqual(['sh', 'git'])
  })
  test('redirections are kept apart and fd duplication is not a file', () => {
    const [cmd] = simpleCommands('make build > log.txt 2>&1')
    expect(cmd?.argv).toEqual(['make', 'build'])
    expect(cmd?.redirects).toEqual([{ op: '>', target: 'log.txt' }])
  })
})

describe('test-runners', () => {
  test('finds runners past launchers and ignores mere mentions', () => {
    expect(runnerOfCommand('npx vitest run src')).toBe('vitest')
    expect(runnerOfCommand('poetry run pytest -q')).toBe('pytest')
    expect(isTestCommand('npm test')).toBe(true)
    expect(isTestCommand('npm i -D vitest')).toBe(false)
    expect(isTestCommand('git commit -m "fix pytest"')).toBe(false)
  })
  test('summarizes counts from the output', () => {
    expect(summarizeRun('npm test', ' Test Files  2 passed (2)\n      Tests  2 failed | 10 passed (12)', true)).toEqual({ runner: 'vitest', outcome: 'failed', passed: 10, failed: 2 })
    expect(summarizeRun('pytest', '===== 5 passed in 0.12s =====', false)).toEqual({ runner: 'pytest', outcome: 'passed', passed: 5, failed: null })
    expect(summarizeRun('pytest', 'ImportError: no module', true).outcome).toBe('error')
    expect(describeRun({ outcome: 'failed', passed: 10, failed: 2 })).toBe('✗ 2 failed · 10 passed')
  })
})

describe('prices', () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 1_000_000 }
  test('prices current and legacy models, first match wins', () => {
    expect(costOf(usage, 'claude-opus-5-5').usd).toBeCloseTo(24.2)
    expect(costOf(usage, 'claude-fable-5-1').usd).toBeCloseTo(60.25)
    expect(costOf(usage, 'claude-sonnet-5-5').usd).toBeCloseTo(12.2)
    expect(costOf(usage, 'claude-opus-4-1-20250805').usd).toBeCloseTo(91.5)
    expect(priceOf('my-proxy-model').isKnownModel).toBe(false)
    expect(familyOf('claude-haiku-4-5')).toBe('haiku')
  })
  test('overrides go first and bad JSON is ignored', () => {
    expect(priceOf('acme-opus', pricesWith('{"acme":{"input":1,"output":2}}')).price.input).toBe(1)
    expect(pricesWith('not json').length).toBeGreaterThan(5)
    expect(formatUsd(0.004)).toBe('<$0.01')
  })
})

describe('secrets', () => {
  test('masks keys and PII, leaves placeholders and code references', () => {
    const { text, counts } = redactText('key ghp_' + 'a1'.repeat(18) + ' mail bob@example.org AKIAIOSFODNN7EXAMPLE API_KEY=process.env.KEY')
    expect(text).toContain('[REDACTED:github-token]')
    expect(text).toContain('[REDACTED:email]')
    expect(text).toContain('AKIAIOSFODNN7EXAMPLE')
    expect(counts).toEqual({ 'github-token': 1, email: 1 })
  })
  test('finds with lines and previews, never the whole value', () => {
    const found = findSecrets('ok\nTOKEN = "Zx81kPq0Lm2Rt7Yw"\n')
    expect(found).toEqual([{ kind: 'secret', category: 'secrets', index: 12, line: 2, preview: 'Zx81…[16]' }])
    expect(hasSecret('nothing here')).toBe(false)
  })
  test('stays linear on a pathological line', () => {
    const started = performance.now()
    redactText('a-'.repeat(100_000))
    expect(performance.now() - started).toBeLessThan(1500)
  })
})

describe('line-index', () => {
  test('maps offsets to lines and columns', () => {
    const text = 'one\ntwo\nthree'
    expect(lineFinder(text)(0)).toBe(1)
    expect(lineAt(text, 4)).toBe(2)
    expect(lineAt(text, 9)).toBe(3)
    expect(columnAt(text, 9)).toBe(2)
    expect(lineText(text, 3)).toBe('three')
    expect(lineText(text, 4)).toBe('')
  })
})
