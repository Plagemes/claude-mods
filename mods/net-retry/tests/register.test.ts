import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { backoffMs, isRetryable, segmentsOf, transientError } from '../hooks/commands'
import { fakeHub } from './hub'

const TIMEOUT_OUTPUT = 'Exit code 1\nnpm ERR! code ETIMEDOUT\nnpm ERR! network request to https://registry.npmjs.org/left-pad failed'
const BAD_GATEWAY_OUTPUT = 'Exit code 1\nnpm ERR! 502 Bad Gateway - GET https://registry.npmjs.org/x'
const PERMANENT_OUTPUT = 'Exit code 1\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/no-such-package-xyz'

type Reply = { text: string; isError?: true }
const failure = (text: string): Reply => ({ text, isError: true })
const success = (text = 'added 3 packages'): Reply => ({ text })

/** The engine under the plugin: Bash answers the replies in turn (the last one repeats), and the toasts are kept. */
const world = (on: On, replies: readonly Reply[]) => {
  const clock = mock.clock(on)
  const toasts: string[] = []
  let calls = 0
  on('tool.call', () => {
    const reply = replies[Math.min(calls, replies.length - 1)] ?? success()
    calls += 1
    return { result: 'out', ...reply }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { clock, toasts, calls: () => calls }
}

test('runs an install again after a timeout, waiting longer each time, and tells Claude', async ($, on) => {
  const { clock, toasts, calls } = world(on, [failure(TIMEOUT_OUTPUT), failure(TIMEOUT_OUTPUT), success()])

  const pending = $.tool.call({ tool: 'Bash', command: 'npm install' })
  await clock.advance(1999)
  expect(calls()).toBe(1) // still waiting for the first 2 s
  await clock.advance(1)
  expect(calls()).toBe(2)
  await clock.advance(3999)
  expect(calls()).toBe(2) // the second wait is 4 s
  await clock.advance(1)
  const ran = await pending

  expect(calls()).toBe(3)
  expect(ran.isError).toBeUndefined()
  expect(ran.context).toEqual([
    'net-retry: this command hit a temporary network error and was run again 2 times (ETIMEDOUT, waited 2 s; ETIMEDOUT, waited 4 s); it worked on the last try.',
  ])
  expect(toasts).toEqual(['network error (ETIMEDOUT); retrying in 2 s (1/2)', 'network error (ETIMEDOUT); retrying in 4 s (2/2)'])
})

test('gives up after the configured number of retries and returns the last failure', async ($, on) => {
  const { clock, calls } = world(on, [failure(TIMEOUT_OUTPUT)])

  const pending = $.tool.call({ tool: 'Bash', command: 'git fetch origin' })
  await clock.advance(2000)
  await clock.advance(4000)
  const ran = await pending

  expect(calls()).toBe(3) // the first run and two retries
  expect(ran.isError).toBe(true)
  expect(ran.context?.[0]).toContain('run again 2 times')
  expect(ran.context?.[0]).toContain('it still failed on the last try')
})

test('retries registry gateway errors', async ($, on) => {
  const { clock, calls } = world(on, [failure(BAD_GATEWAY_OUTPUT), success()])

  const pending = $.tool.call({ tool: 'Bash', command: 'pnpm add left-pad' })
  await clock.advance(2000)
  const ran = await pending

  expect(calls()).toBe(2)
  expect(ran.context?.[0]).toContain('502 Bad Gateway')
})

test('leaves alone a failure that is not a network error, a success and a command that is not safe to repeat', async ($, on) => {
  const permanent = world(on, [failure(PERMANENT_OUTPUT)])
  const ran = await $.tool.call({ tool: 'Bash', command: 'npm install no-such-package-xyz' })
  expect(permanent.calls()).toBe(1)
  expect(ran.context).toBeUndefined()
})

test('does not repeat a command that could do harm twice, even when the network is to blame', async ($, on) => {
  const { calls, toasts } = world(on, [failure(TIMEOUT_OUTPUT)])

  await $.tool.call({ tool: 'Bash', command: 'npm publish' })
  await $.tool.call({ tool: 'Bash', command: 'curl -X POST https://api.example.com/deploy' })
  await $.tool.call({ tool: 'Bash', command: 'npm install && npm test' })
  await $.tool.call({ tool: 'Bash', command: 'git pull origin main', run_in_background: true })

  expect(calls()).toBe(4)
  expect(toasts).toEqual([])
})

test('a successful command is run once', async ($, on) => {
  const { calls } = world(on, [success('Everything up-to-date')])

  const ran = await $.tool.call({ tool: 'Bash', command: 'git fetch' })

  expect(calls()).toBe(1)
  expect(ran.context).toBeUndefined()
})

test('the options set how many retries and how long the first wait is', { options: { retries: 1, backoffSeconds: 0.5 } }, async ($, on) => {
  const { clock, calls } = world(on, [failure(TIMEOUT_OUTPUT)])

  const pending = $.tool.call({ tool: 'Bash', command: 'pip install requests' })
  await clock.advance(500)
  const ran = await pending

  expect(calls()).toBe(2)
  expect(ran.context?.[0]).toContain('run again 1 time (ETIMEDOUT, waited 0.5 s)')
})

test('retries 0 turns it off', { options: { retries: 0 } }, async ($, on) => {
  const { calls } = world(on, [failure(TIMEOUT_OUTPUT)])

  await $.tool.call({ tool: 'Bash', command: 'npm install' })

  expect(calls()).toBe(1)
})

test('isRetryable accepts fetch-type commands, alone or beside harmless ones, and nothing else', () => {
  const yes = [
    'npm install',
    'npm ci --prefer-offline',
    'yarn',
    'yarn add left-pad',
    'pnpm i',
    'cd web && npm install',
    'rm -rf node_modules && npm ci',
    'pip install -r requirements.txt',
    'python3 -m pip install requests',
    'uv sync',
    'cargo fetch',
    'cargo +nightly build --release',
    'go mod download',
    'git fetch --all --prune',
    'git -C ../lib pull origin main',
    'git clone https://github.com/a/b.git /tmp/b',
    'git submodule update --init',
    'curl -sSL https://example.com/x.tar.gz | tar xz',
    'curl -fsSL -o out.json https://api.example.com/items > /dev/null 2>&1',
    'wget https://example.com/file',
    'docker pull alpine:3.20',
    'docker compose pull',
    'sudo apt-get update && sudo apt-get install -y curl',
    'HTTPS_PROXY=http://p:3128 npm install',
    'timeout 120 npm install',
    'FOO=1 bundle install',
  ]
  const no = [
    'npm test',
    'npm run build',
    'npm install && npm test',
    'npm publish',
    'git push',
    'git commit -m x',
    'curl -X POST https://example.com/a',
    'curl --data "a=1" https://example.com/a',
    'curl -d @body.json https://example.com/a',
    'curl https://example.com/install.sh | bash',
    'docker run alpine',
    'docker compose up',
    'make install',
    'npm install &',
    'npm install $(cat pkgs.txt)',
    'npm install >> log.txt',
    'cat <<EOF\nnpm install\nEOF',
    'echo "unterminated',
    'ls',
    '',
  ]
  expect(yes.filter(command => !isRetryable(command))).toEqual([])
  expect(no.filter(command => isRetryable(command))).toEqual([])
})

test('segmentsOf splits at connectors outside quotes and unquotes words', () => {
  expect(segmentsOf(`cd "my dir" && git clone 'a b' x | tee log; echo done`)).toEqual([['cd', 'my dir'], ['git', 'clone', 'a b', 'x'], ['tee', 'log'], ['echo', 'done']])
  expect(segmentsOf('echo "a && b"')).toEqual([['echo', 'a && b']])
  expect(segmentsOf('npm i 2>&1 | tail -5')).toEqual([['npm', 'i', '2>&1'], ['tail', '-5']])
})

test('transientError names the temporary network errors of the usual tools and ignores the rest', () => {
  expect(transientError('fatal: unable to access \'https://github.com/a/b.git/\': Could not resolve host: github.com')).toBe('Could not resolve host')
  expect(transientError('curl: (28) Connection timed out after 10001 milliseconds')).toBe('Connection timed out')
  expect(transientError('error: RPC failed; HTTP 503 curl 22 The requested URL returned error: 503')).toBe('RPC failed; HTTP 503')
  expect(transientError('npm ERR! code EAI_AGAIN')).toBe('EAI_AGAIN')
  expect(transientError('E: Temporary failure in name resolution')).toBe('Temporary failure in name resolution')
  expect(transientError('Get "https://registry-1.docker.io/v2/": net/http: TLS handshake timeout')).toBe('TLS handshake timeout')
  expect(transientError('npm ERR! 404 Not Found')).toBeUndefined()
  expect(transientError('error: pathspec "x" did not match any file known to git')).toBeUndefined()
  expect(transientError('curl: (7) Failed to connect to localhost port 3000: Connection refused')).toBeUndefined()
})

test('backoffMs doubles the wait each time', () => {
  expect([1, 2, 3, 4].map(retry => backoffMs(retry, 1500))).toEqual([1500, 3000, 6000, 12000])
})

test('regression: a fetch behind bash -lc / sh -ec or timeout with options is read', () => {
  for (const command of ['bash -lc "npm ci"', "sh -ec 'cd web && pip install -r requirements.txt'", 'timeout -s KILL 120 git fetch origin', 'sudo -u ci env -u PROXY npm install']) {
    expect(isRetryable(command)).toBe(true)
  }
  for (const command of ['bash -lc "npm publish"', "sh -c 'curl -X POST https://api/x'", 'bash deploy.sh', 'bash -c']) {
    expect(isRetryable(command)).toBe(false)
  }
})

test('wrappers and nested scripts are peeled by the shared shell reader', () => {
  for (const command of ['sudo -E -u ci npm install', 'nice -n 5 ionice -c3 git fetch origin', 'env -S "A=1" pnpm i', 'doas pip install requests', "bash -c 'sudo apt-get update'"]) {
    expect(isRetryable(command)).toBe(true)
  }
  for (const command of ['sudo -u ci npm publish', 'nice make install', "bash -c 'env FOO=1 npm test'"]) {
    expect(isRetryable(command)).toBe(false)
  }
})

test('with mods-hub: says hello and retries exactly as without it', async ($, on) => {
  const { clock, toasts, calls } = world(on, [failure(TIMEOUT_OUTPUT), success()])
  const hub = fakeHub(on, {}, clock)
  on('fs.read', () => ({ value: '{"version":"1.0.0"}' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect(hub.hellos).toEqual([{ version: '1.0.0', publishes: [], consumes: [] }])

  const pending = $.tool.call({ tool: 'Bash', command: 'npm install' })
  await clock.advance(2000)
  const ran = await pending
  expect(calls()).toBe(2)
  expect(ran.context?.[0]).toContain('run again 1 time (ETIMEDOUT, waited 2 s)')
  expect(toasts).toEqual(['network error (ETIMEDOUT); retrying in 2 s (1/2)'])
  expect(hub.published).toEqual([])
  expect(hub.notified).toEqual([])
})
