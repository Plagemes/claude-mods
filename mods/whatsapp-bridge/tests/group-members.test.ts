import { expect, test } from 'claude-code/testing'
import type { RenderPropsOf } from 'claude-code'

import { parseGroupCreate, parseMembers, helperCandidates } from '../hooks/inbound'
import { errorText } from '../hooks/openwa'
import { DIR, GROUP, KEY, OWNER, OWNER_CHAT, ROOT, SESSION, pass, start, wa, world } from './fake'

const TEAM = '393339998888'
const props = (bodyColumns: number): RenderPropsOf['Pane'] => ({ title: 'WhatsApp', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} })
const mountOn = (surface: 'terminal' | 'desktop', columns = 52) => ({ plugin: 'whatsapp-bridge', surface, component: 'Pane' as const, requestId: 'whatsapp-bridge', props: props(columns) })
const NOTE = /WhatsApp needs at least one other member to create a group/
const files = (owners: string[]) => ({
  [`${DIR}/config.json`]: JSON.stringify({ apiKey: KEY, sessionId: SESSION, ownerNumbers: owners }),
  [`${DIR}/groups.json`]: '{}',
  [`${DIR}/prefs.json`]: JSON.stringify({ presence: 'away', interaction: 'on' }),
})
const creates = (seen: ReturnType<typeof world>) => seen.wa.calls.filter(call => call.method === 'POST' && call.path === `/sessions/${SESSION}/groups`)
const textsIn = (node: unknown): { wrap?: unknown; text: string }[] => {
  if (typeof node !== 'object' || node === null) return []
  const element = node as { type?: unknown; props?: Record<string, unknown>; children?: unknown[] }
  const own = element.type === 'Text' ? [{ wrap: element.props?.wrap, text: (element.children ?? []).filter(child => typeof child === 'string').join('') }] : []
  return [...own, ...(element.children ?? []).flatMap(textsIn)]
}

test('members: commas, spaces, +, 00 and duplicates parse to digits; short junk is dropped', () => {
  expect(parseMembers('+39 333 111 2222, 0044 7700 900123')).toEqual(['393331112222', '447700900123'])
  expect(parseMembers('+393331112222 +447700900123')).toEqual(['393331112222', '447700900123'])
  expect(parseMembers('393331112222 393339998888 393331112222')).toEqual(['393331112222', '393339998888'])
  expect(parseMembers('abc, 12')).toEqual([])
  expect(parseGroupCreate('Shop team --with +39333111, +44770090 --remove-helper')).toEqual({ name: 'Shop team', members: '+39333111, +44770090', removeHelper: true })
  expect(parseGroupCreate('')).toEqual({ name: '', members: '', removeHelper: false })
  expect(helperCandidates([OWNER, TEAM], [`${TEAM}@c.us`, 'x@g.us', '447700900123@s.whatsapp.net'], OWNER)).toEqual([TEAM, '447700900123'])
  expect(errorText(400, JSON.stringify({ statusCode: 400, message: ['a', 'b'], error: 'Bad Request' }))).toBe('400: a; b')
})

test('self mode, no other number: nothing is sent, the pane note says what to do and lists the groups to link', async ($, on) => {
  const seen = world(on, { files: files([OWNER]) })
  seen.wa.phone = OWNER
  seen.wa.groups.push({ id: '120363000000000055@g.us', name: 'Shop on my phone', participants: [OWNER_CHAT] })
  await start($)
  await pass(seen, 2_000, 1_000)
  const ui = await $.ui.mount(mountOn('desktop'))
  await ui.press({ key: 'grp-create-btn' })
  expect(creates(seen)).toEqual([])
  expect(await ui.find({ type: 'Text', text: NOTE })).toBeDefined()
  expect(seen.toasts.some(toast => NOTE.test(toast))).toBe(false)
  await ui.press({ key: 'choice:120363000000000055@g.us' })
  expect(Object.keys(JSON.parse(seen.files.get(`${DIR}/groups.json`) ?? '{}'))).toContain(ROOT)
  await ui.unmount()
  expect(await wa($, 'group create')).toMatch(NOTE)
})

test('self mode with a member: participants are the typed numbers, never the own number; the helper can be removed again', async ($, on) => {
  const seen = world(on, { files: files([OWNER]) })
  seen.wa.phone = OWNER
  await start($)
  await pass(seen, 2_000, 1_000)
  const ui = await $.ui.mount(mountOn('terminal'))
  expect(await ui.find({ key: 'grp-remove-helper' })).toBeDefined()
  await ui.press({ key: 'grp-remove-helper' })
  await ui.input({ key: 'grp-members', text: `+${OWNER}, +${TEAM}` })
  expect(creates(seen)[0]?.body).toMatchObject({ participants: [`${TEAM}@c.us`] })
  const removal = seen.wa.calls.find(call => call.method === 'DELETE' && call.path.endsWith('/participants'))
  expect(removal?.body.participants).toEqual([`${TEAM}@c.us`])
  await ui.unmount()
})

test('self mode: the command takes --with, and a member stays unless --remove-helper is given', async ($, on) => {
  const seen = world(on, { files: files([OWNER]) })
  seen.wa.phone = OWNER
  await start($)
  await pass(seen, 2_000, 1_000)
  expect(await wa($, `group create Team room --with +${TEAM}`)).toContain('Created the WhatsApp group "Team room"')
  expect(creates(seen)[0]?.body).toEqual({ name: 'Team room', participants: [`${TEAM}@c.us`] })
  expect(seen.wa.calls.some(call => call.method === 'DELETE')).toBe(false)
})

test('self mode: other owners are proposed in the Members field and used by Create', async ($, on) => {
  const seen = world(on, { files: files([OWNER, TEAM]) })
  seen.wa.phone = OWNER
  await start($)
  await pass(seen, 2_000, 1_000)
  const ui = await $.ui.mount(mountOn('desktop'))
  expect(await ui.find({ key: 'grp-members' })).toBeDefined()
  await ui.press({ key: 'grp-create-btn' })
  expect(creates(seen)[0]?.body).toMatchObject({ participants: [`${TEAM}@c.us`] })
  await ui.unmount()
})

test('a 400 from OpenWA shows its validation message in the pane note; the toast stays short', async ($, on) => {
  const seen = world(on, { files: files([OWNER]) })
  seen.wa.phone = OWNER
  seen.wa.createError = { status: 400, body: { statusCode: 400, message: ['participants must contain at most 256 elements', 'participants should not be empty'], error: 'Bad Request' } }
  await start($)
  await pass(seen, 2_000, 1_000)
  const ui = await $.ui.mount(mountOn('desktop'))
  await ui.input({ key: 'grp-members', text: `+${TEAM}` })
  expect(await ui.find({ type: 'Text', text: /400: participants must contain at most 256 elements; participants should not be empty/ })).toBeDefined()
  expect(seen.toasts.at(-1)?.length).toBeLessThan(90)
  expect(seen.toasts.at(-1)).not.toContain('Bad Request')
  await ui.unmount()
})

test('non-self mode is unchanged: owners are participants, extra members are added', async ($, on) => {
  const seen = world(on, { files: files([OWNER]) })
  await start($)
  await pass(seen, 2_000, 1_000)
  const ui = await $.ui.mount(mountOn('desktop'))
  expect(await ui.find({ key: 'grp-remove-helper' })).toBeUndefined()
  await ui.press({ key: 'grp-create-btn' })
  expect(creates(seen)[0]?.body).toMatchObject({ participants: [OWNER_CHAT] })
  await ui.unmount()
  expect(await wa($, `group create Extra --with +${TEAM}`)).toContain('Created')
  expect(creates(seen)[1]?.body).toEqual({ name: 'Extra', participants: [OWNER_CHAT, `${TEAM}@c.us`] })
  expect(GROUP.length).toBeGreaterThan(0)
})

test('Members field layout: every line fits the pane on terminal and desktop, wide and narrow', async ($, on) => {
  const seen = world(on, { files: files([OWNER, TEAM]) })
  seen.wa.phone = OWNER
  await start($)
  await pass(seen, 2_000, 1_000)
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const columns of [52, 30]) {
      const ui = await $.ui.mount(mountOn(surface, columns))
      await ui.press({ key: 'grp-list' })
      const section = await ui.find({ key: 'grp-create' })
      expect(section).toBeDefined()
      for (const one of textsIn(section)) expect(one.wrap === 'wrap' || one.text.length <= columns).toBe(true)
      await ui.unmount()
    }
  }
})
