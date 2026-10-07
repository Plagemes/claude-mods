import type { On } from 'claude-code'
import { test, expect } from 'claude-code/testing'

import { checkWorkflow, parseActionlint } from '../hooks/workflow'

const FILE = '/repo/.github/workflows/ci.yml'
const SHA = 'b4ffde65f46336ab88eb53be808477a3936bae11'

/** Stands in for the engine: workflow files by path, actionlint's output (undefined = not installed), and the toasts. */
function project(on: On, files: Record<string, string>, actionlint: string | undefined = undefined) {
  const seen = { toasts: [] as string[], actionlintRuns: 0 }
  on('tool.call', () => ({ result: 'ok' }))
  on('fs.read', (_$, e) => {
    const text = files[e.path]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('process.run', (_$, e) => {
    seen.actionlintRuns += e.argv[0] === 'actionlint' ? 1 : 0
    if (actionlint === undefined) return { deny: 'failed to start: ENOENT' }
    return { value: { exitCode: 1, stdout: actionlint, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  return seen
}

const SLOPPY = [
  'name: CI',
  'on: [push, pull_request]',
  'jobs:',
  '  build:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout',
  '      - uses: actions/setup-node@main',
  '      - run: echo "token ${{ secrets.NPM_TOKEN }}"',
].join('\n')

const GOOD = [
  'name: CI',
  'on: [push, pull_request]',
  'permissions:',
  '  contents: read',
  'jobs:',
  '  build:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v4',
  `      - uses: actions/setup-node@${SHA} # v4`,
  '      - uses: ./.github/actions/local',
  '      - run: npm ci',
].join('\n')

test('warns about unpinned actions, a missing permissions block and echoed secrets, with lines', async ($, on) => {
  const seen = project(on, { [FILE]: SLOPPY })
  const result = await $.tool.call({ tool: 'Write', file_path: FILE, content: SLOPPY })
  const note = result.context?.[0] ?? ''
  expect(note).toContain('ci-yaml-check: 4 issues in /repo/.github/workflows/ci.yml:')
  expect(note).toContain('file [warn]: no permissions: block')
  expect(note).toContain('line 7 [warn]: actions/checkout has no version')
  expect(note).toContain('line 8 [warn]: actions/setup-node@main follows a moving branch')
  expect(note).toContain('line 9 [error]: a secret is printed by this command')
  expect(seen.toasts).toEqual(['4 workflow issues in ci.yml'])
})

test('says nothing about a pinned, least-privilege workflow, and ignores other files', async ($, on) => {
  const seen = project(on, { [FILE]: GOOD, '/repo/docker-compose.yml': SLOPPY, '/repo/.github/dependabot.yml': SLOPPY })
  expect((await $.tool.call({ tool: 'Write', file_path: FILE, content: GOOD })).context).toBeUndefined()
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/docker-compose.yml', content: 'x' })).context).toBeUndefined()
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/.github/dependabot.yml', content: 'x' })).context).toBeUndefined()
  expect(seen.toasts).toEqual([])
})

test('flags pull_request_target that checks out the pull request head, and only that', () => {
  const risky = [
    'on:',
    '  pull_request_target:',
    'permissions: {}',
    'jobs:',
    '  t:',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with:',
    '          ref: ${{ github.event.pull_request.head.sha }}',
    '      - run: npm test',
  ].join('\n')
  const found = checkWorkflow(risky, { requireSha: false })
  expect(found).toEqual([{ line: 7, severity: 'error', message: expect.stringContaining('pull_request_target checks out') }])

  const base = risky.replace('${{ github.event.pull_request.head.sha }}', 'main')
  expect(checkWorkflow(base, { requireSha: false })).toEqual([])
  const plain = risky.replace('pull_request_target', 'pull_request')
  expect(checkWorkflow(plain, { requireSha: false })).toEqual([])
})

test('permissions: a top-level block is enough, a job-level one counts per job', () => {
  const perJob = ['on: push', 'jobs:', '  a:', '    permissions:', '      contents: read', '    runs-on: x', '  b:', '    runs-on: x'].join('\n')
  expect(checkWorkflow(perJob, { requireSha: false })).toEqual([
    { line: 7, severity: 'warn', message: 'job b has no permissions: block while other jobs do; it gets the wide default token' },
  ])
  const all = perJob.replace('  b:\n    runs-on: x', '  b:\n    permissions: read-all\n    runs-on: x')
  expect(checkWorkflow(all, { requireSha: false })).toEqual([])
})

test('tabs in the indentation are an error', () => {
  const found = checkWorkflow('permissions: read-all\non: push\njobs:\n\tbuild:\n    runs-on: x\n', { requireSha: false })
  expect(found).toEqual([{ line: 4, severity: 'error', message: expect.stringContaining('a tab in the indentation') }])
})

test('toJSON(secrets) and commands that print a secret are flagged; env mapping is not', () => {
  const text = [
    'permissions: read-all',
    'on: push',
    'jobs:',
    '  a:',
    '    steps:',
    '      - run: echo "${{ toJSON(secrets) }}"',
    '      - run: |',
    '          echo "token is ${{ secrets.KEY }}"',
    '      - run: deploy',
    '        env:',
    '          TOKEN: ${{ secrets.TOKEN }}',
  ].join('\n')
  expect(checkWorkflow(text, { requireSha: false }).map(finding => finding.line)).toEqual([6, 8])
})

test('requireSha also asks for full commit SHAs', { options: { requireSha: true } }, async ($, on) => {
  project(on, { [FILE]: GOOD })
  const result = await $.tool.call({ tool: 'Write', file_path: FILE, content: GOOD })
  const note = result.context?.[0] ?? ''
  expect(note).toContain('line 9 [warn]: actions/checkout@v4 is a tag')
  expect(note).not.toContain('setup-node')
})

test('runs actionlint when it is installed and adds its findings; asks for it only once when it is not', async ($, on) => {
  const output = `${FILE}:7:9: property "foo" is not defined in object type {} [expression]\n`
  const seen = project(on, { [FILE]: GOOD }, output)
  const result = await $.tool.call({ tool: 'Write', file_path: FILE, content: GOOD })
  expect(seen.actionlintRuns).toBe(1)
  expect(result.context?.[0]).toContain('line 7 [error]: actionlint: property "foo" is not defined in object type {} [expression]')
  expect(parseActionlint(output)).toEqual([{ line: 7, message: 'property "foo" is not defined in object type {} [expression]' }])
})

test('without actionlint the built-in checks still run, and it is not asked twice', async ($, on) => {
  const seen = project(on, { [FILE]: SLOPPY })
  await $.tool.call({ tool: 'Write', file_path: FILE, content: 'x' })
  const second = await $.tool.call({ tool: 'Write', file_path: FILE, content: 'x' })
  expect(second.context?.[0]).toContain('actions/checkout has no version')
  expect(seen.actionlintRuns).toBe(1)
})

test('useActionlint can be turned off', { options: { useActionlint: false } }, async ($, on) => {
  const seen = project(on, { [FILE]: GOOD }, `${FILE}:1:1: nope [syntax]`)
  const result = await $.tool.call({ tool: 'Write', file_path: FILE, content: GOOD })
  expect(seen.actionlintRuns).toBe(0)
  expect(result.context).toBeUndefined()
})

test('regression: a secret piped or written to a file is not printed, and 4-space job permissions are seen', () => {
  const piped = [
    'permissions: read-all',
    'on: push',
    'jobs:',
    '  a:',
    '    steps:',
    '      - run: echo "${{ secrets.DOCKER_PASSWORD }}" | docker login -u me --password-stdin',
    '      - run: printf %s "${{ secrets.KEY }}" > key.pem',
  ].join('\n')
  expect(checkWorkflow(piped, { requireSha: false })).toEqual([])

  const wide = ['on: push', 'jobs:', '    a:', '        permissions:', '            contents: read', '        runs-on: x', '    b:', '        permissions: read-all', '        runs-on: x'].join('\n')
  expect(checkWorkflow(wide, { requireSha: false })).toEqual([])
  const oneMissing = wide.replace('        permissions: read-all\n', '')
  expect(checkWorkflow(oneMissing, { requireSha: false })).toEqual([
    { line: 7, severity: 'warn', message: 'job b has no permissions: block while other jobs do; it gets the wide default token' },
  ])
})
