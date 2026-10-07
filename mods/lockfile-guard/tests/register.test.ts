import { test, expect } from 'claude-code/testing'

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
