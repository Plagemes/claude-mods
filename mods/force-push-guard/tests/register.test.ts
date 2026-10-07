import type { On } from 'claude-code'
import { test, expect } from 'claude-code/testing'

/** Stands in for the engine: records the commands the Bash tool would run and answers git. */
function engine(on: On, branch: string | undefined = undefined) {
  const ran: string[] = []
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash') ran.push(e.command)
    return { result: 'ran' }
  })
  on('process.run', () => ({
    value: { exitCode: branch === undefined ? 1 : 0, stdout: `${branch ?? ''}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('ui.toast', () => ({ value: undefined }))
  return ran
}

test('denies a force push to a protected branch, in every spelling', async ($, on) => {
  engine(on)
  const blocked = [
    'git push --force origin main',
    'git push -f origin master',
    'git push origin +main',
    'git push --force-with-lease origin main',
    'git push origin HEAD:release/1.4 -f',
    'git push origin feature:develop --force',
    'git -C app push -fu origin main',
    'git add . && git commit -m x && git push -f origin main',
  ]
  for (const command of blocked) {
    const result = await $.tool.call({ tool: 'Bash', command })
    expect(`${command} => ${result.deny ?? 'ALLOWED'}`).toContain('force-push-guard')
  }
})

test('resolves the current branch when the push names none', async ($, on) => {
  const ran = engine(on, 'main')
  expect((await $.tool.call({ tool: 'Bash', command: 'git push -f' })).deny).toContain('"main"')
  expect((await $.tool.call({ tool: 'Bash', command: 'git push --force origin HEAD' })).deny).toContain('"main"')
  expect(ran).toHaveLength(0)
})

test('denies when the target branch cannot be determined', async ($, on) => {
  engine(on, undefined)
  const result = await $.tool.call({ tool: 'Bash', command: 'git push --force' })
  expect(result.deny).toContain('cannot tell which branch')
})

test('denies --force with --all or --mirror', async ($, on) => {
  engine(on)
  expect((await $.tool.call({ tool: 'Bash', command: 'git push --force --all origin' })).deny).toContain('every branch')
  expect((await $.tool.call({ tool: 'Bash', command: 'git push -f --mirror backup' })).deny).toContain('every branch')
})

test('rewrites --force to --force-with-lease on other branches', async ($, on) => {
  const ran = engine(on, 'feature/x')
  await $.tool.call({ tool: 'Bash', command: 'git push --force origin feature/x' })
  await $.tool.call({ tool: 'Bash', command: 'git push -f' })
  await $.tool.call({ tool: 'Bash', command: 'git push -fu origin feat/y' })
  await $.tool.call({ tool: 'Bash', command: 'git push origin +feat/z:feat/z' })
  await $.tool.call({ tool: 'Bash', command: 'npm test && git push -f origin fix/a && echo done' })
  expect(ran).toEqual([
    'git push --force-with-lease origin feature/x',
    'git push --force-with-lease',
    'git push -u --force-with-lease origin feat/y',
    'git push origin --force-with-lease feat/z:feat/z',
    'npm test && git push --force-with-lease origin fix/a && echo done',
  ])
})

test('leaves normal pushes, lease pushes on feature branches and other commands alone', async ($, on) => {
  const ran = engine(on, 'feature/x')
  const untouched = [
    'git push origin main',
    'git push -u origin feature/x',
    'git push --force-with-lease origin feature/x',
    'git push origin --delete old-branch',
    'git log --oneline -f',
    'echo "git push -f origin main"',
    'ls',
  ]
  for (const command of untouched) {
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toBeUndefined()
  }
  expect(ran).toEqual(untouched)
})

test('protectedBranches is configurable', { options: { protectedBranches: 'prod,hotfix/*' } }, async ($, on) => {
  const ran = engine(on)
  expect((await $.tool.call({ tool: 'Bash', command: 'git push -f origin hotfix/9' })).deny).toContain('"hotfix/9"')
  await $.tool.call({ tool: 'Bash', command: 'git push -f origin main' })
  expect(ran).toEqual(['git push --force-with-lease origin main'])
})

test('sees pushes behind bash -c and line continuations', async ($, on) => {
  const ran = engine(on, 'main')
  const blocked = [
    'bash -c "git push -f origin main"',
    "sh -lc 'cd app && git push --force origin master'",
    'git push --force \\\n  origin',
  ]
  for (const command of blocked) {
    const result = await $.tool.call({ tool: 'Bash', command })
    expect(`${command} => ${result.deny ?? 'ALLOWED'}`).toContain('force-push-guard')
  }
  expect(ran).toHaveLength(0)
})
