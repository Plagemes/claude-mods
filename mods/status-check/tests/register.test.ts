import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseExtra, readIncidents, readStatus, suspectedServices } from '../hooks/status'

const NOW = Date.parse('2026-10-07T12:00:00Z')

const page = (indicator: string, description: string) => ({ status: 200, text: JSON.stringify({ page: { name: 'x' }, status: { indicator, description } }) })
const incidents = (...items: { name: string; impact: string; shortlink: string }[]) => ({ status: 200, text: JSON.stringify({ incidents: items }) })

type Answers = Record<string, { status: number; text: string } | 'hang' | 'fail'>

/** The internet beneath the plugin: status pages by URL, a clock, and what was asked. */
const internet = (on: On, answers: Answers) => {
  const clock = mock.clock(on, { now: NOW })
  const seen = { fetched: [] as string[], toasts: [] as string[], registered: [] as string[], bash: { fails: false, text: '' } }
  on('http.fetch', async (_$, e) => {
    seen.fetched.push(e.url)
    const answer = answers[e.url]
    if (answer === 'hang') return new Promise<never>(() => undefined)
    if (answer === 'fail') return { deny: 'connect ECONNREFUSED 10.0.0.1:443' }
    const { status, text } = answer ?? { status: 404, text: 'not found' }
    return { value: { status, ok: status >= 200 && status < 300, headers: {}, text } }
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
  on('tool.call', () => (seen.bash.fails ? { isError: true as const, result: seen.bash.text, text: seen.bash.text } : { result: 'ok' }))
  return { clock, seen }
}

const run = ($: Engine, args = '') => $.command.run({ command: 'service-status', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
const settle = async <T>(clock: MockClock, work: Promise<T>, ms: number): Promise<T> => {
  await clock.advance(ms)
  return work
}
const github = 'https://www.githubstatus.com/api/v2'
const npm = 'https://status.npmjs.org/api/v2'
const pypi = 'https://status.python.org/api/v2'
const claude = 'https://status.claude.com/api/v2'

test('/service-status lists every service with its indicator, and the open incidents of those with problems', async ($, on) => {
  const { seen } = internet(on, {
    [`${github}/status.json`]: page('major', 'Partial System Outage'),
    [`${github}/incidents/unresolved.json`]: incidents({ name: 'Incident with Git Operations and Actions', impact: 'critical', shortlink: 'https://stspg.io/abc' }),
    [`${npm}/status.json`]: page('none', 'All Systems Operational'),
    [`${pypi}/status.json`]: page('none', 'All Systems Operational'),
    [`${claude}/status.json`]: page('minor', 'Minor Service Outage'),
    [`${claude}/incidents/unresolved.json`]: incidents({ name: 'Elevated errors on platform.claude.com', impact: 'major', shortlink: 'https://stspg.io/xyz' }),
  })

  const { text } = await run($)

  expect(text).toBe(
    [
      'Service status at 12:00:00 UTC',
      '✖ GitHub         Partial System Outage',
      '    Incident with Git Operations and Actions (critical) https://stspg.io/abc',
      '✓ npm            All Systems Operational',
      '✓ PyPI           All Systems Operational',
      '⚠ Anthropic API  Minor Service Outage',
      '    Elevated errors on platform.claude.com (major) https://stspg.io/xyz',
      '',
      'At least one service reports an incident: a failure involving it is probably not your code.',
    ].join('\n'),
  )
  expect(seen.fetched).toHaveLength(6)
})

test('everything operational says so', async ($, on) => {
  internet(on, { [`${github}/status.json`]: page('none', 'All Systems Operational'), [`${npm}/status.json`]: page('none', 'All Systems Operational'), [`${pypi}/status.json`]: page('none', 'All Systems Operational'), [`${claude}/status.json`]: page('none', 'All Systems Operational') })

  expect((await run($)).text).toContain('No incident reported: if something fails, look at your code or your network.')
})

test('a page that hangs, errors or is not Statuspage is reported as unreachable without spoiling the rest', async ($, on) => {
  const { clock } = internet(on, {
    [`${github}/status.json`]: 'hang',
    [`${npm}/status.json`]: { status: 500, text: 'oops' },
    [`${pypi}/status.json`]: { status: 200, text: '<html>hi</html>' },
    [`${claude}/status.json`]: page('none', 'All Systems Operational'),
  })

  const { text } = await settle(clock, run($), 5_000)

  expect(text).toContain('? GitHub         could not be checked (no answer within 5 s)')
  expect(text).toContain('? npm            could not be checked (HTTP 500)')
  expect(text).toContain('? PyPI           could not be checked (not a Statuspage answer)')
  expect(text).toContain('✓ Anthropic API  All Systems Operational')
  expect(text).toContain('No incident reported by the services that answered.')
})

test('a request that fails outright and a custom timeout are reported plainly', { options: { timeoutSec: 2 } }, async ($, on) => {
  const { clock } = internet(on, { [`${github}/status.json`]: 'fail', [`${npm}/status.json`]: 'hang', [`${pypi}/status.json`]: page('none', 'ok'), [`${claude}/status.json`]: page('none', 'ok') })

  const { text } = await settle(clock, run($), 2_000)

  expect(text).toContain('? GitHub         could not be checked (connect ECONNREFUSED 10.0.0.1:443)')
  expect(text).toContain('? npm            could not be checked (no answer within 2 s)')
})

test('extra services are checked too, and an argument picks services by name', { options: { extra: 'Vercel=https://www.vercel-status.com/, https://status.example.org/some/page' } }, async ($, on) => {
  const { seen } = internet(on, {
    'https://www.vercel-status.com/api/v2/status.json': page('none', 'All Systems Operational'),
    'https://status.example.org/api/v2/status.json': page('minor', 'Degraded'),
    'https://status.example.org/api/v2/incidents/unresolved.json': incidents(),
  })

  const picked = await run($, 'vercel')
  expect(picked.text).toContain('✓ Vercel  All Systems Operational')
  expect(seen.fetched).toEqual(['https://www.vercel-status.com/api/v2/status.json'])

  const other = await run($, 'example')
  expect(other.text).toContain('⚠ example.org  Degraded')

  expect((await run($, 'nonsense')).text).toBe('No service called "nonsense". Known: GitHub, npm, PyPI, Anthropic API, Vercel, example.org.')
})

test('a failing npm install with a timeout checks npm, and an incident there reaches Claude and the user', async ($, on) => {
  const { seen } = internet(on, {
    [`${npm}/status.json`]: page('major', 'Partial System Outage'),
    [`${npm}/incidents/unresolved.json`]: incidents({ name: 'Elevated errors on the registry', impact: 'major', shortlink: 'https://stspg.io/n1' }),
  })
  seen.bash.fails = true
  seen.bash.text = 'npm ERR! code ETIMEDOUT\nnpm ERR! network request to https://registry.npmjs.org/left-pad failed'

  const result = await $.tool.call({ tool: 'Bash', command: 'npm install left-pad' })

  expect(result.isError).toBe(true)
  expect(result.context?.[0]).toContain('status-check: npm reports "Partial System Outage" right now (https://status.npmjs.org), so the failure above is probably not your code.')
  expect(result.context?.[0]).toContain('Open incidents: Elevated errors on the registry (major) https://stspg.io/n1.')
  expect(seen.toasts).toEqual(['npm reports an incident ("Partial System Outage"): the failed command is probably not your code'])
})

test('no incident, no note; a run of failures asks the status page once a minute', async ($, on) => {
  const { clock, seen } = internet(on, { [`${npm}/status.json`]: page('none', 'All Systems Operational') })
  seen.bash.fails = true
  seen.bash.text = 'npm ERR! 503 Service Unavailable - GET https://registry.npmjs.org/x'

  expect((await $.tool.call({ tool: 'Bash', command: 'npm i x' })).context).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'npm i y' })).context).toBeUndefined()
  expect(seen.fetched).toHaveLength(1)

  await clock.advance(61_000)
  await $.tool.call({ tool: 'Bash', command: 'npm i z' })
  expect(seen.fetched).toHaveLength(2)
})

test('GitHub, PyPI and the Anthropic API are matched from the command and the output', async ($, on) => {
  const { seen } = internet(on, {
    [`${github}/status.json`]: page('minor', 'Degraded Performance'),
    [`${github}/incidents/unresolved.json`]: incidents(),
    [`${pypi}/status.json`]: page('minor', 'Degraded'),
    [`${pypi}/incidents/unresolved.json`]: incidents(),
    [`${claude}/status.json`]: page('critical', 'Major Outage'),
    [`${claude}/incidents/unresolved.json`]: incidents(),
  })
  seen.bash.fails = true

  seen.bash.text = "fatal: unable to access 'https://github.com/a/b.git/': The requested URL returned error: 503"
  expect((await $.tool.call({ tool: 'Bash', command: 'git push' })).context?.[0]).toContain('GitHub reports "Degraded Performance"')

  seen.bash.text = 'WARNING: Retrying (Retry(total=4)) after connection broken by ConnectTimeoutError: pypi.org'
  expect((await $.tool.call({ tool: 'Bash', command: 'pip install flask' })).context?.[0]).toContain('PyPI reports "Degraded"')

  seen.bash.text = 'curl: (28) Connection timed out after 10001 milliseconds'
  expect((await $.tool.call({ tool: 'Bash', command: 'curl https://api.anthropic.com/v1/messages' })).context?.[0]).toContain('Anthropic API reports "Major Outage"')
})

test('only failures that look like the network, of a command that involves a service, are checked', async ($, on) => {
  const { seen } = internet(on, { [`${npm}/status.json`]: page('major', 'Outage'), [`${github}/status.json`]: page('major', 'Outage') })

  seen.bash.fails = true
  seen.bash.text = "TypeError: Cannot read properties of undefined (reading 'x')"
  expect((await $.tool.call({ tool: 'Bash', command: 'npm test' })).context).toBeUndefined()

  seen.bash.text = 'curl: (28) Connection timed out'
  expect((await $.tool.call({ tool: 'Bash', command: 'curl https://example.com' })).context).toBeUndefined()

  seen.bash.fails = false
  expect((await $.tool.call({ tool: 'Bash', command: 'npm install' })).context).toBeUndefined()
  expect(seen.fetched).toHaveLength(0)
})

test('a status page that does not answer in time does not hold the failed command back for long', async ($, on) => {
  const { clock, seen } = internet(on, { [`${npm}/status.json`]: 'hang' })
  seen.bash.fails = true
  seen.bash.text = 'npm ERR! code ETIMEDOUT'

  const result = await settle(clock, $.tool.call({ tool: 'Bash', command: 'npm install' }), 3_000)

  expect(result.isError).toBe(true)
  expect(result.context).toBeUndefined()
})

test('the check after failures can be switched off', { options: { autoCheck: false } }, async ($, on) => {
  const { seen } = internet(on, { [`${npm}/status.json`]: page('major', 'Outage') })
  seen.bash.fails = true
  seen.bash.text = 'npm ERR! code ETIMEDOUT'

  expect((await $.tool.call({ tool: 'Bash', command: 'npm install' })).context).toBeUndefined()
  expect(seen.fetched).toHaveLength(0)
})

test('registers /service-status because /status is built in', async ($, on) => {
  const { seen } = internet(on, {})
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(seen.registered).toEqual(['service-status'])
})

test('Statuspage answers, extra entries and failure texts are read', () => {
  expect(readStatus('{"status":{"indicator":"minor","description":"Degraded"}}')).toEqual({ indicator: 'minor', description: 'Degraded' })
  expect(readStatus('{"nope":1}')).toBeUndefined()
  expect(readStatus('<html>')).toBeUndefined()
  expect(readIncidents('{"incidents":[{"name":"A","impact":"minor","shortlink":"https://s/1"},{"x":1}]}')).toEqual([{ name: 'A', impact: 'minor', link: 'https://s/1' }])
  expect(readIncidents('nope')).toEqual([])
  expect(parseExtra('Acme = https://status.acme.io/ , ftp://x.org, https://www.other.dev/page, , Bad=nope')).toEqual([
    { id: 'acme', name: 'Acme', url: 'https://status.acme.io' },
    { id: 'other.dev', name: 'other.dev', url: 'https://www.other.dev' },
  ])
  expect(suspectedServices('npm install', 'npm ERR! code ETIMEDOUT')).toEqual(['npm'])
  expect(suspectedServices('git clone https://github.com/a/b', 'fatal: unable to access: Could not resolve host: github.com')).toEqual(['github'])
  expect(suspectedServices('uv pip install x', 'error: HTTP status server error (502 Bad Gateway) for url (https://pypi.org/simple/x/)')).toEqual(['pypi'])
  expect(suspectedServices('npm install', 'added 3 packages')).toEqual([])
  expect(suspectedServices('make', 'Service Unavailable')).toEqual([])
})
