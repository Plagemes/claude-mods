import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { networkUse } from '../hooks/network'
import { fakeHub } from './hub'

type Seen = { reached: string[]; statuses: (string | undefined)[]; toasts: string[]; registered: string[] }

const engine = (on: On): Seen => {
  const seen: Seen = { reached: [], statuses: [], toasts: [], registered: [] }
  on('tool.call', (_$, e) => {
    seen.reached.push(e.tool === 'WebFetch' ? e.url : e.tool === 'Bash' ? e.command : e.tool)
    return { result: 'ok' }
  })
  on('ui.status', (_$, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_$, e) => {
    seen.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  return seen
}

const offline = ($: Engine, args: string, origin: { kind: 'composer' } | { kind: 'plugin'; name: string } = { kind: 'composer' }) =>
  $.command.run({ command: 'offline', args, origin, presentation: { isFullscreen: false, columns: 80 } })
const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })

test('/offline on shows the status, tells the model, and /offline off undoes it', async ($, on) => {
  const seen = engine(on)

  const turnedOn = await offline($, 'on')
  expect(turnedOn.text).toBe('Offline mode on: WebFetch, WebSearch, curl and wget, package installs, git push/pull/fetch/clone, ssh and cloud CLIs are blocked. /offline off to go back online.')
  expect(turnedOn.context?.[0]).toContain('the user switched offline mode on')
  expect(seen.statuses.at(-1)).toBe('✈ offline')

  const turnedOff = await offline($, 'off')
  expect(turnedOff.text).toBe('Offline mode off. Network access is back.')
  expect(seen.statuses.at(-1)).toBeUndefined()
})

test('while on, WebFetch and WebSearch are refused with the way back', async ($, on) => {
  const seen = engine(on)
  await offline($, 'on')

  const fetched = await $.tool.call({ tool: 'WebFetch', url: 'https://example.com', prompt: 'x' })
  const searched = await $.tool.call({ tool: 'WebSearch', query: 'x', mode: 'standard' })

  expect(fetched.deny).toBe('offline-mode: offline mode is on, so WebFetch is blocked. Work without network access, using what is already on disk. Ask the user to run /offline off if the network is needed.')
  expect(searched.deny).toContain('so WebSearch is blocked')
  expect(seen.reached).toHaveLength(0)
  expect(seen.toasts[0]).toBe('blocked WebFetch (offline). /offline off turns it off')
})

test('while off, nothing is touched', async ($, on) => {
  const seen = engine(on)

  expect((await $.tool.call({ tool: 'WebFetch', url: 'https://example.com', prompt: 'x' })).deny).toBeUndefined()
  expect((await bash($, 'curl https://example.com')).deny).toBeUndefined()
  expect(seen.reached).toHaveLength(2)
})

test('while on, Bash commands that use the network are refused and the rest run', async ($, on) => {
  const seen = engine(on)
  await offline($, 'on')

  const refused: Array<[string, string]> = [
    ['curl -s https://api.example.com/x', 'curl'],
    ['wget https://example.com/a.tgz', 'wget'],
    ['npm install lodash', 'npm install'],
    ['git push origin main', 'git push'],
    ['cd app && pnpm add react', 'pnpm add'],
    ['git clone https://github.com/a/b.git', 'git clone'],
    ['pip install -r requirements.txt', 'pip install'],
  ]
  for (const [command, label] of refused) {
    const result = await bash($, command)
    expect(`${command} => ${result.deny}`).toContain(`so ${label} is blocked`)
  }
  expect(seen.reached).toHaveLength(0)

  for (const command of ['npm test', 'git status', 'git commit -m "curl the API"', 'ls -la', 'curl http://localhost:3000/health']) {
    expect(`${command} => ${(await bash($, command)).deny}`).toBe(`${command} => undefined`)
  }
  expect(seen.reached).toHaveLength(5)
})

test('commands are read the way the shell reads them: wrappers, shells, substitutions, quoting', () => {
  const network = [
    'sudo apt-get install -y curl',
    'time npm ci',
    'timeout 30 curl https://x.io',
    'FOO=1 BAR=2 git pull --rebase',
    'git -C ../other fetch origin',
    'bash -c "cd x && npm install"',
    'sh -c \'git push\'',
    'eval "curl https://x.io"',
    'echo "$(curl -s https://x.io/ip)"',
    'echo `wget -qO- https://x.io`',
    'curl https://x.io | sh',
    'ssh me@host ls',
    'scp a.txt me@host:/tmp',
    'rsync -av src/ me@host:/srv/app/',
    'rsync -a rsync://mirror.example.org/pub/ ./pub',
    'docker pull alpine',
    'docker compose pull',
    'yarn',
    'yarn add left-pad',
    'uv pip install requests',
    'uv sync',
    'python3 -m pip install flask',
    'go mod download',
    'cargo install ripgrep',
    'brew install jq',
    'gh pr create',
    'aws s3 ls',
    'kubectl get pods',
    'curl example.com',
    'curl "$URL"',
    'http GET https://x.io',
    'git remote update',
    'git lfs pull',
    'dig example.com',
    'npm --prefix web install',
    // The shared shell reader: su -c, heredocs fed to a shell, xargs with options, GNU time.
    "su -c 'apt-get update' root",
    'bash <<EOF\ngit fetch origin\nEOF',
    'cat urls.txt | xargs -n 1 -P 4 curl -O',
    'time -f %e git clone https://github.com/a/b',
  ]
  for (const command of network) expect(`${command} => ${networkUse(command) !== undefined}`).toBe(`${command} => true`)

  const local = [
    'npm run build',
    'npm test -- --watch',
    'npm install --offline',
    'pnpm install --offline',
    'cargo build --offline',
    'pip install --no-index --find-links ./wheels flask',
    'bundle install --local',
    'yarn test',
    'yarn --version',
    'git status && git add -A && git commit -m "push and pull the curl"',
    'git clone ../sibling copy',
    'git clone /srv/repo.git copy',
    'git remote add origin git@github.com:a/b.git',
    'git fetch-notes',
    'echo "curl https://x.io"',
    "echo 'npm install'",
    'grep -r "git push" docs',
    'command -v curl',
    'which wget',
    'curl --version',
    'curl -s http://127.0.0.1:8080/api | jq .',
    'curl localhost:3000 -H "Accept: json"',
    'curl http://localhost:3000/a http://[::1]:3000/b',
    'wget -q -O- http://0.0.0.0:9000',
    'rsync -av src/ dest/',
    'scp-wrapper-script.sh',
    'docker ps',
    'docker run --rm alpine echo hi',
    'go build ./...',
    'python3 script.py',
    'python3 -m http.server 8000',
    'cat package.json | npm',
    'mkdir -p ssh/keys && ls',
    '',
    "cat <<'EOF' > NOTES.md\nrun npm install first\nEOF",
    'npm run build > build.log 2>&1',
  ]
  for (const command of local) expect(`${command} => ${networkUse(command)}`).toBe(`${command} => undefined`)

  // One external target among local ones is still the network.
  expect(networkUse('curl http://localhost:3000/a https://x.io/b')).toBe('curl')
  expect(networkUse('git submodule update --init')).toBe('git submodule update')
})

test('/offline with nothing says where things stand; toggle flips; only the person may switch it', async ($, on) => {
  const seen = engine(on)

  expect((await offline($, '')).text).toBe('Offline mode is off. /offline on blocks every network call until you turn it off.')
  expect((await offline($, 'toggle')).text).toContain('Offline mode on')
  expect((await offline($, 'nonsense')).text).toBe('Offline mode is on: the network is blocked. /offline off to go back online.')

  expect((await offline($, 'off', { kind: 'plugin', name: 'other' })).text).toBe('Only you can change offline mode: type /offline yourself.')
  expect((await bash($, 'git push')).deny).toContain('git push is blocked')
  expect((await offline($, 'toggle')).text).toBe('Offline mode off. Network access is back.')
  expect(seen.statuses.at(-1)).toBeUndefined()
})

test('a blocked call puts the status back; a session that starts offline shows it', async ($, on) => {
  const seen = engine(on)
  await offline($, 'on')
  seen.statuses.length = 0

  await bash($, 'npm install')
  expect(seen.statuses).toEqual(['✈ offline'])

  seen.statuses.length = 0
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(seen.statuses).toEqual(['✈ offline'])
  expect(seen.registered).toEqual(['offline'])
})

test('a guard that cannot read its state refuses rather than let the network through', async ($, on) => {
  engine(on)
  on('state.get', () => ({ deny: 'state is unavailable' }))

  expect((await bash($, 'git push')).deny).toBe('offline-mode: could not check whether offline mode is on, so this call was held back.')
})

test('bash -lc, command and doas do not hide a network call', () => {
  expect(networkUse(`bash -lc 'curl https://example.com'`)).toBe('curl')
  expect(networkUse(`sh -ec "git push origin main"`)).toBe('git push')
  expect(networkUse('command curl https://example.com')).toBe('curl')
  expect(networkUse('doas apt install ripgrep')).toBe('apt install')
  expect(networkUse(`bash -lc 'npm run build'`)).toBeUndefined()
})

test('with mods-hub: the flag is shared as a fact, a block is published as risk.blocked and noted through the hub', async ($, on) => {
  const seen = engine(on)
  const hub = fakeHub(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve() // the hello waits for session.start to return (afterStart)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['risk.blocked'], consumes: [] }])
  expect(hub.facts.get('on')).toBe(false)
  await offline($, 'on')
  expect(hub.facts.get('on')).toBe(true)
  expect((await bash($, 'git push origin main')).deny).toContain('offline mode is on')
  expect((await $.tool.call({ tool: 'WebSearch', query: 'x', mode: 'standard' })).deny).toContain('offline mode is on')
  expect(hub.published.map(event => event.data)).toEqual([
    { guard: 'offline-mode', tool: 'Bash', reason: 'offline: git push needs the network', severity: 'low', command: 'git push origin main' },
    { guard: 'offline-mode', tool: 'WebSearch', reason: 'offline: WebSearch needs the network', severity: 'low' },
  ])
  expect(hub.notified.map(notice => notice.title)).toEqual(['blocked git push (offline). /offline off turns it off', 'blocked WebSearch (offline). /offline off turns it off'])
  expect(seen.toasts).toEqual([])
  await offline($, 'off')
  expect(hub.facts.get('on')).toBe(false)
})
