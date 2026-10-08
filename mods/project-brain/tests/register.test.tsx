import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

/** The mock clock of the running test, moved on past afterStart's delay so the hub hello is sent. */
let startClock: ReturnType<typeof mock.clock> | undefined

const ROOT = '/work/shop'
const T0 = Date.UTC(2026, 9, 7, 9, 0)
const MINUTE = 60_000
const GRAPH = `${ROOT}/.claude/brain/graph.json`
const RANKER = `${ROOT}/.claude/brain/ranker.json`
const PANE: RenderPropsOf['Pane'] = { title: 'Brain', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} }

const PROJECT: Record<string, string> = {
  'CLAUDE.md': '# Shop\n\n- Always use pnpm for scripts, never npm.\n- Tests live next to the code they test.\n',
  'docs/decisions/0001-postgres.md': '# 1. Use Postgres for orders\n\nDate: 2026-09-14\n\n## Status\nAccepted\n\n## Decision\nOrders are stored in Postgres through the pool in src/db.ts.\n',
  'GLOSSARY.md': '**SKU**: stock keeping unit, one sellable variant\n',
  'CODEOWNERS': 'src/payments/ @alice\n',
}

type World = {
  clock: ReturnType<typeof mock.clock>
  files: Map<string, string>
  contexts: string[][]
  toasts: string[]
  opened: string[]
  tools: string[]
  modelPrompts: string[]
  answers: string[]
}

/** The engine beneath the plugin: a small project on a virtual disk, a model, the screen, the transcript. */
function world(on: On, modelReply = '{"items":[{"kind":"convention","text":"Money amounts are integers in cents (src/cart.ts)","files":["src/cart.ts"]}]}'): World {
  const clock = (startClock = mock.clock(on, { now: T0 }))
  const files = new Map(Object.entries(PROJECT).map(([path, text]) => [`${ROOT}/${path}`, text]))
  const mtimes = new Map<string, number>()
  const w: World = { clock, files, contexts: [], toasts: [], opened: [], tools: [], modelPrompts: [], answers: [] }
  const isDir = (path: string) => [...files.keys()].some(file => file.startsWith(`${path}/`))
  on('session.repo', () => ({ value: null }))
  on('session.root', () => ({ value: ROOT }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'previous prompt', toolUses: [] }, { role: 'assistant', text: w.answers.at(-1) ?? '', toolUses: [] }] }))
  on('fs.read', ($, e) => (files.has(e.path) ? { value: files.get(e.path) ?? '' } : { deny: `ENOENT: ${e.path}` }))
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    mtimes.set(e.path, clock.now())
    return { value: undefined }
  })
  on('fs.stat', ($, e) => {
    const text = files.get(e.path)
    if (text !== undefined) return { value: { kind: 'file', size: text.length, mtimeMs: mtimes.get(e.path) ?? 1, isLink: false } }
    return isDir(e.path) ? { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } } : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.list', ($, e) => {
    if (!isDir(e.path)) return { deny: `ENOENT: ${e.path}` }
    const names = new Map<string, 'file' | 'dir'>()
    for (const file of files.keys()) {
      if (!file.startsWith(`${e.path}/`)) continue
      const [name = '', ...rest] = file.slice(e.path.length + 1).split('/')
      names.set(name, rest.length === 0 ? 'file' : 'dir')
    }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 100, mtimeMs: 1, isLink: false })) }
  })
  on('tool.register', ($, e) => {
    w.tools.push(e.name)
    return { value: { tool: `mcp__project-brain__${e.name}` } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('model.complete', ($, e) => {
    w.modelPrompts.push(e.prompt)
    return { value: { isAnswered: true as const, text: modelReply, usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }
  })
  on('prompt.submit', ($, e) => {
    w.contexts.push([...(e.context ?? [])])
    return { text: e.text, ...(e.context === undefined ? {} : { context: e.context }) }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  let vitestRuns = 0
  on('tool.call', ($, e) => {
    if (e.tool === 'Bash' && String(e.command).includes('vitest')) {
      vitestRuns += 1
      return vitestRuns % 2 === 1 // red, green, red again…
        ? { isError: true as const, result: 'Exit code 1', text: ' FAIL  src/cart.test.ts > totals\nAssertionError: expected 4199 to be 4200\n Tests  1 failed | 9 passed\n' }
        : { result: { stdout: ' Tests  10 passed (10)', stderr: '', interrupted: false }, text: ' Tests  10 passed (10)' }
    }
    return { result: 'ok', text: 'ok' }
  })
  return w
}

const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
const prompt = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
const finish = async ($: Engine, w: World, answer: string, turn: string) => {
  w.answers.push(answer)
  await $.turn.complete({ answer, durationMs: 1000, isAborted: false, turnId: turn, reason: 'answer' })
}
const brain = ($: Engine, args: string) => $.command.run({ command: 'brain', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
const graphOf = (w: World): { nodes: [string, string, string][]; edges: unknown[] } => JSON.parse(w.files.get(GRAPH) ?? '{"nodes":[],"edges":[]}')
const textsOf = (w: World): string[] => graphOf(w).nodes.map(row => row[2])

test('a session with no hub: imports, learns from edits and a fix, recalls into the next prompt, learns from feedback, sleeps', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.advance(6_000) // import, then the debounced save
  expect(w.tools).toEqual(['brain_recall', 'brain_remember'])
  expect(textsOf(w)).toContain('Use Postgres for orders: Orders are stored in Postgres through the pool in src/db.ts.')
  expect(textsOf(w)).toContain('Always use pnpm for scripts, never npm.')

  await prompt($, 'Add a refund column to the orders table; run the migration with pnpm')
  const first = w.contexts.at(-1)?.join('\n') ?? ''
  expect(first).toContain('Project memory (project-brain)')
  expect(first).toContain('decided 2026-09-14: Use Postgres for orders')
  expect(first).not.toContain('pnpm for scripts') // already in the system prompt via CLAUDE.md

  // The turn: a failing test, an edit, the test passing → error → fix lesson; the answer uses the ADR.
  await $.tool.call({ tool: 'Bash', command: 'npx vitest run src/cart.test.ts' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/cart.ts`, old_string: 'a', new_string: 'export function cartTotal(items) { return items.reduce(add, 0) }' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/db.ts`, old_string: 'a', new_string: 'export const refundColumn = "refund_cents"' })
  await $.tool.call({ tool: 'Bash', command: 'npx vitest run src/cart.test.ts' })
  await w.clock.settle()
  await finish($, w, 'Added refund_cents to the orders table in Postgres via src/db.ts, and fixed cartTotal rounding.', 't1')
  await w.clock.advance(6_000)
  const texts = textsOf(w)
  expect(texts.some(text => text.startsWith('Fix for "AssertionError: expected 4199 to be 4200"'))).toBe(true)
  expect(texts).toContain('src/cart.ts')
  expect(texts).toContain('cartTotal')
  const adr = graphOf(w).nodes.find(row => row[2].startsWith('Use Postgres for orders')) as unknown[]
  expect(adr[12]).toBe(1) // uses: recalled and then used
  expect(JSON.parse(w.files.get(RANKER) ?? '{}').samples).toBe(1)

  // The same failure later: the fix comes back through the error, with no words in common with the prompt.
  await $.tool.call({ tool: 'Bash', command: 'npx vitest run src/cart.test.ts --reporter dot' })
  await prompt($, 'hmm, still red?')
  expect(w.contexts.at(-1)?.join('\n') ?? '').toContain('lesson 2026-10-07: Fix for "AssertionError')

  // Idle for 10 minutes: sleep extracts with the model in the background and consolidates.
  await finish($, w, 'It was the same rounding issue.', 't2')
  await w.clock.advance(11 * MINUTE)
  expect(w.modelPrompts.join('\n')).toContain('Turn 1')
  expect(textsOf(w)).toContain('Money amounts are integers in cents (src/cart.ts)')
  expect(w.toasts).toEqual([])
})

test('Claude remembers and recalls with its tools; secrets are masked and code is never stored', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  const key = `sk_live_${'4eC39HqLyjWDarjtT1zdp7dc'}`
  const saved = await $.tool.call({ tool: 'mcp__project-brain__brain_remember', text: `Payments use Stripe with key ${key}; webhooks land in src/payments/hooks.ts`, kind: 'decision' })
  expect(String(saved.result)).toMatch(/^Remembered as decision \[d\w+\]/)
  expect(String(saved.result)).not.toContain(key)
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/payments/hooks.ts`, content: `const SECRET = "${key}"\nexport function handleWebhook(event) {}\n` })
  await w.clock.advance(6_000)
  const stored = w.files.get(GRAPH) ?? ''
  expect(stored).not.toContain(key)
  expect(stored).toContain('handleWebhook')
  expect(stored).not.toContain('SECRET = ')

  const recalled = String((await $.tool.call({ tool: 'mcp__project-brain__brain_recall', query: 'stripe webhooks' })).result)
  expect(recalled).toContain('Memories recalled for "stripe webhooks"')
  expect(recalled).toMatch(/1\. \[decision · 2026-10-07 · d\w+\] Payments use Stripe/)
  // CODEOWNERS: the owner of src/payments/ comes along through the file.
  const byOwner = String((await $.tool.call({ tool: 'mcp__project-brain__brain_recall', query: 'payments webhook handler' })).result)
  expect(byOwner).toContain('@alice owns src/payments/')
  expect(String((await $.tool.call({ tool: 'mcp__project-brain__brain_recall', query: '' })).result)).toContain('the query is empty')

  // The session ends: consolidated and saved at once, no timer needed.
  await $.tool.call({ tool: 'mcp__project-brain__brain_remember', text: 'Refunds are issued from the payments service only', kind: 'convention' })
  await $.session.end({ reason: 'other', sessionId: 'sess-1', resume: { id: 'sess-1' } })
  expect(textsOf(w)).toContain('Refunds are issued from the payments service only')
})

test('the Brain pane without the hub, on terminal, desktop and vscode (mobile without a text field): active memories, graph, search, pin, edit, forget', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/db.ts`, old_string: 'a', new_string: 'export function getPool() {}' })
  await prompt($, 'orders in postgres: add an index')
  await w.clock.settle()
  expect(String((await brain($, '')).text)).toBe('Brain panel opened.')
  expect(w.opened).toEqual(['project-brain'])

  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ plugin: 'project-brain', surface, component: 'Pane', requestId: 'project-brain', props: PANE })
    expect(await ui.find({ type: 'Text', text: 'Active now' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Neighbourhood' })).toBeDefined()
    expect(await ui.find({ key: 'g-1' })).toBeDefined() // the centre and at least one link drawn
    expect(await ui.find({ key: 'search' })).toBeDefined()
    const row = await ui.find({ type: 'Text', text: 'Use Postgres for orders: Orders are stored in Postgres through the pool in src/db.ts.' })
    expect(row).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'project-brain', surface: 'terminal', component: 'Pane', requestId: 'project-brain', props: PANE })
  const id = String((await brain($, 'search postgres orders')).text).match(/\[(d\w+)\]/)?.[1] ?? ''
  expect(id).not.toBe('')
  await ui.press({ key: `pin-${id}` })
  expect(String((await brain($, 'stats')).text)).toContain('1 pinned')
  await ui.press({ key: `edit-btn-${id}` })
  await ui.input({ key: `edit-${id}`, text: 'Orders live in Postgres (src/db.ts); reads go to the replica' })
  expect(await ui.find({ type: 'Text', text: 'Orders live in Postgres (src/db.ts); reads go to the replica' })).toBeDefined()
  await ui.press({ key: `forget-${id}` })
  expect(await ui.find({ key: `mem-${id}` })).toBeUndefined()
  await ui.unmount()

  // Mobile has no text field: the search shows as text, the rest draws.
  const phone = await $.ui.mount({ plugin: 'project-brain', surface: 'mobile', component: 'Pane', requestId: 'project-brain', props: PANE })
  expect(await phone.find({ type: 'Text', text: 'Memories' })).toBeDefined()
  expect(await phone.find({ key: 'search' })).toBeUndefined()
  await phone.unmount()
  expect(String((await brain($, 'bogus')).text)).toContain('Usage: /brain')
})

/**
 * A stand-in for mods-hub: provides $.mods, answers what the brain calls, reports each call as a toast the test
 * sees (inline plugins run in an environment of their own: they share nothing with the test but the engine),
 * serves one decision another mod published, and draws the shared panel around the tab body.
 */
const standInHub: Plugin = {
  name: 'mods-hub',
  register(on) {
    on('engine.create', async ($, e, next) => {
      const built = await next(e)
      const bottom = async () => {
        throw new Error('the stand-in hub answers from its hooks')
      }
      const mods = { publish: bottom, recent: bottom, hello: bottom, registerTab: bottom, showTab: bottom, share: bottom, notify: bottom, mode: bottom }
      return { ...built, mods: mods as never }
    })
    on('mods.hello', () => ({ value: { installed: { hello: [], plugins: [], listedAt: null } } }))
    on('mods.registerTab', ($, e) => {
      $.ui.toast(`hub tab ${e.id}`)
      return { value: { tabs: [] } }
    })
    on('mods.showTab', async ($, e) => {
      await $.state.set({ plugin: 'mods-hub', key: 'tab' }, e.id)
      return { value: { isPlaced: true } }
    })
    on('mods.publish', ($, e) => {
      $.ui.toast(`hub publish ${e.topic} ${JSON.stringify(e.data)}`)
      return { value: { id: 'ev' } }
    })
    on('mods.recent', ($, e) => {
      const at = Date.UTC(2026, 9, 7, 9, 0) + 1
      const data = { title: 'Ship the mobile app with Expo', summary: 'one codebase for iOS and Android', path: 'docs/decisions/0002-expo.md' }
      const events = [{ id: 'e1', topic: 'decision.recorded', data, source: 'decision-log', at, session: 's', scope: 'session' as const }]
      return { value: events.filter(event => e.since === undefined || event.at > e.since) }
    })
    on('mods.share', ($, e) => {
      $.ui.toast(`hub share ${e.name}`)
      return { value: { key: `project-brain.${e.name}`, owner: 'project-brain', value: e.value, at: 0 } }
    })
    on('ui.render', { component: 'Pane', requestId: 'claude-mods' }, async ($, e, next) => {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Text>HUB STRIP</Text>
          {await next(e)}
        </Box>
      )
    })
  },
}

test('with the hub: a Brain tab, recalled events, shared facts, and decisions other mods publish', { timeoutMs: 20_000, plugins: [standInHub] }, async ($, on) => {
  const w = world(on)
  await start($)
  await startClock?.advance(1_500) // the hello waits for session.start to return (afterStart)
  await w.clock.settle()
  expect(w.toasts).toContain('hub tab brain')
  expect(w.toasts).toContain('hub share stats')

  await prompt($, 'how do we build the mobile app with expo?')
  await finish($, w, 'We build it with Expo as decided.', 't1')
  await w.clock.settle()
  expect(textsOf(w).length).toBe(0) // not saved yet (debounced)
  await w.clock.advance(6_000)
  expect(textsOf(w)).toContain('Ship the mobile app with Expo: one codebase for iOS and Android')

  await prompt($, 'expo build for the mobile app is failing')
  await w.clock.settle()
  const recalled = w.toasts.filter(toast => toast.startsWith('hub publish x.project-brain.recalled'))
  expect(recalled.length).toBeGreaterThan(0)
  expect(recalled.at(-1)).toContain('Ship the mobile app with Expo')

  expect(String((await brain($, '')).text)).toBe('Brain panel opened.')
  expect(w.opened).toEqual([]) // the hub's panel, not a pane of its own
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'mods-hub', surface, component: 'Pane', requestId: 'claude-mods', props: { ...PANE, title: 'Claude Mods' } })
    expect(await ui.find({ type: 'Text', text: 'HUB STRIP' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Active now' })).toBeDefined()
    await ui.unmount()
  }

  expect(String((await brain($, 'sleep')).text)).toMatch(/^Consolidated: /)
  expect(w.toasts.some(toast => toast.startsWith('hub publish x.project-brain.updated'))).toBe(true)
  expect(w.toasts).toContain('hub share top')
})
