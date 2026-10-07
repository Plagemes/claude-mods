import { expect, mock, test } from 'claude-code/testing'
import type { HttpResponse, On } from 'claude-code'

import { credentialProblem, formatBody, parseRequest, redactRequest, toCurl } from '../hooks/request'

const NOW = 1_700_000_000_000
const PANE = {
  plugin: 'http-client',
  component: 'Pane',
  requestId: 'http',
  props: { title: 'HTTP', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const http = (args: string) => ({ command: 'http', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const

type Sent = { url: string; method?: string; headers?: Record<string, string>; body?: string }
type World = { sent: Sent[]; copied: string[]; prompts: string[]; filled: string[]; toasts: string[]; store: Map<string, unknown> }

/** Stands for the engine: a server answering with `reply`, a clipboard, the prompt box, a store and panes. */
const world = (on: On, reply: (sent: Sent) => HttpResponse | Promise<HttpResponse> = () => USERS) => {
  const state: World = { sent: [], copied: [], prompts: [], filled: [], toasts: [], store: new Map() }
  const clock = mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('http.fetch', async ($, e) => {
    const sent = { url: e.url, ...e.init }
    state.sent.push(sent)
    return { value: await reply(sent) }
  })
  on('store.get', ($, e) => ({ value: state.store.get(e.key) }))
  on('store.set', ($, e) => {
    state.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    state.store.delete(e.key)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.copy', ($, e) => {
    state.copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    state.prompts.push(e.text)
    return { text: e.text }
  })
  on('prompt.fill', ($, e) => {
    state.filled.push(e.text)
    return { isFilled: true }
  })
  return { state, clock }
}

const USERS: HttpResponse = {
  status: 200,
  ok: true,
  headers: { 'content-type': 'application/json; charset=utf-8', 'set-cookie': 'sid=abc' },
  text: '{"users":[{"id":1,"name":"Ada"}]}',
}

test('reads the command line, refuses clear-text credentials, writes curl and masks secrets', () => {
  const parsed = parseRequest(`post localhost:3000/users {"name": "Ada Lovelace"} -H 'Authorization: Bearer t0k'`)
  expect(parsed).toEqual({
    request: {
      method: 'POST',
      url: 'http://localhost:3000/users',
      headers: { Authorization: 'Bearer t0k', 'Content-Type': 'application/json' },
      body: '{"name": "Ada Lovelace"}',
    },
  })
  if (!('request' in parsed)) throw new Error('not parsed')
  expect(credentialProblem(parsed.request)).toBeUndefined()
  expect(toCurl(parsed.request)).toBe(
    `curl -X POST http://localhost:3000/users -H 'Authorization: Bearer t0k' -H 'Content-Type: application/json' --data-raw '{"name": "Ada Lovelace"}'`,
  )
  expect(redactRequest(parsed.request).request.headers.Authorization).toBe('<redacted>')

  const remote = parseRequest(`DELETE http://api.example.com/x -H "authorization: Basic eA=="`)
  if (!('request' in remote)) throw new Error('not parsed')
  expect(credentialProblem(remote.request)).toContain('Refused: the authorization header would travel unencrypted to api.example.com')
  const inUrl = parseRequest('http://me:secret@api.example.com/')
  if (!('request' in inUrl)) throw new Error('not parsed')
  expect(credentialProblem(inUrl.request)).toContain('user:password in the URL')
  expect(redactRequest(inUrl.request).request.url).toBe('http://me:<redacted>@api.example.com/')

  expect(parseRequest('example.com/a?access_token=xyz&q=1')).toEqual({ request: { method: 'GET', url: 'https://example.com/a?access_token=xyz&q=1', headers: {} } })
  expect(parseRequest('GET ftp://files')).toEqual({ error: '"ftp://files" is not an http(s) URL.' })
  expect(parseRequest('GET')).toEqual({ error: 'no URL given.' })
  expect(formatBody('{"a":[1]}', 'application/json')).toEqual({ kind: 'json', text: '{\n  "a": [\n    1\n  ]\n}', language: 'json' })
  expect(formatBody('# Hi', 'text/markdown')).toEqual({ kind: 'markdown', text: '# Hi' })
})

test('/http sends the request and shows status, headers and a pretty body on terminal and desktop', async ($, on) => {
  const { state } = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ran = await $.command.run(http('GET https://api.example.com/users -H "Accept: application/json"'))
  expect(ran.text).toBe('GET https://api.example.com/users → 200 OK · 0 ms · 33 B · application/json')
  expect(state.sent).toEqual([{ url: 'https://api.example.com/users', method: 'GET', headers: { Accept: 'application/json' } }])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: '200 OK' })).toBeDefined()
    expect(await ui.find({ type: 'Code', text: /"name": "Ada"/ })).toBeDefined()
    expect(await ui.find({ key: 'header-list' })).toBeUndefined()
    await ui.press({ key: 'headers' })
    expect((await ui.find({ key: 'header-list' }))?.text).toContain('set-cookie: <redacted>')
    await ui.press({ key: 'headers' })
    await ui.press({ key: 'curl' })
    await ui.unmount()
  }
  expect(state.copied).toEqual([
    "curl https://api.example.com/users -H 'Accept: application/json'",
    "curl https://api.example.com/users -H 'Accept: application/json'",
  ])
})

test('Send to Claude submits the exchange with secrets masked; Repeat sends it again', async ($, on) => {
  const { state } = world(on)
  await $.command.run(http('POST https://api.example.com/users {"name":"Ada"} -H "Authorization: Bearer s3cret"'))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'claude' })
  expect(state.prompts[0]).toContain('I sent this request with /http: `POST https://api.example.com/users`')
  expect(state.prompts[0]).toContain('- Authorization: <redacted>')
  expect(state.prompts[0]).toContain('- set-cookie: <redacted>')
  expect(state.prompts[0]).toContain('```json\n{\n  "users": [')
  expect(state.prompts[0]).not.toContain('s3cret')
  await ui.press({ key: 'repeat' })
  expect(state.sent).toHaveLength(2)
  expect(state.sent[1]?.headers?.Authorization).toBe('Bearer s3cret')
})

test('credentials over plain http to another host are refused before anything is sent', async ($, on) => {
  const { state } = world(on)
  const refused = await $.command.run(http('GET http://api.example.com/me -H "Authorization: Bearer abc"'))
  expect(refused.text).toContain('Refused: the Authorization header would travel unencrypted to api.example.com over http')
  expect(state.sent).toHaveLength(0)
  const local = await $.command.run(http('GET http://127.0.0.1:8080/me -H "Authorization: Bearer abc"'))
  expect(local.text).toContain('→ 200 OK')
  expect(state.sent).toHaveLength(1)
})

test('a server that never answers times out, and a network error is reported', async ($, on) => {
  let calls = 0
  const { clock } = world(on, async () => {
    calls += 1
    if (calls === 2) throw new Error('connect ECONNREFUSED 127.0.0.1:9')
    await clock.sleep(120_000)
    return USERS
  })
  const pending = $.command.run(http('https://slow.example.com/'))
  await clock.advance(30_000)
  expect((await pending).text).toBe('GET https://slow.example.com/ → failed: no answer within 30 s')
  const refused = await $.command.run(http(':9/'))
  expect(refused.text).toContain('GET http://localhost:9/ → failed:')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Failed: / })).toBeDefined()
})

test('history keeps the last 20 requests with secrets masked; /http history lists them for resend or edit', async ($, on) => {
  const { state } = world(on)
  for (let i = 0; i < 21; i += 1) await $.command.run(http(`https://api.example.com/items/${i}`))
  await $.command.run(http('https://api.example.com/me?api_key=k3y -H "X-Api-Key: k3y"'))
  const stored = state.store.get('history') as { request: { url: string; headers: Record<string, string> }; isRedacted: boolean }[]
  expect(stored).toHaveLength(20)
  expect(stored[0]?.request.url).toBe('https://api.example.com/me?api_key=<redacted>')
  expect(stored[0]?.request.headers['X-Api-Key']).toBe('<redacted>')
  expect(stored[0]?.isRedacted).toBe(true)
  expect(JSON.stringify(stored)).not.toContain('k3y')

  const listed = await $.command.run(http('history'))
  expect(listed.text).toBe('20 recent requests.')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'send:0' })).toBeUndefined()
    await ui.press({ key: 'edit:0' })
    await ui.unmount()
  }
  expect(state.filled).toHaveLength(2)
  expect(state.filled[0]).toBe("/http GET 'https://api.example.com/me?api_key=<redacted>' -H 'X-Api-Key: <redacted>'")
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'send:1' })
  expect(state.sent.at(-1)?.url).toBe('https://api.example.com/items/20')
  expect(await ui.find({ type: 'Text', text: '200 OK' })).toBeDefined()
  expect((await $.command.run(http('history clear'))).text).toBe('History cleared.')
  expect(state.store.has('history')).toBe(false)
})
