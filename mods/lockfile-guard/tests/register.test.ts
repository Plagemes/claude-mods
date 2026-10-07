import { test, expect } from 'claude-code/testing'

import { fakeHub } from './hub'

test('denies Edit and Write on lockfiles and names the command that regenerates them', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  const cases: Array<[string, string]> = [
    ['/repo/package-lock.json', 'npm install'],
    ['/repo/web/pnpm-lock.yaml', 'pnpm install'],
    ['/repo/yarn.lock', 'yarn install'],
    ['/repo/bun.lockb', 'bun install'],
    ['/repo/Cargo.lock', 'cargo update'],
    ['/repo/poetry.lock', 'poetry lock'],
    ['/repo/uv.lock', 'uv lock'],
    ['/repo/Gemfile.lock', 'bundle install'],
    ['/repo/composer.lock', 'composer update'],
    ['/repo/go.sum', 'go mod tidy'],
  ]
  for (const [file_path, command] of cases) {
    const edit = await $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' })
    expect(edit.deny).toContain(command)
    const write = await $.tool.call({ tool: 'Write', file_path, content: '{}' })
    expect(write.deny).toContain('lockfile-guard')
  }
})

test('also guards MultiEdit, in builds that have it', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  // This build has no MultiEdit tool, so its input is not in the types.
  const multiEdit = { tool: 'MultiEdit', file_path: '/repo/package-lock.json', edits: [] } as never
  const result = await $.tool.call(multiEdit)
  expect(result.deny).toContain('npm install')
})

test('lets manifests and look-alike names through', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  for (const file_path of ['/repo/package.json', '/repo/Cargo.toml', '/repo/docs/yarn.lock.md', '/repo/my-go.sum.txt', '/repo/lock.ts']) {
    const result = await $.tool.call({ tool: 'Write', file_path, content: 'x' })
    expect(result.deny).toBeUndefined()
    expect(result.result).toBe('ok')
  }
})

test('denies hand edits of a lockfile from Bash: redirections, tee and in-place sed, also behind bash -c', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  for (const command of [
    'echo "{}" > package-lock.json',
    'cat extra >> web/yarn.lock',
    'jq . pnpm-lock.yaml | tee pnpm-lock.yaml',
    "sed -i 's/1.0.0/1.0.1/' Cargo.lock",
    "perl -pi -e 's/a/b/' go.sum",
    'bash -c "echo x > poetry.lock"',
  ]) {
    expect((await $.tool.call({ tool: 'Bash', command })).deny, command).toContain('lockfile-guard: ')
  }
})

test('lets package managers, reads, copies and removals of lockfiles through', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  for (const command of [
    'npm install',
    'cat package-lock.json | jq .version',
    'git diff yarn.lock > lock.diff',
    'rm -f package-lock.json && npm install',
    'cp backup/yarn.lock yarn.lock',
    "sed -n '1,20p' Cargo.lock",
    'echo "do not edit yarn.lock" > NOTES.md',
  ]) {
    const result = await $.tool.call({ tool: 'Bash', command })
    expect(result.deny, command).toBeUndefined()
  }
})

test('with mods-hub: each deny is published as risk.blocked', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  const hub = fakeHub(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['risk.blocked'], consumes: [] }])
  await $.tool.call({ tool: 'Write', file_path: '/repo/yarn.lock', content: '{}' })
  await $.tool.call({ tool: 'Bash', command: 'echo x > uv.lock' })
  expect(hub.published.map(event => event.data)).toEqual([
    { guard: 'lockfile-guard', tool: 'Write', reason: 'hand-edited-lockfile: yarn.lock is generated', severity: 'low', path: '/repo/yarn.lock' },
    { guard: 'lockfile-guard', tool: 'Bash', reason: 'hand-edited-lockfile: uv.lock is generated', severity: 'low', command: 'echo x > uv.lock' },
  ])
})
