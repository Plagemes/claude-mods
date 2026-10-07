import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'
import type { On, RenderPropsOf, SessionContextUsage, SessionUsage } from 'claude-code'

const NOW = new Date(2026, 9, 7, 12, 0, 0).getTime()
const ROOT = '/work/app'
const PANE: RenderPropsOf['Pane'] = { title: 'Context', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} }
const BAND: RenderPropsOf['AbovePrompt'] = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} }
const BIG = Array.from({ length: 3_000 }, (_, i) => `line ${i}: ${'x'.repeat(30)}`).join('\n')
const CONVERSATION = [{ role: 'user' as const, text: 'hello', toolUses: [] }]
const SUMMARY = [{ role: 'user' as const, text: 'Summary of the conversation so far.', toolUses: [] }]
const FILE = Array.from({ length: 300 }, (_, i) => `export const v${i} = ${i}`).join('\n')

type World = ReturnType<typeof world>

/** The engine beneath the plugins. `enabled` stands for the user settings' enabledPlugins. */
function world(on: On, enabled: Record<string, boolean> = {}) {
  const clock = mock.clock(on, { now: NOW })
  const toasts: string[] = []
  const opened: string[] = []
  const ids: string[] = []
  const appended: unknown[] = []
  const compactions: { trigger: string; instructions?: string }[] = []
  const prompts: { text: string; context?: readonly string[] }[] = []
  const commands: string[] = []
  let percent = 50
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('settings.read', () => ({ value: { enabledPlugins: enabled } as never }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: FILE.length, mtimeMs: 1_000, isLink: false } }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      rateLimits: [],
      context: { window: 200_000, tokens: percent * 2_000, percent, breakdown: { categories: [{ name: 'Messages', tokens: 90_000, kind: 'used' }, { name: 'System tools', tokens: 12_000, kind: 'used' }, { name: 'Free space', tokens: 98_000, kind: 'free' }] } },
    } as unknown as SessionUsage,
  }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('prompt.submit', ($, e) => {
    prompts.push({ text: e.text, ...(e.context === undefined ? {} : { context: e.context }) })
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  on('session.append', async ($, e, next) => {
    appended.push(e.message)
    try {
      return await next(e)
    } catch {
      return { message: e.message, uuid: e.uuid }
    }
  })
  on('session.compact', ($, e) => {
    compactions.push({ trigger: e.trigger, ...(e.instructions === undefined ? {} : { instructions: e.instructions }) })
    return { messages: SUMMARY, tokensBefore: 150_000, tokensAfter: 22_000 }
  })
  // The engine's /compact; its own session.compact is not raised here (a test hook may not call $.session.compact).
  on('command.run', { command: 'compact' }, ($, e) => {
    commands.push(`compact ${e.args}`)
    return { text: 'Compacted.' }
  })
  on('tool.call', ($, e) => {
    ids.push(e.tool_use_id)
    return { result: { stdout: 'ok', stderr: '', interrupted: false }, text: e.tool === 'Bash' && String(e.command).includes('vitest') ? 'Tests  41 passed (41)' : 'ok' }
  })
  const setPercent = (value: number) => {
    percent = value
  }
  return { clock, toasts, opened, ids, appended, compactions, prompts, commands, setPercent }
}

const start = async ($: Engine, w: World) => {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await w.clock.settle()
}

/** A tool call and its result row, as the engine appends it; answers the stored row's text. */
async function call($: Engine, w: World, input: { tool: string; [field: string]: unknown }, output: string): Promise<string> {
  await $.tool.call(input as never)
  const id = w.ids.at(-1) ?? 'x'
  return append($, w, { door: 'tool-result', origin: { kind: 'tool', tool: input.tool }, uuid: `row-${id}`, message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output }] } })
}

/** Appends a row as the engine does; answers the text of its first block as the plugins handed it down. */
async function append($: Engine, w: World, row: Record<string, unknown>): Promise<string> {
  await $.session.append(row as never).catch(() => undefined)
  await w.clock.settle()
  const message = w.appended.at(-1) as { content: { content: unknown }[] }
  return String(message.content[0]?.content)
}

const measure = async ($: Engine, w: World, percent: number) => {
  w.setPercent(percent)
  const context: SessionContextUsage = { tokens: percent * 2_000, window: 200_000, percent }
  await $.session.measure({ context, rateLimits: [], changed: ['context'] })
  await w.clock.settle()
}

const turn = async ($: Engine, w: World, id: string, work: () => Promise<unknown>) => {
  await $.turn.start({ turnId: id, text: 'go' })
  await work()
  await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: id, reason: 'answer' } as never)
  await w.clock.settle()
}

const ctx = async ($: Engine, args = '') =>
  String((await $.command.run({ command: 'ctx', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 } })).text)

test('trims noisy results, dedupes an unchanged re-read, and leaves Bash to output-trimmer when it is installed', async ($, on) => {
  const w = world(on, { 'output-trimmer@claude-mods': true })
  await start($, w)

  const grep = await call($, w, { tool: 'Grep', pattern: 'line' }, BIG)
  expect(grep.length).toBeLessThan(12_000)
  expect(grep).toContain('[context-optimizer: lines')
  expect(await call($, w, { tool: 'Bash', command: 'cat build.log' }, BIG)).toBe(BIG)

  expect(await call($, w, { tool: 'Read', file_path: `${ROOT}/src/big.ts` }, FILE)).toBe(FILE)
  const again = await call($, w, { tool: 'Read', file_path: `${ROOT}/src/big.ts` }, FILE)
  expect(again).toContain('already read src/big.ts at turn 0; unchanged since')
  // Asked once more right after the note: Claude no longer has it, so it comes through whole.
  expect(await call($, w, { tool: 'Read', file_path: `${ROOT}/src/big.ts` }, FILE)).toBe(FILE)
  // Another range of the same file is another read.
  expect(await call($, w, { tool: 'Read', file_path: `${ROOT}/src/big.ts`, offset: 10, limit: 20 }, FILE)).toBe(FILE)

  const text = await ctx($)
  expect(text).toContain('1 result trimmed, 1 repeated read left out')
  expect(w.opened).toEqual(['context-optimizer'])
})

test('without output-trimmer, Bash results are trimmed too; subagent rows are left alone', async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(await call($, w, { tool: 'Bash', command: 'cat build.log' }, BIG)).toContain('[context-optimizer: lines')
  const sub = await append($, w, { door: 'tool-result', origin: { kind: 'tool', tool: 'Grep' }, uuid: 'sub-1', agentId: 'agent-1', message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'sub-call', content: BIG }] } })
  expect(sub).toBe(BIG)
})

test('a task boundary at 72% suggests /compact with a focus; autoCompact runs it once idle; the carry-over comes back after', { options: { autoCompact: true, idleSeconds: 30 } }, async ($, on) => {
  const w = world(on)
  await start($, w)
  await measure($, w, 72)
  await $.prompt.submit({ text: "Let's keep the API backwards compatible. Add the password reset flow.", wait: false, origin: { kind: 'composer' } })

  await turn($, w, 't1', async () => {
    await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Add the reset email', status: 'completed', activeForm: 'x' }, { content: 'Write the migration', status: 'pending', activeForm: 'y' }] })
    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/auth.ts`, old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Bash', command: 'git commit -am "reset email"' })
  })
  // A commit in the middle of a todo list is no boundary.
  expect(w.toasts.filter(text => text.includes('Good moment'))).toEqual([])

  await turn($, w, 't2', async () => {
    await $.tool.call({ tool: 'Bash', command: 'npx vitest run' })
    await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Add the reset email', status: 'completed', activeForm: 'x' }, { content: 'Write the migration', status: 'completed', activeForm: 'y' }] })
  })
  expect(w.toasts.some(text => text.startsWith('Good moment to /compact (72% full, the todo list is done) — /compact Keep the decisions'))).toBe(true)

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'context-optimizer', surface, component: 'AbovePrompt', props: BAND })
    expect(await band.find({ key: 'band-compact' })).toBeDefined()
    await band.unmount()
  }

  await w.clock.advance(31_000)
  expect(w.commands).toHaveLength(1)
  expect(w.commands[0]).toContain("compact Keep the decisions (Let's keep the API backwards compatible.)")
  expect(w.commands[0]).toContain('the files in play (src/auth.ts)')
  expect(w.commands[0]).not.toContain('the open todos')

  await $.prompt.submit({ text: 'What next?', wait: false, origin: { kind: 'composer' } })
  const after = w.prompts.at(-1)
  expect(after?.context?.[0]).toContain('[context-optimizer] Carry-over saved before the conversation was compacted')
  expect(after?.context?.[0]).toContain("- Decisions: Let's keep the API backwards compatible.")
  expect(after?.context?.[0]).toContain('- Last test run: ✓ 41 passed')
  expect(await ctx($)).toContain('Compactions this session: 1.')
  await $.prompt.submit({ text: 'And then?', wait: false, origin: { kind: 'composer' } })
  expect(w.prompts.at(-1)?.context).toBeUndefined()

  const band = await $.ui.mount({ plugin: 'context-optimizer', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ key: 'band-compact' })).toBeUndefined()
  await band.unmount()
})

test('the person’s own /compact: the summary is told what to keep, and Claude gets it back once; carryOver off keeps out of it', async ($, on) => {
  const w = world(on)
  await start($, w)
  await $.prompt.submit({ text: 'Never touch the generated client in src/gen.', wait: false, origin: { kind: 'composer' } })
  await turn($, w, 't1', () => $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/api.ts`, content: 'x' }))

  await $.session.compact({ trigger: 'manual', instructions: 'focus on the API', messages: CONVERSATION })
  expect(w.compactions[0]?.instructions).toContain('focus on the API\n\ncontext-optimizer: the summary must keep these')
  expect(w.compactions[0]?.instructions).toContain('- Files in play: src/api.ts')
  await $.prompt.submit({ text: 'continue', wait: false, origin: { kind: 'composer' } })
  expect(w.prompts.at(-1)?.context?.[0]).toContain('- Decisions: Never touch the generated client in src/gen.')
  expect(await ctx($)).toContain('Compactions this session: 1.')
})

test('carryOver off: no instructions added, nothing re-injected', { options: { carryOver: false } }, async ($, on) => {
  const w = world(on)
  await start($, w)
  await $.prompt.submit({ text: 'Never touch the generated client in src/gen.', wait: false, origin: { kind: 'composer' } })
  await $.session.compact({ trigger: 'manual', messages: CONVERSATION })
  expect(w.compactions[0]?.instructions).toBeUndefined()
  await $.prompt.submit({ text: 'continue', wait: false, origin: { kind: 'composer' } })
  expect(w.prompts.at(-1)?.context).toBeUndefined()
})

test('the Context pane on every surface: gauge, contributors, savings, history, switches', async ($, on) => {
  const w = world(on)
  await start($, w)
  await measure($, w, 64)
  await call($, w, { tool: 'Grep', pattern: 'x' }, BIG)
  await call($, w, { tool: 'Read', file_path: `${ROOT}/src/big.ts` }, FILE)
  await $.session.compact({ trigger: 'auto', messages: CONVERSATION })
  await call($, w, { tool: 'Glob', pattern: '**' }, 'a.ts\nb.ts')
  await ctx($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-optimizer', surface, component: 'Pane', requestId: 'context-optimizer', props: PANE })
    expect(await ui.find({ type: 'Text', text: 'Context' })).toBeDefined()
    expect(await ui.find({ key: 'tool-Glob' })).toBeDefined()
    expect(await ui.find({ key: 'tool-Grep' })).toBeUndefined()
    expect(await ui.find({ key: 'compaction-0' })).toBeDefined()
    expect((await ui.find({ key: 'pref-autoCompact' }))?.text).toContain('off')
    await ui.press({ key: 'pref-autoCompact' })
    expect((await ui.find({ key: 'pref-autoCompact' }))?.text).toContain('on')
    await ui.press({ key: 'pref-autoCompact' })
    await ui.unmount()
  }
  for (const surface of ['mobile', 'vscode'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-optimizer', surface, component: 'Pane', requestId: 'context-optimizer', props: { ...PANE, bodyColumns: 44 } })
    expect(await ui.find({ key: 'context-body' })).toBeDefined()
    await ui.unmount()
  }
})

/** A stand-in for mods-hub: the `$.mods` noun with a bus, the latest event per topic, a tab. */
const hub: Plugin = {
  name: 'mods-hub',
  register(on) {
    const events: { id: string; topic: string; data: unknown; source: string; at: number; session: string; scope: 'session' }[] = []
    const fn = async () => undefined
    on('engine.create', async ($, e, next) => ({
      ...(await next(e)),
      mods: { publish: fn, recent: fn, latest: fn, notify: fn, mode: fn, hello: fn, installed: fn, registerTab: fn, showTab: fn, share: fn, read: fn } as never,
    }))
    on('mods.publish', async ($, e, next) => {
      events.push({ id: String(events.length + 1), topic: e.topic, data: e.data, source: next.origin.plugin, at: await $.clock.now(), session: 's', scope: 'session' })
      $.ui.toast(`hub got ${e.topic} from ${next.origin.plugin}`)
      return { value: { id: String(events.length) } }
    })
    on('mods.recent', ($, e) => ({ value: events.filter(event => event.topic === e.topic) as never }))
    on('mods.latest', ($, e) => ({ value: (events.filter(event => event.topic === e.topic).at(-1) ?? null) as never }))
    on('mods.notify', ($, e, next) => {
      $.ui.toast(`notify ${e.level} from ${next.origin.plugin}: ${e.title}`)
      return { value: { id: 'n', targets: ['toast'], held: false } }
    })
    on('mods.hello', () => ({ value: { installed: { hello: [], plugins: [], listedAt: null } } }))
    on('mods.installed', () => ({ value: { hello: [], plugins: [{ name: 'output-trimmer', marketplace: 'claude-mods', version: '1.0.0', isEnabled: true }], listedAt: 1 } }))
    on('mods.registerTab', ($, e) => {
      $.ui.toast(`tab ${e.id}`)
      return { value: { tabs: [] } }
    })
    on('mods.showTab', async ($, e) => {
      await $.state.set({ plugin: 'mods-hub', key: 'tab' }, e.id)
      return { value: { isPlaced: true } }
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

test('with mods-hub: context.pressure once per step, saved tokens on the bus, the Context tab in the shared panel', { plugins: [hub] }, async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(w.toasts).toContain('tab context')

  await measure($, w, 72)
  await measure($, w, 74)
  await measure($, w, 86)
  expect(w.toasts.filter(text => text === 'hub got context.pressure from context-optimizer')).toHaveLength(2)

  // The hub says output-trimmer is installed: Bash is its job; Grep is still trimmed.
  await turn($, w, 't1', async () => {
    expect(await call($, w, { tool: 'Bash', command: 'cat x.log' }, BIG)).toBe(BIG)
    expect(await call($, w, { tool: 'Grep', pattern: 'x' }, BIG)).toContain('[context-optimizer:')
  })
  expect(w.toasts).toContain('hub got x.context-optimizer.saved from context-optimizer')

  await turn($, w, 't2', () => $.tool.call({ tool: 'Bash', command: 'git commit -m done' }))
  expect(w.toasts.some(text => text.startsWith('notify info from context-optimizer: Good moment to /compact (86% full, after a commit)'))).toBe(true)

  await ctx($)
  expect(w.opened).toEqual([])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'mods-hub', surface, component: 'Pane', requestId: 'claude-mods', props: { ...PANE, title: 'Claude Mods' } })
    expect(await ui.find({ type: 'Text', text: 'HUB STRIP' })).toBeDefined()
    expect(await ui.find({ key: 'context-body' })).toBeDefined()
    expect(await ui.find({ key: 'compact-now' })).toBeDefined()
    await ui.unmount()
  }
})
