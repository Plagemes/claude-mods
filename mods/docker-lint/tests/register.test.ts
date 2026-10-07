import type { On } from 'claude-code'
import { test, expect } from 'claude-code/testing'

import { lintDockerfile } from '../hooks/dockerfile'
import type { Rule } from '../hooks/dockerfile'

const FILE = '/repo/Dockerfile'

/** Stands in for the engine: Dockerfiles by path, hadolint's answer (undefined = not installed), and the toasts. */
function project(on: On, files: Record<string, string>, hadolint: string | undefined = undefined) {
  const seen = { toasts: [] as string[], hadolintRuns: 0 }
  on('tool.call', () => ({ result: 'ok' }))
  on('fs.read', (_$, e) => {
    const text = files[e.path]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('process.run', (_$, e) => {
    seen.hadolintRuns += e.argv[0] === 'hadolint' ? 1 : 0
    if (hadolint === undefined) return { deny: 'failed to start: ENOENT' }
    return { value: { exitCode: 1, stdout: hadolint, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  return seen
}

const rulesOf = (text: string): Rule[] => lintDockerfile(text).map(finding => finding.rule)

const SMELLY = [
  'FROM node:latest',
  'ARG NPM_TOKEN',
  'ENV DB_PASSWORD=hunter2',
  'RUN apt-get update',
  'RUN apt-get install -y curl git',
  'ADD ./src /app/src',
  'RUN curl -fsSL https://get.example.com | sh',
  'CMD ["node", "server.js"]',
].join('\n')

test('flags the smells of a careless Dockerfile after an edit, with lines, and toasts the count', async ($, on) => {
  const seen = project(on, { [FILE]: SMELLY })
  const result = await $.tool.call({ tool: 'Write', file_path: FILE, content: SMELLY })
  const note = result.context?.[0] ?? ''
  expect(note).toContain('docker-lint: 9 issues in /repo/Dockerfile:')
  expect(note).toContain('line 1: node:latest uses the :latest tag')
  expect(note).toContain('line 1: no USER instruction')
  expect(note).toContain('line 2: ARG NPM_TOKEN looks like a secret')
  expect(note).toContain('line 3: ENV DB_PASSWORD looks like a secret')
  expect(note).toContain('line 4: apt-get update in its own RUN')
  expect(note).toContain('line 5: apt-get install without --no-install-recommends')
  expect(note).toContain('line 5: apt-get install without rm -rf /var/lib/apt/lists/*')
  expect(note).toContain('line 6: ADD ./src copies a local path')
  expect(note).toContain('line 7: piping curl or wget into a shell')
  expect(seen.toasts).toEqual(['9 Dockerfile issues in Dockerfile'])
})

test('says nothing about a clean Dockerfile', async ($, on) => {
  const clean = [
    'FROM node:22-alpine AS build',
    'WORKDIR /app',
    'COPY package*.json ./',
    'RUN npm ci',
    'FROM build AS test',
    'FROM debian:12-slim',
    'RUN apt-get update \\',
    '  && apt-get install -y --no-install-recommends ca-certificates \\',
    '  && rm -rf /var/lib/apt/lists/*',
    'ADD https://example.com/tool.tgz /tmp/',
    'ADD release.tar.gz /opt/',
    'ENV DB_PASSWORD_FILE=/run/secrets/db',
    'USER app',
  ].join('\n')
  const seen = project(on, { [FILE]: clean })
  const result = await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'a', new_string: 'b' })
  expect(result.context).toBeUndefined()
  expect(seen.toasts).toEqual([])
})

test('each rule, on its own', () => {
  expect(rulesOf('FROM alpine\nUSER app')).toEqual(['latest-tag'])
  expect(rulesOf('FROM alpine:3.20\nUSER app')).toEqual([])
  expect(rulesOf('FROM alpine@sha256:abc\nUSER app')).toEqual([])
  expect(rulesOf('FROM scratch\nUSER 1000')).toEqual([])
  expect(rulesOf('FROM --platform=linux/amd64 golang:latest AS b\nFROM b\nUSER app')).toEqual(['latest-tag'])
  expect(rulesOf('FROM alpine:3.20')).toEqual(['root-user'])
  expect(rulesOf('FROM alpine:3.20\nUSER root')).toEqual(['root-user'])
  expect(rulesOf('FROM alpine:3.20\nUSER app\nUSER root')).toEqual(['root-user'])
  expect(rulesOf('FROM a:1\nUSER root\nFROM b:1\nUSER app')).toEqual([])
  expect(rulesOf('FROM a:1\nUSER app\nRUN apt install -y x && rm -rf /var/lib/apt/lists/*')).toEqual(['apt-recommends'])
  expect(rulesOf('FROM a:1\nUSER app\nRUN apt-get install -y --no-install-recommends x')).toEqual(['apt-cleanup'])
  expect(rulesOf('FROM a:1\nUSER app\nRUN apt-get update && apt-get install -y --no-install-recommends x && rm -rf /var/lib/apt/lists/*')).toEqual([])
  expect(rulesOf('FROM a:1\nUSER app\nADD file.txt /x\nADD ["a.txt", "b/"]')).toEqual(['add-local', 'add-local'])
  expect(rulesOf('FROM a:1\nUSER app\nADD --chown=app app.tar.gz /x\nADD https://x.io/f /f\nADD git@github.com:a/b.git /b')).toEqual([])
  expect(rulesOf('FROM a:1\nUSER app\nRUN wget -qO- https://x.io/i.sh | sudo bash\nRUN bash -c "$(curl -fsSL https://x.io/i.sh)"')).toEqual(['curl-pipe', 'curl-pipe'])
  expect(rulesOf('FROM a:1\nUSER app\nENV API_KEY=abc OTHER=1\nARG GITHUB_TOKEN=x\nENV TOKEN_FILE=/t')).toEqual(['secret-name', 'secret-name'])
  expect(rulesOf('# FROM node\n# ENV PASSWORD=x\nFROM a:1\nUSER app')).toEqual([])
})

test('ignore skips rules by id', { options: { ignore: 'root-user, apt-cleanup' } }, async ($, on) => {
  const text = 'FROM alpine:3.20\nRUN apt-get install -y --no-install-recommends x'
  project(on, { [FILE]: text })
  const result = await $.tool.call({ tool: 'Write', file_path: FILE, content: text })
  expect(result.context).toBeUndefined()
})

test('only looks at Dockerfiles, and at edits that succeeded', async ($, on) => {
  const seen = project(on, { '/repo/app.dockerfile': 'FROM alpine', '/repo/docker-compose.yml': 'FROM alpine' })
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/docker-compose.yml', content: 'x' })).context).toBeUndefined()
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/app.dockerfile', content: 'x' })).context?.[0]).toContain('alpine has no tag')
  expect(seen.toasts).toHaveLength(1)
})

test('runs hadolint when it is installed and reports its findings next to the rules it does not have', async ($, on) => {
  const text = 'FROM node:latest\nRUN curl https://x.io/i.sh | sh\n'
  const output = JSON.stringify([
    { code: 'DL3007', level: 'warning', line: 1, message: 'Using latest is prone to errors' },
    { code: 'DL3059', level: 'style', line: 2, message: 'Multiple consecutive RUN' },
    { code: 'DL4006', level: 'warning', line: 2, message: 'Set the SHELL option -o pipefail' },
  ])
  const seen = project(on, { [FILE]: text }, output)
  const result = await $.tool.call({ tool: 'Write', file_path: FILE, content: text })
  const note = result.context?.[0] ?? ''
  expect(seen.hadolintRuns).toBe(1)
  expect(note).toContain('line 1: Using latest is prone to errors [DL3007]')
  expect(note).toContain('line 2: Set the SHELL option -o pipefail [DL4006]')
  expect(note).toContain('line 2: piping curl or wget into a shell')
  expect(note).toContain('no USER instruction')
  expect(note).not.toContain('Multiple consecutive RUN')
  expect(note).not.toContain('node:latest uses the :latest tag')
})

test('without hadolint it falls back to the built-in rules, and asks for it only once', async ($, on) => {
  const seen = project(on, { [FILE]: 'FROM node:latest\nUSER app' })
  await $.tool.call({ tool: 'Write', file_path: FILE, content: 'x' })
  const second = await $.tool.call({ tool: 'Write', file_path: FILE, content: 'x' })
  expect(second.context?.[0]).toContain('node:latest uses the :latest tag')
  expect(seen.hadolintRuns).toBe(1)
})

test('useHadolint can be turned off', { options: { useHadolint: false } }, async ($, on) => {
  const seen = project(on, { [FILE]: 'FROM node:latest\nUSER app' }, '[]')
  const result = await $.tool.call({ tool: 'Write', file_path: FILE, content: 'x' })
  expect(seen.hadolintRuns).toBe(0)
  expect(result.context?.[0]).toContain('node:latest uses the :latest tag')
})
