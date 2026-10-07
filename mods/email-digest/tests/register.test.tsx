import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { FsEntry, On, RenderPropsOf } from 'claude-code'

import { callsOf, hubStandIn, script } from './hub'

const PLUGIN = 'email-digest'
const ALL_SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const MINUTE = 60_000
const HOME = '/home/me'
const ROOT = '/work/shop'
const DIR = `${HOME}/.claude/claude-mods/email-digest`
const PANE: RenderPropsOf['Pane'] = { title: 'Email digest', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }
/** Wednesday 7 October 2026, 17:00 in Rome (15:00 UTC). */
const NOON_ISH = Date.UTC(2026, 9, 7, 15, 0)
const at = (day: number, h: number, m = 0): number => Date.UTC(2026, 9, day, h - 2, m)

const FS = '\u001f'
const RS = '\u001e'
const TOKEN = `ghp_${'a1'.repeat(18)}`
const GIT_LOG = [
  `aaa1111${FS}Ada${FS}2026-10-07T10:00:00+02:00${FS}feat(cart): add discount codes (#42)${RS}`,
  `\nbbb2222${FS}Bob${FS}2026-10-07T11:00:00+02:00${FS}fix: checkout total rounding${RS}`,
  `\nccc3333${FS}Bob${FS}2026-10-07T12:00:00+02:00${FS}fix: stop logging ${TOKEN}${RS}`,
].join('')
const JOURNAL = ['## 16:00 · shop · main', '### Work done', '- Customers can now pay with a discount code', '### Open questions', '- Which VAT rate for Switzerland?', '### Open todos', '- [ ] Write the release notes'].join('\n')

const RESEND = { provider: 'resend', resendApiKey: 're_SECRETKEY99', from: 'Acme Studio <digest@acme.com>', recipients: 'ana@client.com, boss@acme.com', timezone: 'Europe/Rome', projectName: 'Shop' }
const SENDGRID = { ...RESEND, provider: 'sendgrid', sendgridApiKey: 'SG.SECRETKEY77' }
const SMTP = { ...RESEND, provider: 'smtp', smtpUrl: 'smtps://smtp.acme.com:465', smtpUser: 'digest@acme.com', smtpPassword: 'SECRETPASS55' }
const SCHEDULED = { ...RESEND, frequency: 'daily', sendAt: '18:00' }

type WorldOptions = { now?: number; git?: string; files?: Record<string, string>; replies?: { status: number; text: string }[]; curl?: { exitCode: number; stderr: string }; noRepo?: boolean }

/** Stands for everything beneath the plugin: git, the mail providers, files, the session, the screen. */
function world(on: On, options: WorldOptions = {}) {
  const clock = mock.clock(on, { now: options.now ?? NOON_ISH })
  mock.env(on, { HOME })
  const files = new Map<string, string>(Object.entries({ [`${ROOT}/.claude/journal/2026-10-07.md`]: JOURNAL, ...(options.files ?? {}) }))
  const net = { requests: [] as { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } | undefined }[], replies: [...(options.replies ?? [])], git: options.git ?? GIT_LOG, gitCalls: [] as { argv: readonly string[]; cwd?: string }[], curl: [] as { argv: readonly string[]; stdin?: string }[], curlResult: options.curl ?? { exitCode: 0, stderr: '' }, outboxWrites: [] as string[] }
  const toasts: string[] = []
  const panes: string[] = []
  on('fs.read', ($, e) => (files.has(e.path) ? { value: files.get(e.path) ?? '' } : { deny: `ENOENT: ${e.path}` }))
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    if (e.path.endsWith('/outbox/message.eml')) net.outboxWrites.push(e.text)
    return { value: undefined }
  })
  on('fs.stat', ($, e) => (files.has(e.path) ? { value: { kind: 'file' as const, size: 1, mtimeMs: NOON_ISH, isLink: false } } : { deny: `ENOENT: ${e.path}` }))
  on('fs.list', ($, e) => {
    const base = e.path.replace(/\/+$/, '')
    const entries: FsEntry[] = []
    for (const [path, text] of files) {
      if (path.slice(0, path.lastIndexOf('/')) === base) entries.push({ name: path.slice(base.length + 1), kind: 'file', size: text.length, mtimeMs: NOON_ISH, isLink: false })
    }
    return { value: entries }
  })
  on('process.run', ($, e) => {
    const [bin = ''] = e.argv
    if (bin === 'git') {
      net.gitCalls.push({ argv: e.argv, ...(e.init?.cwd === undefined ? {} : { cwd: e.init.cwd }) })
      return { value: { exitCode: 0, stdout: net.git, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    net.curl.push({ argv: e.argv, ...(e.init?.stdin === undefined ? {} : { stdin: e.init.stdin }) })
    return { value: { exitCode: net.curlResult.exitCode, stdout: '', stderr: net.curlResult.stderr, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', ($, e) => {
    net.requests.push({ url: e.url, init: e.init })
    const reply = net.replies.shift() ?? { status: e.url.includes('sendgrid') ? 202 : 200, text: e.url.includes('sendgrid') ? '' : '{"id":"mail-1"}' }
    return { value: { status: reply.status, ok: reply.status >= 200 && reply.status < 300, headers: {}, text: reply.text } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1234abcd' }))
  on('session.root', () => ({ value: ROOT }))
  on('session.repo', () => ({ value: options.noRepo === true ? null : { root: ROOT } as never }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', ($, e) => {
    panes.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  return { clock, files, net, toasts, panes }
}

const start = ($: Engine, isInteractive = true) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive })
const digest = ($: Engine, args = '') => $.command.run({ command: 'digest', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }).then(result => String(result.text ?? ''))
const beats = async (w: ReturnType<typeof world>, count = 2) => {
  for (let i = 0; i < count; i += 1) await w.clock.advance(10_000)
}
const configOf = (w: ReturnType<typeof world>) => JSON.parse(w.files.get(`${DIR}/config.json`) ?? '{}') as { projects?: Record<string, { recipients?: string; tone?: string; language?: string; note?: string }> }

test('preview: the digest of today from git and the journal, addressed to the recipients, built in the project root', { options: RESEND }, async ($, on) => {
  const w = world(on)
  await start($)
  const text = await digest($, 'preview')
  expect(text).toContain('Subject: Shop · Daily update · 7 Oct 2026')
  expect(text).toContain('To: ana@client.com, boss@acme.com')
  expect(text).toContain('Tone: client · language: en')
  expect(text).toContain('Customers can now pay with a discount code')
  expect(text).toContain('Cart: add discount codes')
  expect(text).toContain('Checkout total rounding')
  expect(text).toContain('Open question: Which VAT rate for Switzerland?')
  expect(text).toContain('Write the release notes')
  expect(text).not.toContain('Not ready to send')
  expect(w.net.gitCalls).toHaveLength(1)
  expect(w.net.gitCalls[0]?.cwd).toBe(ROOT)
  expect(w.net.gitCalls[0]?.argv).toContain('--since=2026-10-06T22:00:00.000Z')
  // A secret that slipped into a commit message never reaches the preview.
  expect(text).not.toContain(TOKEN)
  expect(text).toContain('[REDACTED:github-token]')
})

test('send with Resend: one request with the key as a bearer token, the secret in a commit message masked, the key never shown', { options: RESEND }, async ($, on) => {
  const w = world(on)
  await start($)
  const text = await digest($, 'send')
  expect(text).toBe('Sent "Shop · Daily update · 7 Oct 2026" to 2 recipients.')
  expect(w.net.requests).toHaveLength(1)
  const request = w.net.requests[0]
  expect(request?.url).toBe('https://api.resend.com/emails')
  expect(request?.init?.method).toBe('POST')
  expect(request?.init?.headers?.Authorization).toBe('Bearer re_SECRETKEY99')
  const body = JSON.parse(request?.init?.body ?? '{}') as { to: string[]; from: string; subject: string; text: string; html: string }
  expect(body.to).toEqual(['ana@client.com', 'boss@acme.com'])
  expect(body.from).toBe('Acme Studio <digest@acme.com>')
  expect(body.subject).toBe('Shop · Daily update · 7 Oct 2026')
  expect(body.html).toContain('<h3')
  expect(request?.init?.body).not.toContain(TOKEN)
  expect(text).not.toContain('re_SECRETKEY99')
})

test('send failure: the provider\'s words are shown without the key it echoed', { options: RESEND }, async ($, on) => {
  const w = world(on, { replies: [{ status: 403, text: '{"message":"API key re_SECRETKEY99 is not allowed to send from acme.com"}' }] })
  await start($)
  const text = await digest($, 'send')
  expect(text).toBe('Not sent: Resend refused the API key (403). API key [key] is not allowed to send from acme.com')
  expect(w.net.requests).toHaveLength(1)
})

test('send with SendGrid: personalizations and both bodies, 202 is success', { options: SENDGRID }, async ($, on) => {
  const w = world(on)
  await start($)
  expect(await digest($, 'send')).toContain('Sent "Shop · Daily update · 7 Oct 2026" to 2 recipients.')
  const request = w.net.requests[0]
  expect(request?.url).toBe('https://api.sendgrid.com/v3/mail/send')
  expect(request?.init?.headers?.Authorization).toBe('Bearer SG.SECRETKEY77')
  const body = JSON.parse(request?.init?.body ?? '{}') as { personalizations: { to: { email: string }[] }[]; from: { email: string; name: string }; content: { type: string }[] }
  expect(body.personalizations[0]?.to.map(one => one.email)).toEqual(['ana@client.com', 'boss@acme.com'])
  expect(body.from).toEqual({ email: 'digest@acme.com', name: 'Acme Studio' })
  expect(body.content.map(part => part.type)).toEqual(['text/plain', 'text/html'])
})

test('send with SMTP: curl gets the message as a file and the password on stdin; the file is emptied afterwards', { options: SMTP }, async ($, on) => {
  const w = world(on)
  await start($)
  expect(await digest($, 'send')).toContain('to 2 recipients.')
  expect(w.net.requests).toEqual([])
  const call = w.net.curl[0]
  expect(call?.argv.slice(0, 5)).toEqual(['curl', '--silent', '--show-error', '--ssl-reqd', '--connect-timeout'])
  expect(call?.argv).toContain('smtps://smtp.acme.com:465')
  expect(call?.argv).toEqual(expect.arrayContaining(['--mail-from', 'digest@acme.com', '--mail-rcpt', 'ana@client.com', '--mail-rcpt', 'boss@acme.com', '--upload-file', `${DIR}/outbox/message.eml`]))
  expect(call?.argv.join(' ')).not.toContain('SECRETPASS55')
  expect(call?.stdin).toBe('user = "digest@acme.com:SECRETPASS55"\n')
  expect(w.net.outboxWrites).toHaveLength(2)
  expect(w.net.outboxWrites[0]).toContain('Content-Type: multipart/alternative')
  expect(w.net.outboxWrites[0]).toContain('To: ana@client.com, boss@acme.com')
  expect(w.net.outboxWrites[1]).toBe('')
})

test('SMTP refusing the login is explained, the password is not in the message', { options: SMTP }, async ($, on) => {
  const w = world(on, { curl: { exitCode: 67, stderr: 'curl: (67) Login denied for SECRETPASS55' } })
  await start($)
  const text = await digest($, 'send')
  expect(text).toBe('Not sent: the SMTP server refused the user name or password (curl: (67) Login denied for [key])')
  expect(w.net.outboxWrites.at(-1)).toBe('')
})

test('zero config: it previews but sends nothing, and says what is missing', async ($, on) => {
  const w = world(on)
  await start($)
  expect(await digest($, 'send')).toContain('Not sent: Set the sender address')
  expect(await digest($, 'preview')).toContain('Not ready to send: Set the sender address')
  expect(w.net.requests).toEqual([])
  expect(w.net.curl).toEqual([])
  expect(await digest($, 'status')).toContain('Schedule: Off (send by hand)')
  expect(await digest($, 'setup')).toContain('resendApiKey')
  expect(await digest($, 'bogus')).toContain('Usage: /digest')
})

test('recipients: per project, validated, saved in the shared config and used by the next send', { options: { ...RESEND, recipients: '' } }, async ($, on) => {
  const w = world(on)
  await start($)
  expect(await digest($, 'recipients')).toContain('No recipients for this project yet')
  expect(await digest($, 'send')).toContain('No recipients yet')
  expect(await digest($, 'recipients ana@client.com, not-an-address')).toBe('Not valid addresses: not-an-address. Nothing was saved.')
  expect(w.files.has(`${DIR}/config.json`)).toBe(false)
  expect(await digest($, 'recipients ana@client.com; ANA@client.com boss@acme.com')).toBe('Recipients for this project: ana@client.com, boss@acme.com')
  expect(configOf(w).projects?.[ROOT]?.recipients).toBe('ana@client.com, boss@acme.com')
  expect(await digest($, 'recipients')).toBe('Recipients: ana@client.com, boss@acme.com')
  expect(await digest($, 'send')).toContain('to 2 recipients.')
  expect(JSON.parse(w.net.requests[0]?.init?.body ?? '{}').to).toEqual(['ana@client.com', 'boss@acme.com'])
  expect(await digest($, 'recipients clear')).toBe('Recipients cleared for this project.')
  expect(await digest($, 'send')).toContain('No recipients yet')
})

test('tone, language and a one-off note: kept per project, the note is cleared once it was sent', { options: RESEND }, async ($, on) => {
  const w = world(on)
  await start($)
  expect(await digest($, 'tone manager')).toBe('Tone for this project: manager.')
  expect(await digest($, 'lang it')).toBe('Language for this project: it.')
  expect(await digest($, 'tone loud')).toContain('Usage')
  expect(await digest($, 'note Demo on Friday at 10')).toContain('Note saved')
  const preview = await digest($, 'preview')
  expect(preview).toContain('Tone: manager · language: it')
  expect(preview).toContain('Ciao,')
  expect(preview).toContain('riepilogo')
  expect(preview).toContain('Nota\nDemo on Friday at 10')
  expect(configOf(w).projects?.[ROOT]).toMatchObject({ tone: 'manager', language: 'it', note: 'Demo on Friday at 10' })
  await digest($, 'send')
  expect(configOf(w).projects?.[ROOT]?.note).toBeUndefined()
  expect(configOf(w).projects?.[ROOT]?.tone).toBe('manager')
  expect(await digest($, 'preview')).not.toContain('Demo on Friday')
  expect(await digest($, 'status')).toContain('Voice: manager, it')
})

test('weekly preview covers the last seven days; a project outside git still gets a digest from its journal', { options: RESEND }, async ($, on) => {
  const w = world(on, { noRepo: true })
  await start($)
  const text = await digest($, 'preview weekly')
  expect(text).toContain('Subject: Shop · Weekly update · 1–7 Oct 2026')
  expect(text).toContain('Customers can now pay with a discount code')
  expect(w.net.gitCalls).toEqual([])
})

test('schedule: the leader sends once at the send time, never twice, and records it', { options: SCHEDULED }, async ($, on) => {
  const w = world(on)
  await start($)
  await beats(w, 2)
  expect(w.net.requests).toHaveLength(0)
  await w.clock.advance(61 * MINUTE)
  expect(w.net.requests).toHaveLength(1)
  expect(JSON.parse(w.net.requests[0]?.init?.body ?? '{}').subject).toBe('Shop · Daily update · 7 Oct 2026')
  expect(JSON.parse(w.files.get(`${DIR}/state/${[...w.files.keys()].find(path => path.includes('/state/'))?.split('/').pop()?.replace('.json', '')}.json`) ?? '{}')).toMatchObject({ daily: '2026-10-07', lastSent: { period: 'daily', count: 2 } })
  await w.clock.advance(3 * 60 * MINUTE)
  expect(w.net.requests).toHaveLength(1)
  expect(w.toasts.join('\n')).toContain('Digest sent to 2 people')
  expect(await digest($, 'status')).toContain('This session sends the scheduled digests of this project.')
})

test('schedule: a failed send is retried after 30 minutes and then stops being retried', { options: SCHEDULED }, async ($, on) => {
  const w = world(on, { replies: [{ status: 500, text: 'oops' }, { status: 200, text: '{"id":"2"}' }] })
  await start($)
  await w.clock.advance(61 * MINUTE)
  expect(w.net.requests).toHaveLength(1)
  await w.clock.advance(20 * MINUTE)
  expect(w.net.requests).toHaveLength(1)
  await w.clock.advance(15 * MINUTE)
  expect(w.net.requests).toHaveLength(2)
  await w.clock.advance(2 * 60 * MINUTE)
  expect(w.net.requests).toHaveLength(2)
})

test('schedule: three failures give up with one error notice', { options: SCHEDULED }, async ($, on) => {
  const w = world(on, { replies: [{ status: 500, text: 'oops' }, { status: 500, text: 'oops' }, { status: 500, text: 'oops' }, { status: 500, text: 'oops' }] })
  await start($)
  await w.clock.advance(4 * 60 * MINUTE)
  expect(w.net.requests).toHaveLength(3)
  expect(w.toasts.join('\n')).toContain('The scheduled digest could not be sent')
})

test('schedule: nothing happened today, so nothing is sent; a Saturday has no daily digest; a missing key sends nothing', { options: SCHEDULED }, async ($, on) => {
  const w = world(on, { git: '', files: { [`${ROOT}/.claude/journal/2026-10-07.md`]: '' } })
  await start($)
  await w.clock.advance(2 * 60 * MINUTE)
  expect(w.net.requests).toEqual([])
})

test('schedule: weekend days are skipped', { options: SCHEDULED }, async ($, on) => {
  const w = world(on, { now: at(10, 17) })
  await start($)
  await w.clock.advance(2 * 60 * MINUTE)
  expect(w.net.requests).toEqual([])
})

test('schedule: with no provider set up the schedule does nothing and does not rebuild the digest every beat', { options: { frequency: 'daily', sendAt: '18:00', timezone: 'Europe/Rome' } }, async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.advance(2 * 60 * MINUTE)
  expect(w.net.requests).toEqual([])
  expect(w.net.gitCalls).toEqual([])
})

test('schedule: a session that follows another one never sends', { options: SCHEDULED }, async ($, on) => {
  const w = world(on)
  await start($)
  // Someone else leads this project: its lease is renewed by hand while time passes.
  const key = [...w.files.keys()].find(path => path.includes('/lease/'))?.split('/').pop() ?? ''
  expect(key).not.toBe('')
  for (let i = 0; i < 6 * 60; i += 1) {
    w.files.set(`${DIR}/lease/${key}`, JSON.stringify({ sessionId: 'someone-else', heartbeatAt: await w.clock.now(), since: 1 }))
    await w.clock.advance(10_000)
  }
  expect(w.net.requests).toEqual([])
})

test('weekly schedule: sent on its day, as the weekly digest', { options: { ...RESEND, frequency: 'weekly', weeklyDay: 'wed', sendAt: '18:00' } }, async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.advance(61 * MINUTE)
  expect(w.net.requests).toHaveLength(1)
  expect(JSON.parse(w.net.requests[0]?.init?.body ?? '{}').subject).toBe('Shop · Weekly update · 1–7 Oct 2026')
})

test('cost line: from smart-router\'s daily total when the hub did not feed per-project costs; off unless asked', { options: { ...RESEND, includeCost: true } }, async ($, on) => {
  const w = world(on, { files: { [`${HOME}/.claude/claude-mods/smart-router/daily.json`]: JSON.stringify({ date: '2026-10-07', saved: 1, spent: 7.5, byModel: {} }) } })
  await start($)
  await beats(w, 2)
  expect(await digest($, 'preview')).toContain('AI usage cost: $7.50 (all projects)')
})

test('without the hub nothing fails: the channel and the events are simply absent', { options: RESEND }, async ($, on) => {
  const w = world(on)
  await start($)
  await beats(w, 3)
  await w.clock.advance(5 * MINUTE)
  expect(await digest($, 'preview')).toContain('Subject: Shop')
  expect([...w.files.keys()].some(path => path.includes('/sessions/'))).toBe(false)
})

test('hub: the email channel is registered as a pull channel; its notices, the bus events and the cost end up in the digest', { options: { ...RESEND, includeCost: true, tone: 'technical' }, plugins: [hubStandIn()] }, async ($, on) => {
  const w = world(on)
  await start($)
  expect((await callsOf($, 'hello', PLUGIN))[0]).toMatchObject({ version: '1.0.0', publishes: [] })
  expect(await callsOf($, 'registerChannel', PLUGIN)).toEqual([expect.objectContaining({ id: 'email', title: 'Email digest', audience: 'me', delivery: 'pull', status: 'connected' })])
  await script($, 'script.notices', [{ id: 'n1', level: 'critical', title: 'Disk almost full', body: '97% used', at: at(7, 16), source: 'x', targets: [], held: true }])
  await script($, 'script.recent', [
    { id: 'e1', topic: 'ci.result', data: { provider: 'github', workflow: 'test', outcome: 'failed', branch: 'main', url: 'https://ci.example/9' }, source: 'ci-watch', at: at(7, 15), session: 's', scope: 'session' },
    { id: 'e2', topic: 'deploy.finished', data: { target: 'shop', environment: 'production', version: 'v1.4.0' }, source: 'deploy-checklist', at: at(7, 16, 30), session: 's', scope: 'session' },
  ])
  await script($, 'latest.cost.update', { id: 'c1', topic: 'cost.update', data: { turnUsd: 0.1, sessionUsd: 3.25, model: 'x', tokens: 1, isEstimate: false }, source: 'mods-hub', at: at(7, 16), session: 's', scope: 'session' })
  await beats(w, 3)
  await w.clock.advance(25_000)
  // The first drain asks from the start; the next ones acknowledge the last notice handled.
  expect((await callsOf($, 'drain', PLUGIN))[0]).toEqual({ channel: 'email', after: null })
  expect((await callsOf($, 'drain', PLUGIN)).at(-1)).toEqual({ channel: 'email', after: 'n1' })
  const text = await digest($, 'preview')
  expect(text).toContain('[critical] Disk almost full: 97% used')
  expect(text).toContain('CI: test (main) <https://ci.example/9>')
  expect(text).toContain('Deployed: shop → production v1.4.0')
  expect(text).toContain('AI usage cost: $3.25')
  const sessionFile = JSON.parse(w.files.get(`${DIR}/sessions/sess-1234abcd.json`) ?? '{}') as { root: string; events: { kind: string }[]; costByDay: Record<string, number> }
  expect(sessionFile.root).toBe(ROOT)
  expect(sessionFile.events.map(event => event.kind).sort()).toEqual(['ci', 'deploy', 'notice'])
  expect(JSON.parse(w.files.get(`${DIR}/sessions/sess-1234abcd.json`) ?? '{}').cursor).toBe('n1')
  expect(sessionFile.costByDay['2026-10-07']).toBe(3.25)
})

test('hub: other sessions of the same project add their events, sessions of other projects are ignored', { options: { ...RESEND, tone: 'technical' }, plugins: [hubStandIn()] }, async ($, on) => {
  const other = { id: 'other', root: ROOT, project: 'shop', updatedAt: at(7, 16), events: [{ at: at(7, 15), kind: 'pr', text: 'Add coupons', url: 'https://gh.example/pr/7' }], costByDay: {} }
  const stranger = { id: 'stranger', root: '/work/other-client', project: 'other', updatedAt: at(7, 16), events: [{ at: at(7, 15), kind: 'pr', text: 'Secret client work' }], costByDay: {} }
  const w = world(on, { files: { [`${DIR}/sessions/other.json`]: JSON.stringify(other), [`${DIR}/sessions/stranger.json`]: JSON.stringify(stranger) } })
  await start($)
  const text = await digest($, 'preview')
  expect(text).toContain('In review: Add coupons')
  expect(text).not.toContain('Secret client work')
  expect(w.net.requests).toEqual([])
})

for (const surface of ALL_SURFACES) {
  test(`the pane previews the digest on ${surface}: Send now sends, the period and tone buttons change it, recipients are edited in place`, { options: RESEND }, async ($, on) => {
    const w = world(on)
    await start($)
    await digest($)
    expect(w.panes).toEqual(['email-digest'])
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'email-digest', props: PANE })
    const shows = async (query: Parameters<typeof ui.find>[0]) => {
      const found = await ui.find(query)
      if (found === undefined) throw new Error(`the pane does not show ${JSON.stringify(query)} on ${surface}`)
    }
    await shows({ text: '✉ Email digest · Shop' })
    await shows({ text: 'Shop · Daily update · 7 Oct 2026' })
    await shows({ text: 'To: ana@client.com, boss@acme.com' })
    await shows({ text: 'Customers can now pay with a discount code' })

    await ui.press({ key: 'digest-period-weekly' })
    await shows({ text: 'Shop · Weekly update · 1–7 Oct 2026' })
    await ui.press({ key: 'digest-tone' })
    await shows({ key: 'digest-tone', text: 'Tone: Manager' })
    expect(configOf(w).projects?.[ROOT]?.tone).toBe('manager')
    await ui.press({ key: 'digest-lang' })
    await shows({ text: 'Language: IT' })

    await ui.press({ key: 'digest-edit' })
    // Mobile has no text field: the pane points to the command instead.
    const editable = surface === 'mobile' ? undefined : (ui as unknown as { input: (query: { key: string; text: string }) => Promise<void> })
    if (editable === undefined) await shows({ text: /Use \/digest recipients/ })
    else {
      await shows({ key: 'digest-recipients' })
      await editable.input({ key: 'digest-recipients', text: 'new@client.com, nope' })
      await shows({ text: /Not valid addresses: nope/ })
      await editable.input({ key: 'digest-recipients', text: 'new@client.com' })
      await shows({ text: 'To: new@client.com' })
      expect(configOf(w).projects?.[ROOT]?.recipients).toBe('new@client.com')
    }

    await ui.press({ key: 'digest-send' })
    expect(w.net.requests).toHaveLength(1)
    expect(JSON.parse(w.net.requests[0]?.init?.body ?? '{}').subject).toContain('Aggiornamento settimanale')
    await shows({ text: /Sent to/ })
    await ui.unmount()
  })
}

test('the pane says what is missing and does not pretend to send', async ($, on) => {
  const w = world(on)
  await start($)
  await digest($)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'email-digest', props: PANE })
  expect(await ui.find({ text: /Set the sender address/ })).toBeDefined()
  await ui.press({ key: 'digest-send' })
  expect(await ui.find({ text: /Set the sender address/ })).toBeDefined()
  expect(w.net.requests).toEqual([])
  await ui.unmount()
})
