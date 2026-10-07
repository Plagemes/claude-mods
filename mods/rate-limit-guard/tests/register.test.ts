import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { externalHosts, hostOf, isLocalHost, loopOfFetches } from '../hooks/requests'
import { fakeHub } from './hub'

const NOW = 1_800_000_000_000

const engine = (on: On) => {
  const clock = mock.clock(on, { now: NOW })
  const seen = { reached: [] as string[], toasts: [] as string[] }
  on('tool.call', (_$, e) => {
    seen.reached.push(e.tool === 'Bash' ? e.command : e.tool)
    return { result: 'ok' }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  return { clock, seen }
}

const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })
const calls = async ($: Engine, clock: MockClock, host: string, count: number, gapMs = 100): Promise<Awaited<ReturnType<typeof bash>>[]> => {
  const results = []
  for (let index = 0; index < count; index += 1) {
    results.push(await bash($, `curl -s https://${host}/items/${index}`))
    await clock.advance(gapMs)
  }
  return results
}

test('twenty calls to a host in a minute go through, the twenty-first is refused and the host paused', async ($, on) => {
  const { clock, seen } = engine(on)

  const first = await calls($, clock, 'api.example.com', 20)
  expect(first.every(result => result.deny === undefined)).toBe(true)

  const refused = await bash($, 'curl -s https://api.example.com/items/21')
  expect(refused.deny).toContain('rate-limit-guard: 20 requests to api.example.com in the last 60 s, and the limit is 20.')
  expect(refused.deny).toContain('Requests to api.example.com are paused for 60 s.')
  expect(refused.deny).toContain('pagination')
  expect(seen.toasts).toEqual(['paused requests to api.example.com for 60 s (20 in the last 60 s)'])
  expect(seen.reached).toHaveLength(20)
})

test('the pause lasts a window, then counting starts again', async ($, on) => {
  const { clock, seen } = engine(on)
  await calls($, clock, 'api.example.com', 20)
  await bash($, 'curl https://api.example.com/x')

  await clock.advance(30_000)
  const during = await bash($, 'curl https://api.example.com/x')
  expect(during.deny).toContain('requests to api.example.com are paused for 30 more s')

  await clock.advance(30_000)
  expect((await bash($, 'curl https://api.example.com/x')).deny).toBeUndefined()
  expect(seen.reached).toHaveLength(21)
})

test('the window slides: calls spread over time never reach the limit', async ($, on) => {
  const { clock } = engine(on)

  const results = await calls($, clock, 'api.example.com', 60, 4_000)

  expect(results.filter(result => result.deny !== undefined)).toHaveLength(0)
})

test('hosts are counted separately; local addresses are not counted at all', async ($, on) => {
  const { clock } = engine(on)
  await calls($, clock, 'a.example.com', 20)

  expect((await bash($, 'curl https://b.example.com/x')).deny).toBeUndefined()
  expect((await bash($, 'curl https://a.example.com/x')).deny).toBeDefined()
  expect((await calls($, clock, 'localhost:3000', 30)).every(result => result.deny === undefined)).toBe(true)
  expect((await calls($, clock, '192.168.1.20', 30)).every(result => result.deny === undefined)).toBe(true)
})

test('one command that makes several requests counts for each, and a refused one records nothing', async ($, on) => {
  const { clock, seen } = engine(on)
  await calls($, clock, 'api.example.com', 18)

  expect((await bash($, 'curl https://api.example.com/a; curl https://api.example.com/b')).deny).toBeUndefined()
  const refused = await bash($, 'curl https://other.example.org/x && curl https://api.example.com/c')
  expect(refused.deny).toContain('requests to api.example.com')
  // The refused command did not use up a call against other.example.org.
  expect((await bash($, 'curl https://other.example.org/y')).deny).toBeUndefined()
  expect(seen.reached.at(-1)).toBe('curl https://other.example.org/y')
})

test('the limit and the window are configurable', { options: { maxCalls: 3, windowSec: 10 } }, async ($, on) => {
  const { clock } = engine(on)

  const results = await calls($, clock, 'api.example.com', 5, 500)

  expect(results.map(result => result.deny === undefined)).toEqual([true, true, true, false, false])
  expect(results[3]?.deny).toContain('limit is 3. Requests to api.example.com are paused for 10 s.')
  await clock.advance(10_000)
  expect((await bash($, 'curl https://api.example.com/again')).deny).toBeUndefined()
})

test('a loop of requests is let through with a warning for Claude; a polite loop is not', async ($, on) => {
  const { seen } = engine(on)

  const loop = await bash($, 'for i in $(seq 1 200); do curl -s https://api.example.com/items/$i; done')
  expect(loop.deny).toBeUndefined()
  expect(loop.context?.[0]).toContain('rate-limit-guard: this command fetches in a loop (about 200 rounds) with nothing slowing it down')
  expect(loop.context?.[0]).toContain('20 calls per 60 s')

  const polite = await bash($, 'for i in 1 2 3; do curl -s https://api.example.com/$i; sleep 2; done')
  expect(polite.context).toBeUndefined()
  expect(seen.reached).toHaveLength(2)
})

test('a loop without a readable host is warned about too, other commands are untouched', async ($, on) => {
  const { seen } = engine(on)

  expect((await bash($, 'while read url; do curl -s "$url"; done < urls.txt')).context?.[0]).toContain('fetches in a loop')
  expect((await bash($, 'cat urls.txt | xargs -n1 curl -s')).context?.[0]).toContain('fetches in a loop')
  expect((await bash($, 'ls -la')).context).toBeUndefined()
  expect((await bash($, 'git push origin main')).context).toBeUndefined()
  expect(seen.reached).toHaveLength(4)
})

test('which requests are read from a command line', () => {
  expect(externalHosts('curl -sSL -H "Accept: json" -o out.json https://api.github.com/user')).toEqual(['api.github.com'])
  expect(externalHosts('curl -sSLo out.json https://a.com/x')).toEqual(['a.com'])
  expect(externalHosts('curl -O https://cdn.example.com/f.zip')).toEqual(['cdn.example.com'])
  expect(externalHosts('curl api.example.com/v1 -d @body.json -X POST')).toEqual(['api.example.com'])
  expect(externalHosts('wget -O file.txt -q https://a.com/x https://b.com/y')).toEqual(['a.com', 'b.com'])
  expect(externalHosts('curl --url https://a.com/x --max-time 5')).toEqual(['a.com'])
  expect(externalHosts('http POST https://a.com/x name=foo')).toEqual(['a.com'])
  expect(externalHosts('https example.org/a')).toEqual(['example.org'])
  expect(externalHosts('http :3000/api')).toEqual([])
  expect(externalHosts('sudo -u app curl https://a.com | jq . && curl https://b.com')).toEqual(['a.com', 'b.com'])
  expect(externalHosts('curl https://user:pw@A.com:8443/x')).toEqual(['a.com'])
  expect(externalHosts('curl http://127.0.0.1:8080 http://10.0.0.5/x http://[::1]:3000')).toEqual([])
  expect(externalHosts('echo curl https://a.com; grep curl notes.txt')).toEqual([])
  expect(externalHosts('curl "https://$HOST/x"')).toEqual([])
  expect(hostOf('https://a.com\\@b.com/')).toBe('a.com')
  expect(isLocalHost('printer.local')).toBe(true)
  expect(isLocalHost('172.20.0.2')).toBe(true)
  expect(isLocalHost('172.32.0.2')).toBe(false)
})

test('loops: counted rounds, polite loops and look-alikes', () => {
  expect(loopOfFetches('for i in {1..50}; do curl https://a.com/$i; done')).toEqual({ iterations: 50 })
  expect(loopOfFetches('for f in a b c d; do wget https://a.com/$f; done')).toEqual({ iterations: 4 })
  expect(loopOfFetches('while true; do curl https://a.com/poll; done')).toEqual({ iterations: undefined })
  expect(loopOfFetches('while true; do curl https://a.com/poll; sleep 5; done')).toBeUndefined()
  expect(loopOfFetches('for i in 1 2 3; do echo $i; done')).toBeUndefined()
  expect(loopOfFetches('echo "for i in 1 2; do curl x; done"')).toBeUndefined()
  expect(loopOfFetches('bash -c "for i in 1 2; do curl https://a.com; done"')).toEqual({ iterations: 2 })
  expect(loopOfFetches('seq 1 9 | xargs -I{} curl https://a.com/{}')).toEqual({ iterations: undefined })
  expect(loopOfFetches('curl https://a.com/once')).toBeUndefined()
})

test('regression: requests behind bash -lc, eval and wrappers with options are counted', () => {
  expect(externalHosts('bash -lc "curl https://api.example.com/a"')).toEqual(['api.example.com'])
  expect(externalHosts("sh -ec 'cd /tmp && wget https://api.example.com/b'")).toEqual(['api.example.com'])
  expect(externalHosts(`eval 'curl https://api.example.com/c'`)).toEqual(['api.example.com'])
  expect(externalHosts('nice -n 5 curl https://api.example.com/d')).toEqual(['api.example.com'])
  expect(externalHosts('timeout -s KILL 30 curl https://api.example.com/e')).toEqual(['api.example.com'])
  expect(externalHosts('sudo -n curl https://api.example.com/f')).toEqual(['api.example.com'])
  expect(externalHosts('bash ./fetch.sh https://api.example.com/g')).toEqual([])
  // The shared shell reader: su -c, substitutions, heredocs fed to a shell, GNU time; a heredoc note is only text.
  expect(externalHosts(`su -c 'curl https://api.example.com/h' me`)).toEqual(['api.example.com'])
  expect(externalHosts('ID=$(curl -s https://api.example.com/i)')).toEqual(['api.example.com'])
  expect(externalHosts('bash <<EOF\nwget https://api.example.com/j\nEOF')).toEqual(['api.example.com'])
  expect(externalHosts('time -o t.txt curl https://api.example.com/k')).toEqual(['api.example.com'])
  expect(externalHosts("cat <<'EOF' > notes.md\ncurl https://api.example.com/l\nEOF")).toEqual([])
})

test('with mods-hub: a refusal is published as risk.blocked and the pause note goes through the hub', { options: { maxCalls: 1 } }, async ($, on) => {
  const { seen } = engine(on)
  const hub = fakeHub(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['risk.blocked'], consumes: [] }])
  expect((await bash($, 'curl https://api.example.com/1')).deny).toBeUndefined()
  expect((await bash($, 'curl https://api.example.com/2')).deny).toContain('the limit is 1')
  expect((await bash($, 'curl https://api.example.com/3')).deny).toContain('paused for 60 more s')
  expect(hub.published.map(event => event.data)).toEqual([
    { guard: 'rate-limit-guard', tool: 'Bash', reason: 'limit-reached: 1 requests to api.example.com in the last 60 s, limit 1', severity: 'low', command: 'curl https://api.example.com/2' },
    { guard: 'rate-limit-guard', tool: 'Bash', reason: 'paused: requests to api.example.com are paused for 60 more s', severity: 'low', command: 'curl https://api.example.com/3' },
  ])
  expect(hub.notified).toEqual([{ level: 'warning', title: 'paused requests to api.example.com for 60 s (1 in the last 60 s)', topic: 'risk.blocked' }])
  expect(seen.toasts).toEqual([])
})

test('regression: a fetch loop inside bash -lc is warned about', () => {
  expect(loopOfFetches(`bash -lc 'for i in $(seq 1 50); do curl https://api.example.com/items/$i; done'`)).toEqual({ iterations: 50 })
  expect(loopOfFetches(`git commit -m 'for each item do curl'`)).toBeUndefined()
})
