import type { On } from 'claude-code'
import { test, expect } from 'claude-code/testing'

type Repo = { branch: string | undefined }

/** Stands in for the engine; `repo.branch` is what `git symbolic-ref` answers (undefined: not a repo). */
function engine(on: On, repo: Repo) {
  const toasts: string[] = []
  const lines: Array<string | undefined> = []
  const cwds: Array<string | undefined> = []
  on('tool.call', () => ({ result: 'ok' }))
  on('fs.exists', (_$, e) => ({ value: !/\/new(?:\/|$)/.test(e.path) }))
  on('process.run', (_$, e) => {
    cwds.push(e.init?.cwd)
    return {
      value: {
        exitCode: repo.branch === undefined ? 128 : 0,
        stdout: `${repo.branch ?? ''}\n`,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  return { toasts, lines, cwds }
}

const write = (file_path: string) => ({ tool: 'Write', file_path, content: 'x' }) as const

test('warns once, with a toast and a status line, on the first edit on main', async ($, on) => {
  const { toasts, lines } = engine(on, { branch: 'main' })
  const first = await $.tool.call(write('/repo/src/a.ts'))
  const second = await $.tool.call({ tool: 'Edit', file_path: '/repo/src/b.ts', old_string: 'a', new_string: 'b' })

  expect(first.deny).toBeUndefined()
  expect(second.deny).toBeUndefined()
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('"main"')
  expect(lines).toEqual(['⚠ editing on main', '⚠ editing on main'])
})

test('stays silent on feature branches, detached HEAD and outside a repository, and clears the line after a switch', async ($, on) => {
  const repo: Repo = { branch: 'main' }
  const { toasts, lines } = engine(on, repo)
  await $.tool.call(write('/repo/a.ts'))
  repo.branch = 'feat/x'
  await $.tool.call(write('/repo/a.ts'))
  repo.branch = undefined
  await $.tool.call(write('/tmp/notes.txt'))

  expect(toasts).toHaveLength(1)
  expect(lines).toEqual(['⚠ editing on main', undefined, undefined])
})

test('looks at the repository of the file, using the nearest existing folder for new paths', async ($, on) => {
  const { cwds } = engine(on, { branch: 'feat/x' })
  await $.tool.call(write('/work/other-repo/src/a.ts'))
  await $.tool.call(write('/work/other-repo/new/deeper/b.ts'))
  expect(cwds).toEqual(['/work/other-repo/src', '/work/other-repo'])
})

test('block: true refuses edits on main and suggests branching, but lets feature branches through', { options: { block: true } }, async ($, on) => {
  const repo: Repo = { branch: 'master' }
  engine(on, repo)
  const blocked = await $.tool.call(write('/repo/a.ts'))
  expect(blocked.deny).toContain('"master"')
  expect(blocked.deny).toContain('git switch -c')

  repo.branch = 'feat/y'
  const allowed = await $.tool.call(write('/repo/a.ts'))
  expect(allowed.deny).toBeUndefined()
  expect(allowed.result).toBe('ok')
})

test('the list of main branches is configurable', { options: { branches: 'production, release' } }, async ($, on) => {
  const repo: Repo = { branch: 'main' }
  const { toasts } = engine(on, repo)
  await $.tool.call(write('/repo/a.ts'))
  expect(toasts).toHaveLength(0)
  repo.branch = 'release'
  await $.tool.call(write('/repo/a.ts'))
  expect(toasts).toHaveLength(1)
})
