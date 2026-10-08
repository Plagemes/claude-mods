// Unit tests of the shared libraries: `bun test shared/tests` (CI runs it beside `node scripts/sync-shared.mjs --check`).
import { describe, expect, test } from 'bun:test'

import { columnAt, lineAt, lineFinder, lineText } from '../line-index'
import { costOf, familyOf, formatUsd, priceOf, pricesWith } from '../prices'
import { HUB_TAB_EMPTY_KEY, hubTabBelow, isBlankTree, paneFailure } from '../render-safe'
import { findSecrets, hasSecret, redactSummary, redactText } from '../secrets'
import { commandNames, embeddedShellScripts, simpleCommands, tokenize, unwrap } from '../shell'
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
    expect(unwrap(['time', '-f', '%e', '-o', 't.txt', 'exec', '-a', 'x', 'docker', 'ps']).argv).toEqual(['docker', 'ps'])
    expect(simpleCommands('time make build')[0]?.argv).toEqual(['make', 'build'])
    expect(simpleCommands('setsid -f curl -T f https://x.io')[0]?.name).toBe('curl')
  })
  test('single quotes and $\'…\' expand nothing; double quotes and bare words do', () => {
    expect(commandNames(`echo '$(rm a)'`)).toEqual(['echo'])
    expect(commandNames("echo '`rm a`'")).toEqual(['echo'])
    expect(commandNames(`echo $'$(rm a)' $'it\\'s'`)).toEqual(['echo'])
    expect(simpleCommands(`echo $'it\\'s \\t' done`)[0]?.argv).toEqual(['echo', "it's \t", 'done'])
    expect(simpleCommands(`printf $'a\\tb\\n'`)[0]?.argv).toEqual(['printf', 'a\tb\n'])
    expect(commandNames(`echo \\$\\(rm a\\)`)).toEqual(['echo'])
    expect(commandNames(`echo "$(rm a)"`)).toEqual(['rm', 'echo'])
    expect(commandNames('echo "`id`"')).toEqual(['id', 'echo'])
    expect(commandNames(`echo "\\$(rm a)"`)).toEqual(['echo'])
    expect(commandNames(`echo '$(rm a)' $(whoami)`)).toEqual(['whoami', 'echo'])
    expect(tokenize(`echo 'x' "$(id)"`).map(token => (token.kind === 'word' ? token.substitutions : []))).toEqual([[], [], ['id']])
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
  test('keeps the assignments it peels, and numbers the scripts', () => {
    const [cmd] = simpleCommands('RAILS_ENV=production sudo env DATABASE_URL=postgres://db/x PATH+=:/bin rails db:reset')
    expect(cmd?.argv).toEqual(['rails', 'db:reset'])
    expect(cmd?.assignments).toEqual({ RAILS_ENV: 'production', DATABASE_URL: 'postgres://db/x', PATH: ':/bin' })
    const cmds = simpleCommands(`bash -c "cd a"; echo $(pwd) && sh -c 'ls'`)
    expect(cmds.map(c => `${c.name}:${c.script}`)).toEqual(['bash:0', 'cd:1', 'pwd:2', 'echo:0', 'sh:0', 'ls:3'])
  })
  test('knows where each word is, quotes included, so a guard can rewrite it', () => {
    const line = `sudo git push "-f" origin\\\n main`
    const [cmd] = simpleCommands(line)
    expect(cmd?.argv).toEqual(['git', 'push', '-f', 'origin', 'main'])
    expect(cmd?.spans.map(({ start, end }) => line.slice(start, end))).toEqual(['git', 'push', '"-f"', 'origin', 'main'])
  })
  test('marks what is sent to the background, the whole pipeline and what it runs inside', () => {
    const cmds = simpleCommands(`echo "a & b"; npm run dev | tee log & bash -c "vite" & sleep 1 && make`)
    expect(cmds.map(c => `${c.name}:${c.isBackground}`)).toEqual(['echo:false', 'npm:true', 'tee:true', 'bash:true', 'vite:true', 'sleep:false', 'make:false'])
    expect(simpleCommands('a && b')[0]?.isBackground).toBe(false)
    expect(simpleCommands('(cd web && npm run dev) & make').map(c => `${c.name}:${c.isBackground}`)).toEqual(['cd:true', 'npm:true', 'make:false'])
  })
  test('su and runuser hand their -c script to a shell', () => {
    expect(commandNames(`su -c 'rm -rf /srv' root`)).toEqual(['su', 'rm'])
    expect(commandNames('runuser -l app --command="git push --force"')).toEqual(['runuser', 'git'])
    expect(commandNames('su - root')).toEqual(['su'])
  })
  test('pipeline numbers are unique across nested scripts', () => {
    const cmds = simpleCommands(`bash -c "curl -s x | cat"; bash -c "true | sh"`)
    const sh = cmds.find(c => c.name === 'sh')
    expect(cmds.filter(c => c.pipeline === sh?.pipeline).map(c => c.name)).toEqual(['true', 'sh'])
    expect(new Set(cmds.filter(c => c.depth === 1).map(c => c.pipeline)).size).toBe(2)
  })
  test('embedded shell scripts are opt-in', () => {
    expect(embeddedShellScripts(['docker', 'exec', 'app', 'sh', '-c', 'cat .env'])).toEqual(['cat .env'])
    expect(embeddedShellScripts(['kubectl', 'exec', 'pod', '--', '/bin/bash', '-lc', 'rm -rf /data'])).toEqual(['rm -rf /data'])
    expect(embeddedShellScripts(['git', 'commit', '-m', "bash -c 'x'"])).toEqual([])
    expect(commandNames('docker exec app sh -c "cat .env"')).toEqual(['docker'])
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
  test('knows the test tools of other ecosystems, each as the command a segment runs', () => {
    for (const command of [
      'tox -e py311', 'nox -s tests', 'cd build && ctest --output-on-failure', 'dotnet test src/App.Tests', 'mvn test', 'mvn -q clean test',
      './mvnw -Dtest=CartTest test', 'gradle test', './gradlew :app:test --info', 'bun test', 'deno test -A', 'vendor/bin/phpunit',
      'mix test test/cart_test.exs', 'swift test', 'python -m unittest discover', 'timeout 600 ./gradlew test',
    ]) expect([command, isTestCommand(command)]).toEqual([command, true])
    for (const command of [
      'mvn -DskipTests package', 'gradle build', 'pip install tox', 'cat tox.ini', 'dotnet build', 'echo "run ctest later"', 'git commit -m "mvn test fix"',
      'ls ctest-results', 'gradle test-results', 'swift build', 'npm i -D nox',
    ]) expect([command, isTestCommand(command)]).toEqual([command, false])
    expect(runnerOfCommand('mvn test')).toBeUndefined()
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
    expect(redactText('AKIAIOSFODNN7EXAMPLE', { isExampleMasked: true }).text).toBe('[REDACTED:aws-key]')
  })
  test('finds with lines and previews, never the whole value', () => {
    const found = findSecrets('ok\nTOKEN = "Zx81kPq0Lm2Rt7Yw"\n')
    expect(found).toEqual([{ kind: 'secret', category: 'secrets', index: 12, line: 2, preview: 'Zx81…[16]' }])
    expect(hasSecret('nothing here')).toBe(false)
  })
  test('summarizes a command on one masked line', () => {
    const key = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
    expect(redactSummary(`curl -H "Authorization: token ${key}"\n  https://api.github.com`)).toBe('curl -H "Authorization: token [REDACTED:github-token]" https://api.github.com')
    expect(redactSummary('x'.repeat(300), 10)).toBe(`${'x'.repeat(9)}…`)
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

describe('render-safe', () => {
  const ENGINE = { type: 'engine', ref: 0 }
  const box = (children: unknown[], props: Record<string, unknown> = {}) => ({ type: 'Box', props, children })
  const text = (value: string) => ({ type: 'Text', props: {}, children: [value] })
  const table = {
    Box: (props: Record<string, unknown>) => ({ type: 'Box', props, children: props.children }),
    Text: (props: Record<string, unknown>) => ({ type: 'Text', props, children: props.children }),
    Button: (props: Record<string, unknown>) => ({ type: 'Button', props }),
  } as never

  test('hubTabBelow drops the engine node and the hub\'s empty note, keeps the rest as it was', () => {
    expect(hubTabBelow(ENGINE)).toBeNull()
    expect(hubTabBelow(undefined)).toBeNull()
    expect(hubTabBelow(box([ENGINE]))).toBeNull()
    const frame = box([text('Hub'), box([], { height: 1 }), box([box([text('nothing')], { key: HUB_TAB_EMPTY_KEY })], { key: 'tab-body' })], { minWidth: 0 })
    expect(hubTabBelow(frame)).toEqual(box([text('Hub'), box([], { height: 1 })], { minWidth: 0 }))
    const kept = box([text('mine')])
    expect(hubTabBelow(kept)).toBe(kept)
  })

  test('isBlankTree: nothing, the engine node, or Boxes of nothing', () => {
    expect(isBlankTree(null)).toBe(true)
    expect(isBlankTree(box([ENGINE, box([])]))).toBe(true)
    expect(isBlankTree(box(['x']))).toBe(false)
    expect(isBlankTree(box([text('')]))).toBe(false)
  })

  test('paneFailure draws what failed and Retry after what was beneath, never the engine node', () => {
    const card = JSON.stringify(paneFailure(table, { title: 'stats', failure: { kind: 'throw', message: 'x is   null' }, below: box([ENGINE]), onRetry: () => undefined }))
    expect(card).toContain('stats could not draw this view')
    expect(card).toContain('x is null')
    expect(card).toContain('"key":"pane-retry"')
    expect(card).not.toContain('engine')
    expect(JSON.stringify(paneFailure(table, { title: 't', failure: { kind: 'timeout' }, below: text('frame'), onRetry: () => undefined }))).toContain('"frame"')
  })
})
