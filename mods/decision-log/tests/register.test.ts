import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandRunInput, FsEntry, ModelForkResult, On, RenderPropsOf } from 'claude-code'

import { fakeHub } from './hub'

const ROOT = '/home/me/shop'
const FOLDER = `${ROOT}/docs/decisions`
const USAGE = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 }
const ADR_BODY = '## Context\nEvents pile up.\n\n## Decision\nUse Postgres.\n\n## Consequences\nOne more table.\n\n## Alternatives considered\n- Kafka'
const PANE: RenderPropsOf['Pane'] = {
  title: 'ADR',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

type World = { files: Map<string, string>; forks: string[]; opened: string[]; closed: string[]; toasts: string[] }

const typed = (command: string, args = ''): CommandRunInput => ({
  command,
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
})

/** A project whose docs/decisions folder is `files`, and a fork answering `reply`. */
function world(on: On, reply: ModelForkResult, files: Record<string, string> = {}): World {
  const seen: World = { files: new Map(Object.entries(files)), forks: [], opened: [], closed: [], toasts: [] }
  on('session.root', () => ({ value: ROOT }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.list', ($, e) => {
    if (e.path !== FOLDER) return { deny: 'ENOENT' }
    const entries: FsEntry[] = [...seen.files.keys()].map(name => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false }))
    return { value: entries }
  })
  on('fs.read', ($, e) => {
    const text = seen.files.get(e.path.slice(FOLDER.length + 1))
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.write', ($, e) => {
    seen.files.set(e.path.slice(FOLDER.length + 1), e.text)
    return { value: undefined }
  })
  on('model.fork', ($, e) => {
    seen.forks.push(e.prompt)
    return { value: reply }
  })
  on('ui.open', ($, e) => {
    seen.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    seen.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  return seen
}

async function decide($: Engine, title: string): Promise<string | undefined> {
  return (await $.command.run(typed('decide', title))).text
}

test('drafts an ADR from the conversation, previews it in a pane and saves the next number', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 7, 12) })
  const seen = world(on, { isAnswered: true, text: `Sure! Here it is:\n\n${ADR_BODY}`, usage: USAGE }, {
    '0001-record-decisions.md': '# 1. Record decisions\n',
    '0002-use-typescript.md': '# 2. Use TypeScript\n',
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const started = await decide($, 'Use Postgres for events')
    expect(started).toContain('drafting ADR')
    expect(seen.opened.at(-1)).toBe('decision-log')

    const ui = await $.ui.mount({ plugin: 'decision-log', surface, component: 'Pane', requestId: 'decision-log', props: PANE })
    expect((await ui.find({ type: 'Text', text: /Drafting/ }))?.text).toContain('Drafting')

    await clock.advance(0)
    const preview = await ui.find({ key: 'adr' })
    expect(preview?.text).toContain('Use Postgres for events')
    expect(preview?.text).toContain('- Status: Accepted')
    expect(preview?.text).toContain('- Date: 2026-10-07')
    expect(preview?.text).not.toContain('Sure!')

    await ui.press({ key: 'save' })
    expect((await ui.find({ type: 'Text', text: /Saved/ }))?.text).toContain('docs/decisions/')
    await ui.press({ key: 'close' })
    expect(seen.closed.at(-1)).toBe('decision-log')
    await ui.unmount()
  }

  expect(seen.forks[0]).toContain('"Use Postgres for events"')
  const saved = seen.files.get('0003-use-postgres-for-events.md')
  expect(saved?.startsWith('# 0003. Use Postgres for events\n\n- Status: Accepted\n- Date: 2026-10-07\n\n## Context')).toBe(true)
  expect(seen.files.has('0004-use-postgres-for-events.md')).toBe(true)
  expect(seen.toasts[0]).toBe('✅ decision-log: saved docs/decisions/0003-use-postgres-for-events.md')
})

test('explains when there is nothing to draft from, and Retry drafts again', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { isAnswered: false, reason: 'nothing-to-fork' })

  for (const surface of ['terminal', 'desktop'] as const) {
    await decide($, 'Adopt trunk-based development')
    await clock.advance(0)
    const ui = await $.ui.mount({ plugin: 'decision-log', surface, component: 'Pane', requestId: 'decision-log', props: PANE })
    expect((await ui.find({ type: 'Text', text: /no conversation/ }))?.text).toContain('Discuss the decision')

    const forks = seen.forks.length
    await ui.press({ key: 'retry' })
    expect((await ui.find({ type: 'Text', text: /Drafting/ }))?.text).toContain('Drafting')
    await clock.advance(0)
    expect(seen.forks).toHaveLength(forks + 1)
    await ui.press({ key: 'close' })
    await ui.unmount()
  }
  expect(seen.files.size).toBe(0)
})

test('/decisions lists titles with status and date; /decide alone shows usage', async ($, on) => {
  world(on, { isAnswered: false, reason: 'empty-reply', usage: USAGE }, {
    '0001-record-decisions.md': '# 1. Record architecture decisions\n\n- Status: Accepted\n- Date: 2026-01-02\n',
    '0002-use-kafka.md': '# 0002. Use Kafka\n\n- Status: Superseded\n',
    'README.md': '# Decisions',
  })

  const listed = (await $.command.run(typed('decisions'))).text
  expect(listed).toBe(
    '📚 2 decisions in docs/decisions\n0001. Record architecture decisions (Accepted, 2026-01-02)\n0002. Use Kafka (Superseded)',
  )
  expect(await decide($, '')).toContain('usage /decide <title>')
})

test('/decisions says so when the folder does not exist', { options: { directory: 'adr' } }, async ($, on) => {
  world(on, { isAnswered: false, reason: 'empty-reply', usage: USAGE })

  expect((await $.command.run(typed('decisions'))).text).toContain('no decisions in adr yet')
})

test('with mods-hub: a saved ADR is published as decision.recorded for every session', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 7, 12) })
  const seen = world(on, { isAnswered: true, text: ADR_BODY, usage: USAGE })
  const hub = fakeHub(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['decision.recorded'], consumes: [] }])

  await decide($, 'Use Postgres for events')
  await clock.advance(0)
  const ui = await $.ui.mount({ plugin: 'decision-log', surface: 'terminal', component: 'Pane', requestId: 'decision-log', props: PANE })
  await ui.press({ key: 'save' })
  await ui.unmount()

  expect(seen.toasts).toEqual(['✅ decision-log: saved docs/decisions/0001-use-postgres-for-events.md'])
  expect(hub.published).toEqual([
    {
      topic: 'decision.recorded',
      data: { title: 'Use Postgres for events', path: 'docs/decisions/0001-use-postgres-for-events.md', status: 'Accepted', summary: 'Use Postgres.' },
      scope: 'global',
    },
  ])
})
