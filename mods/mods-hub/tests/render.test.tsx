// The panel always draws a tree of its own: on the first draw before anything loaded, after a reload, when its drawing
// throws, and on a tab whose owner draws nothing. In Claude Code Desktop a pane the engine draws itself is only the
// placeholder "Nothing to show yet — mods-hub has not drawn in this pane".
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

const NOON = new Date(2026, 9, 7, 12, 0, 0).getTime()
const SURFACES = ['desktop', 'terminal'] as const
const ENGINE = { type: 'engine', ref: 0 }

const pane = (columns = 96): RenderPropsOf['Pane'] => ({ title: 'Claude Mods', isFocused: false, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} })

/** The engine beneath every plugin: files, session facts, and a `ui.render` bottom that answers as the engine does. */
function world(on: On, bottom: unknown = ENGINE) {
  mock.clock(on, { now: NOON })
  mock.env(on, { HOME: '/home/me' })
  on('fs.read', ($, e) => ({ deny: `ENOENT: ${e.path}` }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', ($, e) => ({ deny: `ENOENT: ${e.path}` }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1234abcd' }))
  on('session.cwd', () => ({ value: '/work/shop' }))
  on('session.repo', () => ({ value: null }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  // What `next(e)` resolves to at the bottom of a real chain: the engine's own drawing.
  on('ui.render', () => bottom as never)
}

/** Every node of a drawn tree. */
function nodes(tree: unknown, out: { type?: unknown; props?: Record<string, unknown> }[] = []) {
  if (tree === null || typeof tree !== 'object') return out
  if (Array.isArray(tree)) {
    for (const child of tree) nodes(child, out)
    return out
  }
  const node = tree as { type?: unknown; props?: Record<string, unknown>; children?: unknown }
  out.push(node)
  nodes(node.children, out)
  return out
}

const engineNodes = (tree: unknown) => nodes(tree).filter(node => node.type === 'engine').length

const mount = ($: Engine, surface: (typeof SURFACES)[number]) =>
  $.ui.mount({ plugin: 'mods-hub', surface, component: 'Pane', requestId: 'claude-mods', props: pane() })

/** Hub state left by an earlier load of the module: a hot reload keeps `$.state`, never the module's variables. */
function earlierLoad(on: On, values: { tab: string; tabs: unknown[] }) {
  on('state.get', { plugin: 'mods-hub', key: 'tab' }, () => ({ value: { value: values.tab, version: 1 } }))
  on('state.get', { plugin: 'mods-hub', key: 'tabs' }, () => ({ value: { value: values.tabs, version: 1 } }))
}

const COST_TAB = { id: 'cost', title: 'Cost', owner: 'daily-spend', order: 90, command: 'spend' }

for (const surface of SURFACES) {
  test(`first draw on the ${surface}, before session.start and with no state: the frame and Home, never the engine's blank pane`, async ($, on) => {
    world(on)
    const ui = await mount($, surface)
    expect(await ui.find({ type: 'Text', text: ' · Hub' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '● Here' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Listing the installed mods…' })).toBeDefined()
    expect(await ui.find({ key: 'tab-home' })).toBeDefined()
    expect(engineNodes(await ui.drawn())).toBe(0)
    await ui.unmount()
  })

  test(`after a reload on the ${surface}: a tab an earlier load showed, whose owner has not drawn yet, gets a friendly empty state`, async ($, on) => {
    world(on)
    earlierLoad(on, { tab: 'cost', tabs: [COST_TAB] })
    // The new load draws before its session.start has run, as the engine may after a reload.
    const ui = await mount($, surface)
    expect(await ui.find({ type: 'Text', text: 'Cost' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Cost has nothing to show here yet.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '/spend opens it.' })).toBeDefined()
    expect(engineNodes(await ui.drawn())).toBe(0)
    await ui.unmount()
  })
}

test('a drawing that throws shows an error card with Retry, and Retry draws the panel again', async ($, on) => {
  world(on)
  // A malformed tabs value (as a damaged state or an older load could leave): sorting it throws a TypeError.
  let isBroken = true
  on('state.get', { plugin: 'mods-hub', key: 'tabs' }, () => ({ value: { value: isBroken ? [null] : [], version: isBroken ? 1 : 2 } }))
  const ui = await mount($, 'desktop')
  expect(await ui.find({ type: 'Text', text: '▪▪▪ Claude Mods could not draw this panel' })).toBeDefined()
  expect((await ui.find({ key: 'panel-retry' }))?.props).toMatchObject({ label: 'Retry' })
  expect(engineNodes(await ui.drawn())).toBe(0)
  isBroken = false
  await ui.press({ key: 'panel-retry' })
  expect(await ui.find({ key: 'panel-error' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: ' · Hub' })).toBeDefined()
  await ui.unmount()
})

/**
 * Tab owners as MOD_CONTRACT.md used to show them, `<Box>{await next(e)}{mine}</Box>` (a test plugin is self-contained:
 * no shared helper). `quiet-owner` hooks its tab and never adds a section; `busy-owner` adds one.
 */
const quietOwner: Plugin = {
  name: 'quiet-owner',
  register(on) {
    on('ui.render', { component: 'Pane', requestId: 'claude-mods' }, async ($, e, next) => {
      const { value } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
      if (value !== 'quiet') return next(e)
      return { type: 'Box', props: { flexDirection: 'column' }, children: [await next(e)] } as never
    })
  },
}
const busyOwner: Plugin = {
  name: 'busy-owner',
  register(on) {
    on('ui.render', { component: 'Pane', requestId: 'claude-mods' }, async ($, e, next) => {
      const { value } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
      if (value !== 'busy') return next(e)
      return { type: 'Box', props: { flexDirection: 'column' }, children: [await next(e), { type: 'Text', props: {}, children: ['busy-owner section'] }] } as never
    })
  },
}

test("a tab whose owner never draws: the hub's frame and an empty state, with the engine's node kept out of it", { plugins: [quietOwner] }, async ($, on) => {
  world(on)
  earlierLoad(on, { tab: 'quiet', tabs: [{ id: 'quiet', title: 'Quiet', owner: 'quiet-owner', order: 10 }] })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    // Beneath the hub the owner hands back the engine's node; under the frame's sized Boxes the engine would have
    // refused the whole panel (the desktop's "mods-hub has not drawn in this pane").
    expect(await ui.find({ type: 'Text', text: ' · Hub' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Quiet has nothing to show here yet.' })).toBeDefined()
    expect(engineNodes(await ui.drawn())).toBe(0)
    await ui.unmount()
  }
})

test('a tab whose owner draws beneath the hub: its section, and no empty note', { plugins: [busyOwner] }, async ($, on) => {
  world(on)
  earlierLoad(on, { tab: 'busy', tabs: [{ id: 'busy', title: 'Busy', owner: 'busy-owner', order: 10 }] })
  const ui = await mount($, 'desktop')
  expect(await ui.find({ type: 'Text', text: 'busy-owner section' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Busy has nothing to show here yet.' })).toBeUndefined()
  expect(engineNodes(await ui.drawn())).toBe(0)
  await ui.unmount()
})
