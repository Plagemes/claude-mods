import type { On } from 'claude-code'
import { test, expect } from 'claude-code/testing'

import { fakeHub } from './hub'

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
    // The shared shell reader: substitutions, eval, su -c, heredocs fed to a shell, a shell inside a container.
    'echo "$(git push -f origin main)"',
    "eval 'git push --force origin main'",
    "su -c 'git push -f origin main' deploy",
    'bash <<EOF\ngit push -f origin main\nEOF',
    'docker exec ci sh -c "git push -f origin main"',
  ]
  for (const command of blocked) {
    const result = await $.tool.call({ tool: 'Bash', command })
    expect(`${command} => ${result.deny ?? 'ALLOWED'}`).toContain('force-push-guard')
  }
  expect(ran).toHaveLength(0)
})

test('a quoted force flag is rewritten in place, and a nested one is checked but left as is', async ($, on) => {
  const ran = engine(on, 'feature/x')
  await $.tool.call({ tool: 'Bash', command: `git push "--force" origin feature/x` })
  await $.tool.call({ tool: 'Bash', command: `bash -c "git push -f origin feature/x"` })
  await $.tool.call({ tool: 'Bash', command: "cat <<'EOF' > notes.md\ngit push -f origin main\nEOF" })
  expect(ran).toEqual(['git push --force-with-lease origin feature/x', 'bash -c "git push -f origin feature/x"', "cat <<'EOF' > notes.md\ngit push -f origin main\nEOF"])
})

test('with mods-hub: a deny is published as risk.blocked, a push that went through as git.push, the rewrite note as a notification', async ($, on) => {
  const ran = engine(on, 'feature/x')
  const hub = fakeHub(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve() // the hello waits for session.start to return (afterStart)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['risk.blocked', 'git.push'], consumes: [] }])

  expect((await $.tool.call({ tool: 'Bash', command: 'git push -f origin main' })).deny).toContain('"main"')
  await $.tool.call({ tool: 'Bash', command: 'git push -f' })
  await $.tool.call({ tool: 'Bash', command: 'git push upstream release-2' })
  expect(ran).toEqual(['git push --force-with-lease', 'git push upstream release-2'])
  expect(hub.published).toEqual([
    {
      topic: 'risk.blocked',
      data: {
        guard: 'force-push-guard',
        tool: 'Bash',
        reason: expect.stringMatching(/^protected-branch: force-pushing to "main" is blocked/),
        severity: 'high',
        command: 'git push -f origin main',
      },
    },
    { topic: 'git.push', data: { remote: 'origin', branch: 'feature/x', isForce: true }, scope: 'global' },
    { topic: 'git.push', data: { remote: 'upstream', branch: 'release-2', isForce: false }, scope: 'global' },
  ])
  expect(hub.notified).toEqual([{ level: 'info', title: 'Rewrote --force to --force-with-lease', topic: 'risk.blocked' }])
})

test('without mods-hub: no git.push lookups, and the rewrite note is a toast', async ($, on) => {
  const toasts: string[] = []
  const calls: string[][] = []
  on('tool.call', () => ({ result: 'ran' }))
  on('process.run', (_$, e) => {
    calls.push([...e.argv])
    return { value: { exitCode: 0, stdout: 'feature/x\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.tool.call({ tool: 'Bash', command: 'git push origin feature/x' })
  await $.tool.call({ tool: 'Bash', command: 'git push -f origin feature/x' })
  expect(calls).toEqual([])
  expect(toasts).toEqual(['Rewrote --force to --force-with-lease'])
})
