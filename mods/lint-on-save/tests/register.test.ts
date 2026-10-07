import { test, expect } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

type Answer = Partial<ProcessRunResult> | 'missing'
type Run = { argv: readonly string[]; cwd: string | undefined }

/** A project on a virtual disk (absolute path → text) and a linter answering `answer`. */
const world = (on: On, files: Record<string, string>, answer: (argv: readonly string[]) => Answer) => {
  const runs: Run[] = []
  const statuses: string[] = []
  const toasts: string[] = []

  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.list', ($, e) => {
    const prefix = e.path.endsWith('/') ? e.path : `${e.path}/`
    const names = new Set(Object.keys(files).filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length).split('/')[0] ?? ''))
    return { value: [...names].map(name => ({ name, kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.exists', ($, e) => ({ value: e.path in files }))
  on('fs.read', ($, e) => {
    const text = files[e.path]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('process.run', ($, e) => {
    runs.push({ argv: e.argv, cwd: e.init?.cwd })
    const reply = answer(e.argv)
    if (reply === 'missing') return { deny: `failed to start: ENOENT: Executable not found in $PATH: "${e.argv[0]}"` }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...reply } }
  })
  on('tool.call', () => ({ result: { type: 'update' } }))
  on('ui.status', ($, e) => {
    statuses.push(e.text ?? '')
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { runs, statuses, toasts }
}

const ESLINT_PROJECT = {
  '/repo/.git/HEAD': '',
  '/repo/package.json': '{}',
  '/repo/eslint.config.js': 'export default []',
  '/repo/node_modules/.bin/eslint': '',
  '/repo/src/app.ts': 'let x = 1',
}

const eslintReport = (messages: object[]) => ({
  exitCode: messages.length > 0 ? 1 : 0,
  stdout: JSON.stringify([{ filePath: '/repo/src/app.ts', messages }]),
})

const UNUSED = { ruleId: 'no-unused-vars', severity: 2, message: "'x' is assigned a value but never used.", line: 3, column: 7 }
const UNDEFINED = { ruleId: 'no-undef', severity: 2, message: "'y' is not defined.", line: 1, column: 1 }
const PREFER_CONST = { ruleId: 'prefer-const', severity: 1, message: "'x' is never reassigned.", line: 3, column: 5 }

const edit = (file_path: string) => ({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' }) as const

test('hands eslint errors back to Claude, sorted by line, and counts them in the status line', async ($, on) => {
  const { runs, statuses } = world(on, ESLINT_PROJECT, () => eslintReport([UNUSED, PREFER_CONST, UNDEFINED]))

  const ran = await $.tool.call(edit('/repo/src/app.ts'))

  expect(runs).toEqual([{ argv: ['/repo/node_modules/.bin/eslint', '--format', 'json', '/repo/src/app.ts'], cwd: '/repo' }])
  expect(ran.context).toEqual([
    [
      'lint-on-save: eslint reports 2 errors in src/app.ts. Fix them before moving on:',
      "  1:1  error  'y' is not defined.  [no-undef]",
      "  3:7  error  'x' is assigned a value but never used.  [no-unused-vars]",
    ].join('\n'),
  ])
  expect(statuses.at(-1)).toBe('⚠ lint: 2 problems in 1 file')
})

test('includes warnings when asked to', { options: { includeWarnings: true } }, async ($, on) => {
  world(on, ESLINT_PROJECT, () => eslintReport([UNUSED, PREFER_CONST]))

  const ran = await $.tool.call(edit('/repo/src/app.ts'))

  expect(ran.context?.[0]).toContain('reports 1 error and 1 warning in src/app.ts')
  expect(ran.context?.[0]).toContain("3:5  warning  'x' is never reassigned.  [prefer-const]")
})

test('says nothing to Claude once the file is clean, and the status turns green', async ($, on) => {
  let messages: object[] = [UNUSED]
  const { statuses } = world(on, ESLINT_PROJECT, () => eslintReport(messages))

  await $.tool.call(edit('/repo/src/app.ts'))
  messages = []
  const ran = await $.tool.call(edit('/repo/src/app.ts'))

  expect(ran.context).toBeUndefined()
  expect(statuses).toEqual(['⚠ lint: 1 problem in 1 file', '✓ lint: clean'])
})

test('lists at most 30 ruff findings for a Python file', async ($, on) => {
  const findings = Array.from({ length: 35 }, (_, index) => ({
    code: 'F401',
    message: `'mod${index}' imported but unused`,
    location: { row: index + 1, column: 1 },
    filename: '/repo/app.py',
  }))
  const { runs } = world(on, { '/repo/.git/HEAD': '', '/repo/app.py': 'import os' }, () => ({
    exitCode: 1,
    stdout: JSON.stringify(findings),
  }))

  const ran = await $.tool.call({ tool: 'Write', file_path: '/repo/app.py', content: 'import os' })
  const lines = ran.context?.[0]?.split('\n') ?? []

  expect(runs[0]?.argv).toEqual(['ruff', 'check', '--output-format=json', '--no-fix', '/repo/app.py'])
  expect(lines[0]).toBe('lint-on-save: ruff reports 35 errors in app.py. Fix them before moving on:')
  expect(lines).toHaveLength(32)
  expect(lines.at(-1)).toBe('  … and 5 more')
})

test('reads shellcheck and golangci-lint line output for the edited file only', async ($, on) => {
  world(
    on,
    { '/repo/.git/HEAD': '', '/repo/go.mod': 'module x', '/repo/.golangci.yml': '', '/repo/pkg/a.go': '', '/repo/run.sh': '' },
    argv =>
      argv[0] === 'shellcheck'
        ? { exitCode: 1, stdout: '/repo/run.sh:4:6: warning: Double quote to prevent globbing and word splitting. [SC2086]\n/repo/run.sh:9:1: note: Prefer mapfile. [SC2207]' }
        : { exitCode: 1, stdout: 'pkg/a.go:12:2: ineffectual assignment to err (ineffassign)\npkg/b.go:3:1: exported func Foo should have comment (revive)\n1 issues.' },
  )

  const shell = await $.tool.call(edit('/repo/run.sh'))
  const go = await $.tool.call(edit('/repo/pkg/a.go'))

  expect(shell.context?.[0]).toContain('4:6  error  Double quote to prevent globbing and word splitting.  [SC2086]')
  expect(shell.context?.[0]).not.toContain('SC2207')
  expect(go.context?.[0]).toBe(
    'lint-on-save: golangci-lint reports 1 error in pkg/a.go. Fix them before moving on:\n  12:2  error  ineffectual assignment to err  [ineffassign]',
  )
})

test('a missing linter is mentioned once; a crashing one only shows in the status line', async ($, on) => {
  const { runs, toasts, statuses } = world(on, { ...ESLINT_PROJECT, '/repo/app.py': '' }, argv =>
    argv[0] === 'ruff' ? 'missing' : { exitCode: 2, stdout: '', stderr: 'Oops! Something went wrong! Cannot find module "typescript-eslint"' },
  )

  await $.tool.call(edit('/repo/app.py'))
  await $.tool.call(edit('/repo/app.py'))
  const crashed = await $.tool.call(edit('/repo/src/app.ts'))

  expect(runs.map(run => run.argv[0])).toEqual(['ruff', '/repo/node_modules/.bin/eslint'])
  expect(toasts).toEqual(['lint-on-save: ruff is not installed, so app.py was not linted'])
  expect(crashed.context).toBeUndefined()
  expect(statuses.at(-1)).toBe('✗ lint: eslint failed on app.ts: Oops! Something went wrong! Cannot find module "typescript-eslint"')
})
