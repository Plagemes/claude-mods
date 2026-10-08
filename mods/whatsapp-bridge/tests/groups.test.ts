import { expect, test } from 'claude-code/testing'
import type { RenderPropsOf } from 'claude-code'

import { DIR, GROUP, OWNER, OWNER_CHAT, ROOT, configured, pass, sends, start, wa, world } from './fake'

const props = (bodyColumns: number): RenderPropsOf['Pane'] => ({ title: 'WhatsApp', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} })
const mountOn = (surface: 'terminal' | 'desktop', columns = 52) => ({ plugin: 'whatsapp-bridge', surface, component: 'Pane' as const, requestId: 'whatsapp-bridge', props: props(columns) })
/** Set up and linked, with no group yet. */
const noGroup = () => configured({ [`${DIR}/groups.json`]: '{}', [`${DIR}/prefs.json`]: JSON.stringify({ presence: 'away', interaction: 'on' }) })
const groupsFile = (seen: ReturnType<typeof world>) =>
  Object.fromEntries(Object.entries(JSON.parse(seen.files.get(`${DIR}/groups.json`) ?? '{}') as Record<string, unknown>).filter(([key]) => !key.startsWith('_'))) as Record<
    string,
    { groupId?: string; name?: string; members?: number; scope?: string }
  >

/** Every Text under a found element, with its wrap and what it shows. */
const textsIn = (node: unknown): { wrap?: unknown; text: string }[] => {
  if (typeof node !== 'object' || node === null) return []
  const element = node as { type?: unknown; props?: Record<string, unknown>; children?: unknown[] }
  const own = element.type === 'Text' ? [{ wrap: element.props?.wrap, text: (element.children ?? []).filter(child => typeof child === 'string').join('') }] : []
  return [...own, ...(element.children ?? []).flatMap(textsIn)]
}

test('Groups: "Create group for this project" creates "Claude · shop" with the owner, links it, and welcomes with "help"', async ($, on) => {
  const seen = world(on, { files: noGroup() })
  await start($)
  await pass(seen, 2_000, 1_000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(mountOn(surface))
    expect(await ui.find({ key: 'grp-create-btn' })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount(mountOn('desktop'))
  await ui.press({ key: 'grp-create-btn' })
  expect(seen.wa.groups[0]).toMatchObject({ name: 'Claude · shop', participants: [OWNER_CHAT] })
  expect(groupsFile(seen)[ROOT]).toMatchObject({ groupId: GROUP, name: 'Claude · shop', scope: 'project' })
  expect(sends(seen).at(-1)).toMatchObject({ chatId: GROUP })
  expect(sends(seen).at(-1)?.text).toContain('Send *help*')
  // The row lists it as this session's, with its members and where it routes.
  expect(await ui.find({ type: 'Text', text: /1\. Claude · shop → shop · \d+ members? · this session/ })).toBeDefined()
  await ui.unmount()
})

test('Groups: the name is editable before creating; per-session scope names and keys the group by the session', { options: { groupScope: 'session' } }, async ($, on) => {
  const seen = world(on, { files: noGroup() })
  await start($)
  await pass(seen, 2_000, 1_000)
  const ui = await $.ui.mount(mountOn('terminal'))
  expect(await ui.find({ key: 'grp-create-btn', text: /this session/ })).toBeDefined()
  await ui.input({ key: 'grp-name', text: 'Shop · login work' })
  expect(seen.wa.groups[0]?.name).toBe('Shop · login work')
  expect(Object.keys(groupsFile(seen))).toEqual([`${ROOT}#login`])
  await ui.unmount()
  expect(await wa($, 'group create')).toContain('Claude · shop · login')
})

test('Groups: rename, invite (one refused gets the invite link), relink and unlink/leave use OpenWA’s group endpoints', async ($, on) => {
  const seen = world(on, { files: noGroup() })
  await start($)
  await pass(seen, 2_000, 1_000)
  await wa($, 'group create')
  const ui = await $.ui.mount(mountOn('desktop'))
  await ui.input({ key: 'grp-rename', text: 'Shop team' })
  expect(seen.wa.calls.some(call => call.method === 'PUT' && call.path.endsWith('/subject') && call.body.subject === 'Shop team')).toBe(true)
  expect(groupsFile(seen)[ROOT]?.name).toBe('Shop team')

  seen.wa.refuseAdd.push('447700900999')
  await ui.input({ key: 'grp-invite', text: '+44 7700 900123, 0044 7700 900999' })
  const add = seen.wa.calls.find(call => call.method === 'POST' && call.path.endsWith('/participants'))
  expect(add?.body.participants).toEqual(['447700900123@c.us', '447700900999@c.us'])
  expect(seen.toasts.at(-1)).toContain('https://chat.whatsapp.com/CODE')
  await ui.unmount()

  // A group linked to another project is re-linked here from its row.
  seen.files.set(`${DIR}/groups.json`, JSON.stringify({ '/work/blog': { groupId: GROUP, name: 'Shop team', inviteLink: '', members: 3, createdAt: 0 } }))
  await pass(seen, 12_000)
  const again = await $.ui.mount(mountOn('terminal'))
  await again.press({ key: `grp-link:${GROUP}` })
  expect(Object.keys(groupsFile(seen))).toEqual([ROOT])
  await again.press({ key: `grp-leave:${GROUP}` })
  expect(seen.wa.calls.some(call => call.method === 'POST' && call.path.endsWith('/leave'))).toBe(true)
  expect(groupsFile(seen)).toEqual({})
  await again.unmount()
})

test('Groups: an engine that cannot create groups (501) says so and offers the groups to link instead', async ($, on) => {
  const seen = world(on, { files: noGroup(), canCreateGroups: false })
  seen.wa.groups.push({ id: '120363000000000055@g.us', name: 'Shop on my phone', participants: [OWNER_CHAT] })
  await start($)
  await pass(seen, 2_000, 1_000)
  const ui = await $.ui.mount(mountOn('desktop'))
  await ui.press({ key: 'grp-create-btn' })
  expect(await ui.find({ type: 'Text', text: /not supported by this engine/ })).toBeDefined()
  expect(groupsFile(seen)).toEqual({})
  await ui.press({ key: 'choice:120363000000000055@g.us' })
  expect(groupsFile(seen)[ROOT]?.groupId).toBe('120363000000000055@g.us')
  await ui.unmount()
})

test('Groups: two sessions writing groups.json at the same moment both keep their link', async ($, on) => {
  const seen = world(on, { files: noGroup() })
  await start($)
  await pass(seen, 2_000, 1_000)
  let raced = false
  // The other session read the same empty file and writes its own link right after this one's write landed.
  seen.afterWrite = path => {
    if (path === `${DIR}/groups.json` && !raced) {
      raced = true
      seen.files.set(path, JSON.stringify({ _rev: 1, '/work/blog': { groupId: '120363000000000077@g.us', name: 'Claude · blog', inviteLink: '', members: 1, createdAt: 0 } }))
    }
  }
  await wa($, 'group create')
  expect(Object.keys(groupsFile(seen)).filter(key => !key.startsWith('_')).sort()).toEqual(['/work/blog', ROOT])
})

test('Groups layout: every line fits the pane on terminal and desktop, wide and narrow', async ($, on) => {
  const seen = world(on, { files: noGroup() })
  await start($)
  await pass(seen, 2_000, 1_000)
  await wa($, 'group create A rather long group name for a project with a long folder name too')
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const columns of [52, 30]) {
      const ui = await $.ui.mount(mountOn(surface, columns))
      const section = await ui.find({ key: 'groups' })
      expect(section).toBeDefined()
      const rows = textsIn(section)
      expect(rows.some(one => one.text.includes('A rather long'))).toBe(true)
      // One-line rows are cut to the pane's width by the bridge itself, never left to overflow; the rest wrap.
      for (const one of rows) expect(one.wrap === 'wrap' || one.text.length <= columns).toBe(true)
      await ui.unmount()
    }
  }
  expect(OWNER.length).toBeGreaterThan(0)
})
