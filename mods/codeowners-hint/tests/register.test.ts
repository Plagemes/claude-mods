import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const CODEOWNERS = [
  '# Owners of the shop',
  '* @org/everyone',
  '*.ts @org/frontend #inline comment',
  '/api/ @org/backend @alice',
  '/api/legacy/',
  'docs/*  docs@example.com',
  '**/logs @org/ops',
  '/build/ @org/release',
  '/apps/** @org/apps',
  '',
].join('\n')

type Disk = Record<string, { text: string; mtimeMs: number }>

// Stands for the engine: a file system holding CODEOWNERS files, the repository root, the status line.
const engine = (on: On, disk: Disk, root = '/repo') => {
  const state = {
    disk,
    directories: ['/repo/api', '/repo/docs'],
    isReadable: true,
    statuses: [] as (string | undefined)[],
    reached: [] as string[],
    commands: [] as string[],
  }
  on('session.repo', () => ({ value: { root, remote: null, internal: false, name: null } }))
  on('session.root', () => ({ value: root }))
  on('session.cwd', () => ({ value: root }))
  on('session.start', () => ({ cwd: root }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('fs.exists', (_$, e) => ({ value: e.path in state.disk }))
  on('fs.stat', (_$, e) => {
    const file = state.disk[e.path]
    if (file !== undefined) return { value: { kind: 'file' as const, size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } }
    return state.directories.includes(e.path) ? { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } } : { deny: 'ENOENT' }
  })
  on('fs.read', (_$, e) => (state.isReadable ? { value: state.disk[e.path]?.text ?? '' } : { deny: 'EIO' }))
  on('ui.status', (_$, e) => {
    state.statuses.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_$, e) => {
    state.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('tool.call', (_$, e) => {
    state.reached.push(e.tool)
    return { result: 'ok', text: 'ok' }
  })
  return state
}

const owners = async ($: Engine, args: string) => {
  const { text } = await $.command.run({ command: 'owners', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  return text ?? ''
}

const GITHUB = { '/repo/.github/CODEOWNERS': { text: CODEOWNERS, mtimeMs: 1 } }

test('shows the owners of a file Claude edits, last matching rule winning', async ($, on) => {
  const state = engine(on, GITHUB)

  await $.tool.call({ tool: 'Edit', file_path: '/repo/api/users.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/web/Button.ts', content: 'x' })

  expect(state.statuses).toEqual(['owners: @org/backend @alice (users.ts)', 'owners: @org/frontend (Button.ts)'])
  expect(state.reached).toEqual(['Edit', 'Write'])
})

test('a rule without owners clears the line, and so does a file outside the repository', async ($, on) => {
  const state = engine(on, GITHUB)

  await $.tool.call({ tool: 'Edit', file_path: '/repo/api/legacy/old.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: '/elsewhere/x.ts', old_string: 'a', new_string: 'b' })

  expect(state.statuses).toEqual([undefined, undefined])
})

test('/owners explains the match with the rule and its line', async ($, on) => {
  engine(on, GITHUB)

  expect(await owners($, 'api/users.ts')).toBe('📋 api/users.ts is owned by @org/backend @alice\nrule: /api/ (.github/CODEOWNERS:4)')
  expect(await owners($, '/repo/README.md')).toBe('📋 README.md is owned by @org/everyone\nrule: * (.github/CODEOWNERS:2)')
  expect(await owners($, 'api/legacy/old.ts')).toBe('📋 api/legacy/old.ts has no owners: the rule "/api/legacy/" (.github/CODEOWNERS:5) clears them.')
})

test('patterns follow GitHub: anchoring, one-level wildcards, **, directories', async ($, on) => {
  engine(on, GITHUB)

  expect(await owners($, 'docs/guide.md')).toContain('docs@example.com')
  expect(await owners($, 'docs/deep/guide.md')).toContain('@org/everyone') // docs/* reaches one level only
  expect(await owners($, 'a/b/logs/app.log')).toContain('@org/ops') // **/logs at any depth
  expect(await owners($, 'logs/app.log')).toContain('@org/ops')
  expect(await owners($, 'build/out/main.js')).toContain('@org/release') // /build/ and everything under it
  expect(await owners($, 'src/build/main.js')).not.toContain('@org/release') // anchored to the root
  expect(await owners($, 'apps/web/index.html')).toContain('@org/apps') // /apps/**
  expect(await owners($, 'src/deep/er/file.ts')).toContain('@org/frontend') // *.ts at any depth
})

test('looks for CODEOWNERS in .github first, then the root, then docs, and reports when there is none', async ($, on) => {
  const state = engine(on, {
    '/repo/.github/CODEOWNERS': { text: '* @github-team\n', mtimeMs: 1 },
    '/repo/CODEOWNERS': { text: '* @root-team\n', mtimeMs: 1 },
    '/repo/docs/CODEOWNERS': { text: '* @docs-team\n', mtimeMs: 1 },
  })
  expect(await owners($, 'a.txt')).toBe('📋 a.txt is owned by @github-team\nrule: * (.github/CODEOWNERS:1)')

  delete state.disk['/repo/.github/CODEOWNERS']
  expect(await owners($, 'a.txt')).toBe('📋 a.txt is owned by @root-team\nrule: * (CODEOWNERS:1)')

  delete state.disk['/repo/CODEOWNERS']
  expect(await owners($, 'a.txt')).toBe('📋 a.txt is owned by @docs-team\nrule: * (docs/CODEOWNERS:1)')

  delete state.disk['/repo/docs/CODEOWNERS']
  expect(await owners($, 'a.txt')).toContain('No CODEOWNERS file found')
})

test('re-reads CODEOWNERS when it changes', async ($, on) => {
  const state = engine(on, { '/repo/CODEOWNERS': { text: '* @old-team\n', mtimeMs: 1 } })
  expect(await owners($, 'a.txt')).toContain('@old-team')

  state.disk = { '/repo/CODEOWNERS': { text: '* @new-team\n', mtimeMs: 2 } }
  expect(await owners($, 'a.txt')).toContain('@new-team')
})

test('/owners with no argument uses the last file Claude edited; directories and outside paths are handled', async ($, on) => {
  engine(on, GITHUB)
  expect(await owners($, '')).toContain('usage:')

  await $.tool.call({ tool: 'Edit', file_path: '/repo/api/users.ts', old_string: 'a', new_string: 'b' })
  expect(await owners($, '')).toContain('api/users.ts is owned by @org/backend')

  expect(await owners($, 'api')).toContain('api is owned by @org/backend @alice') // a directory is asked as "api/"
  expect(await owners($, '/tmp/x.ts')).toBe('/tmp/x.ts is outside the repository.')
})

test('the edit goes ahead when CODEOWNERS cannot be read', async ($, on) => {
  const state = engine(on, GITHUB)
  state.isReadable = false

  await $.tool.call({ tool: 'Edit', file_path: '/repo/api/users.ts', old_string: 'a', new_string: 'b' })

  expect(state.reached).toEqual(['Edit'])
})

test('the line is cleared when a new turn starts, and /owners is registered at session start', async ($, on) => {
  const state = engine(on, GITHUB)

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  expect(state.statuses).toEqual([undefined])
  expect(state.commands).toEqual(['owners'])
})
