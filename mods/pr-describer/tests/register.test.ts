import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseDescription } from '../hooks/describe'
import { fakeHub } from './hub'

const PLUGIN = 'pr-describer'
const PANE_PROPS = {
  title: 'Pull request',
  isFocused: true,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const
const USAGE = { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const REPLY = 'TITLE: Add token refresh to the auth client\n---\n## Summary\nRefreshes tokens before they expire.\n\n## Risks\nLow.'

type World = {
  refs: Set<string>
  ahead: number
  files: Record<string, string>
  prompts: { system: string; prompt: string }[]
  copies: { text: string; surface: string | undefined }[]
  fills: { text: string; mode?: string }[]
  modelDeny?: string
}

const world = (on: On, overrides: Partial<World> = {}): World => {
  const state: World = { refs: new Set(['origin/main']), ahead: 2, files: {}, prompts: [], copies: [], fills: [], ...overrides }
  on('process.run', ($, e) => {
    const args = e.argv.slice(1)
    const line = args.join(' ')
    const answer = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (line === 'rev-parse --show-toplevel') return answer('/work/app\n')
    if (line.startsWith('symbolic-ref')) return state.refs.has('origin/main') ? answer('origin/main\n') : answer('', 1)
    if (args[0] === 'rev-parse' && args[1] === '--verify') return answer('', state.refs.has((args[3] ?? '').replace('^{commit}', '')) ? 0 : 1)
    if (args[0] === 'merge-base') return answer('base123\n')
    if (line === 'rev-parse --abbrev-ref HEAD') return answer('feature/refresh\n')
    if (args[0] === 'rev-list') return answer(`${state.ahead}\n`)
    if (args[0] === 'log') return answer('- a1 feat(auth): add refresh\n- b2 test(auth): cover expiry\n')
    if (args[0] === 'diff' && args[1] === '--stat=100') return answer(' src/auth.ts | 40 ++++\n 2 files changed, 52 insertions(+), 3 deletions(-)\n')
    if (args[0] === 'diff') return answer('diff --git a/src/auth.ts b/src/auth.ts\n+refresh()\n')
    if (args[0] === 'status') return answer(' M README.md\n')
    return answer('')
  })
  on('fs.read', ($, e) => {
    const name = e.path.replace('/work/app/', '')
    return name in state.files ? { value: state.files[name] as string } : { deny: 'ENOENT' }
  })
  on('model.complete', ($, e) => {
    state.prompts.push({ system: e.system ?? '', prompt: e.prompt })
    if (state.modelDeny !== undefined) return { deny: state.modelDeny }
    return { value: { isAnswered: true, text: REPLY, usage: USAGE } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.copy', ($, e) => {
    state.copies.push({ text: e.text, surface: e.surface })
    return { value: { isCopied: true } }
  })
  on('prompt.fill', ($, e) => {
    state.fills.push({ text: e.text, mode: e.mode })
    return { isFilled: true }
  })
  on('ui.toast', () => ({ value: undefined }))
  return state
}

const runPrDesc = ($: Engine, args = '') =>
  $.command.run({ command: 'pr-desc', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

const mountPane = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'pr-desc', props: PANE_PROPS })

test('drafts the title and the four sections from the branch, against origin/HEAD', async ($, on) => {
  const state = world(on)
  expect((await runPrDesc($)).text).toBe('pr-describer: description ready in the Pull request pane.')
  const [ask] = state.prompts
  expect(ask?.system).toContain('## Summary')
  expect(ask?.system).toContain('## Risks')
  expect(ask?.prompt).toContain('Branch `feature/refresh` into `origin/main`.')
  expect(ask?.prompt).toContain('feat(auth): add refresh')
  expect(ask?.prompt).toContain('+refresh()')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect((await ui.find({ key: 'title' }))?.text).toContain('Add token refresh to the auth client')
    expect((await ui.find({ type: 'Markdown' }))?.text).toContain('Refreshes tokens before they expire.')
    expect(await ui.find({ type: 'Text', text: '2 commits · 2 files changed, 52 insertions(+), 3 deletions(-)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Uncommitted changes are not part of the description.' })).toBeDefined()
    await ui.unmount()
  }
})

test('copies the parts and inserts the description into the prompt', async ($, on) => {
  const state = world(on)
  await runPrDesc($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    await ui.press({ key: 'copy-title' })
    expect(state.copies.at(-1)).toEqual({ text: 'Add token refresh to the auth client', surface })
    await ui.press({ key: 'copy-all' })
    expect(state.copies.at(-1)?.text.startsWith('Add token refresh to the auth client\n\n## Summary')).toBe(true)
    await ui.unmount()
  }
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'insert' })
  expect(state.fills.at(-1)?.mode).toBe('append')
  expect(state.fills.at(-1)?.text).toContain('Open a pull request from `feature/refresh` into `main`')
  expect(state.fills.at(-1)?.text).toContain('Title: Add token refresh to the auth client')
})

test('fills in the repository pull request template', async ($, on) => {
  const template = '## What\n<!-- describe -->\n\n## Checklist\n- [ ] Tests added'
  const state = world(on, { files: { '.github/pull_request_template.md': template } })
  await runPrDesc($, 'main')
  expect(state.prompts[0]?.system).toContain('.github/pull_request_template.md')
  expect(state.prompts[0]?.system).toContain('- [ ] Tests added')
  expect(state.prompts[0]?.system).not.toContain('## Summary:')
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: 'template: .github/pull_request_template.md' })).toBeDefined()
})

test('explains when there is nothing to describe or no base', async ($, on) => {
  world(on, { ahead: 0 })
  expect((await runPrDesc($)).text).toBe('pr-describer: HEAD has no commits ahead of origin/main.')
  expect((await runPrDesc($, 'release')).text).toBe('pr-describer: no branch named release or origin/release.')
})

test('reads the title and body back from the answer, with or without the marker', () => {
  expect(parseDescription('TITLE: Fix login.\n---\n## Summary\nx')).toEqual({ title: 'Fix login', body: '## Summary\nx' })
  expect(parseDescription('```markdown\n**Title:** Add docs\n\nBody here\n```')).toEqual({ title: 'Add docs', body: 'Body here' })
  expect(parseDescription('# Rework the cache\n\n## Summary\ny')).toEqual({ title: 'Rework the cache', body: '## Summary\ny' })
})

test('a refused model call ends in an error the pane shows, with Regenerate and Close, not a stuck "writing"', async ($, on) => {
  world(on, { modelDeny: 'unknown model "sonet"' })
  expect((await runPrDesc($)).text).toContain('no description: ')
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'error' }))?.text).toContain('unknown model')
  expect(await ui.find({ key: 'regenerate' })).toBeDefined()
  expect(await ui.find({ key: 'close' })).toBeDefined()
  await ui.unmount()
})

test('with mods-hub: a newer commit on the branch marks the draft stale, and the opened pull request is published', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  world(on)
  const hub = fakeHub(on)
  let latestCommit: unknown = null
  on('state.get', { plugin: 'mods-hub', key: 'latest', id: 'git.commit' }, () => ({ value: { value: latestCommit as never, version: 1 } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.call', () => ({ result: { stdout: 'https://github.com/acme/app/pull/42\n', stderr: '', interrupted: false }, text: 'https://github.com/acme/app/pull/42\n' }))

  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['pr.opened'], consumes: ['git.commit'] }])
  await runPrDesc($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ key: 'stale' })).toBeUndefined()
    await ui.unmount()
  }

  await clock.advance(5_000)
  // A commit on another branch says nothing about this draft.
  latestCommit = { id: 'e1', topic: 'git.commit', source: 'commit-composer', at: clock.now(), session: 's1', scope: 'global', data: { sha: 'ffff000', message: 'chore: elsewhere', branch: 'main', files: 1 } }
  let ui = await mountPane($, 'terminal')
  expect(await ui.find({ key: 'stale' })).toBeUndefined()
  await ui.unmount()

  latestCommit = { id: 'e2', topic: 'git.commit', source: 'commit-composer', at: clock.now(), session: 's1', scope: 'global', data: { sha: 'c0ffee1234', message: 'fix(auth): retry once\n\nbody', branch: 'feature/refresh', files: 1 } }
  for (const surface of ['terminal', 'desktop'] as const) {
    ui = await mountPane($, surface)
    expect((await ui.find({ key: 'stale' }))?.text).toBe('New commit since this draft (c0ffee1 fix(auth): retry once): Regenerate to include it.')
    await ui.unmount()
  }

  await $.tool.call({ tool: 'Bash', command: 'gh pr create --base main --title "whatever" --body-file /tmp/body.md' })
  await clock.advance(0)
  expect(hub.published).toEqual([
    { topic: 'pr.opened', data: { url: 'https://github.com/acme/app/pull/42', title: 'Add token refresh to the auth client', branch: 'feature/refresh' }, scope: 'global' },
  ])
})
