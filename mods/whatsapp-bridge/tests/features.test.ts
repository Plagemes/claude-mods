import { expect, test } from 'claude-code/testing'

import { DIR, GROUP, HOME, OWNER_CHAT, PNG, ROOT, arrive, configured, lead, pass, react, sends, start, wa, world } from './fake'

const COMPOSE = { model: 'claude', promptModel: 'claude', surfaces: ['terminal'] as const, tools: [], outputStyle: null, traits: [] }

const files = (extra: Record<string, unknown> = {}) =>
  configured({ [`${DIR}/prefs.json`]: JSON.stringify({ presence: 'away', interaction: 'on', events: { confirmPrompts: false }, ...extra }) })

test('visual reports: PNG charts through a local converter, a text table without one', async ($, on) => {
  const seen = world(on, { files: files() })
  seen.files.set(`${HOME}/.claude/claude-mods/smart-router/daily.json`, JSON.stringify({ date: '2026-10-07', saved: 1.5, spent: 4, byModel: {} }))
  await start($)
  expect(await wa($, 'report')).toBe('Sent the report.')
  const text = sends(seen).at(-1)
  expect(text?.chatId).toBe(OWNER_CHAT)
  expect(text?.text).toContain('Claude Code cost per day')
  expect(text?.text).toContain('smart-router: spent vs saved')
  expect(text?.text).toContain('rsvg-convert')
})

test('visual reports are sent as images when rsvg-convert exists', async ($, on) => {
  const seen = world(on, { files: files() })
  seen.bins.add('rsvg-convert')
  await start($)
  await wa($, 'report')
  const images = seen.wa.calls.filter(call => call.path.endsWith('/send-image'))
  expect(images).toHaveLength(2)
  expect(images[0]?.body).toMatchObject({ chatId: OWNER_CHAT, base64: PNG, mimetype: 'image/png' })
  expect(seen.files.get(`${DIR}/tmp/cost.svg`)).toContain('<svg')
})

test('a new UI screenshot is sent for review; the owner’s reply becomes a fix prompt', async ($, on) => {
  const seen = world(on, { files: files() })
  await lead($, seen)
  seen.files.set(`${ROOT}/.claude/screenshots/checkout.png`, PNG)
  await pass(seen, 16_000)
  const preview = seen.wa.calls.filter(call => call.path.endsWith('/send-image')).at(-1)
  expect(preview?.body).toMatchObject({ chatId: GROUP, base64: PNG })
  expect(String(preview?.body.caption)).toContain('UI preview checkout.png')
  const sent = seen.wa.rows.filter(row => row.direction === 'outgoing').at(-1)
  arrive(seen, { chatId: GROUP, author: OWNER_CHAT, body: 'the button is cut off on mobile', quotedId: sent?.waMessageId ?? '' })
  await pass(seen, 12_000)
  expect(seen.submitted.at(-1)?.text).toContain('rejected the UI screenshot checkout.png')
  expect(seen.submitted.at(-1)?.text).toContain('the button is cut off on mobile')
})

test('a failed turn alerts while away and 🔁 retries it', async ($, on) => {
  const seen = world(on, { files: files() })
  await lead($, seen)
  await $.turn.start({ text: 'migrate the orders table', turnId: 't1' })
  await $.turn.complete({ answer: '', durationMs: 90_000, isAborted: false, turnId: 't1', reason: 'error' })
  const alert = seen.wa.rows.filter(row => row.direction === 'outgoing').at(-1)
  expect(alert?.body).toContain('turn failed')
  react(seen, alert?.waMessageId ?? '', OWNER_CHAT, '🔁')
  await pass(seen, 30_000)
  expect(seen.submitted.at(-1)?.text).toBe('Retry: migrate the orders table')
})

test('a photo from the phone is saved in the project and handed to Claude by path', async ($, on) => {
  const seen = world(on, { files: files() })
  seen.bins.add('openssl')
  await lead($, seen)
  arrive(seen, { chatId: GROUP, author: OWNER_CHAT, body: 'why does it look like this?', type: 'image', media: { mimetype: 'image/jpeg', data: 'AAAA' } })
  await pass(seen, 12_000)
  const prompt = seen.submitted.at(-1)?.text ?? ''
  expect(prompt).toContain('why does it look like this?')
  expect(prompt).toMatch(/saved at \/work\/shop\/\.claude\/whatsapp\/inbox\/2026-10-07-\w+\.jpg/)
  const saved = [...seen.files.keys()].find(path => path.endsWith('.jpg'))
  expect(seen.files.get(saved ?? '')).toBe('decoded:AAAA')
})

test('the system prompt section follows the interaction mode', async ($, on) => {
  const seen = world(on, { files: files() })
  await start($)
  const compose = async () => (await $.prompt.compose(COMPOSE)).sections.find(section => section.id === 'whatsapp-bridge')?.text ?? ''
  expect(await compose()).toContain('Use ask only when you are blocked')
  await wa($, 'night')
  expect(await compose()).toContain('NOT available')
  expect(seen.files.get(`${DIR}/prefs.json`)).toContain('"interaction": "night"')
})
