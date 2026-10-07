import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fakeHub } from './hub'

const PLUGIN = 'commit-composer'
const PANE_PROPS = {
  title: 'Commit',
  isFocused: true,
  bodyColumns: 90,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const
const USAGE = { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const DIFF = 'diff --git a/src/auth.ts b/src/auth.ts\n+export const refresh = () => token\n'

type World = {
  staged: boolean
  replies: string[]
  calls: string[]
  prompts: { system: string; prompt: string }[]
  files: Record<string, string>
  committed: string
}

/** A repository with a staged change, a model that answers from `replies`, and a pane that opens. */
const world = (on: On, overrides: Partial<World> = {}): World => {
  const state: World = { staged: true, replies: [], calls: [], prompts: [], files: {}, committed: '', ...overrides }
  on('process.run', ($, e) => {
    const line = e.argv.slice(1).join(' ')
    state.calls.push(line)
    const answer = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (line === 'rev-parse --show-toplevel') return answer('/work/app\n')
    if (line === 'diff --cached --quiet') return answer('', state.staged ? 1 : 0)
    if (line === 'status --porcelain') return answer(' M src/a.ts\n?? src/b.ts\n')
    if (line === 'add -A') {
      state.staged = true
      return answer('')
    }
    if (line === 'diff --cached --name-status') return answer('M\tsrc/auth.ts\n')
    if (line === 'diff --cached --stat') return answer(' src/auth.ts | 4 +++-\n 1 file changed, 3 insertions(+), 1 deletion(-)\n')
    if (line.startsWith('diff --cached --no-color')) return answer(DIFF)
    if (line.startsWith('log -n')) return answer('feat(ui): add dark mode\nfix(api): handle empty body\n')
    if (line.startsWith('commit -m')) {
      state.committed = e.argv[3] ?? ''
      return answer('[main abc1234] done\n')
    }
    if (line.startsWith('log -1')) return answer(`abc1234 ${state.committed.split('\n')[0]}\n`)
    if (line === 'rev-parse HEAD') return answer('abc1234def5678\n')
    if (line === 'rev-parse --abbrev-ref HEAD') return answer('feat/auth\n')
    if (line === 'show --name-only --format= HEAD') return answer('src/auth.ts\nsrc/token.ts\n')
    return answer('')
  })
  on('fs.read', ($, e) => {
    const name = e.path.replace('/work/app/', '')
    return name in state.files ? { value: state.files[name] as string } : { deny: `ENOENT: ${e.path}` }
  })
  on('model.complete', ($, e) => {
    state.prompts.push({ system: e.system ?? '', prompt: e.prompt })
    const text = state.replies.shift()
    return { value: text === undefined ? { isAnswered: false, reason: 'empty-reply', usage: USAGE } : { isAnswered: true, text, usage: USAGE } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  return state
}

const runCommit = ($: Engine, args = '') =>
  $.command.run({ command: 'commit', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

const mountPane = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'commit', props: PANE_PROPS })

test('with nothing staged it offers /commit all, which stages everything', async ($, on) => {
  const state = world(on, { staged: false, replies: ['chore: tidy up'] })
  expect((await runCommit($)).text).toBe(
    'commit-composer: nothing is staged. Stage files with git add, or run /commit all to stage all 2 changed files.',
  )
  expect((await runCommit($, 'all')).text).toBe('commit-composer: draft ready in the Commit pane.')
  expect(state.calls).toContain('add -A')
})

test('drafts a Conventional Commit from the staged diff and commits it from the pane', async ($, on) => {
  const reply = '```\nfeat(auth): add token refresh\n- refresh tokens before they expire\n```'
  const state = world(on, { replies: [reply, reply] })
  for (const surface of ['terminal', 'desktop'] as const) {
    await runCommit($)
    expect(state.prompts.at(-1)?.system).toContain('Conventional Commits')
    expect(state.prompts.at(-1)?.prompt).toContain(DIFF.trim())
    expect(state.prompts.at(-1)?.prompt).toContain('fix(api): handle empty body')

    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: 'feat(auth): add token refresh' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1 file · +3 −1' })).toBeDefined()
    expect((await ui.findAll({ type: 'Button' })).map(button => button.text)).toEqual(['Commit', 'Regenerate', 'Edit', 'Cancel'])

    await ui.press({ key: 'commit' })
    expect(state.calls).toContain('commit -m feat(auth): add token refresh\n\n- refresh tokens before they expire')
    expect((await ui.find({ key: 'result' }))?.text).toBe('✓ Committed abc1234 feat(auth): add token refresh')
    await ui.unmount()
  }
})

test('Regenerate asks again, and Edit rewrites the subject and re-checks it', async ($, on) => {
  const state = world(on, { replies: ['fix: first try', 'fix(auth): refresh expired tokens'] })
  await runCommit($)
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'regenerate' })
  expect(state.prompts).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: 'fix(auth): refresh expired tokens' })).toBeDefined()

  await ui.press({ key: 'edit' })
  await ui.input({ key: 'subject', text: 'Fixed the auth token refresh logic that was broken in production.' })
  expect(await ui.find({ type: 'Text', text: 'Fixed the auth token refresh logic' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'is not `type(scope): subject`' })).toBeDefined()
})

test('follows the commitlint configuration of the repository', async ($, on) => {
  const config = JSON.stringify({ rules: { 'type-enum': [2, 'always', ['feat', 'fix']], 'header-max-length': [2, 'always', 50] } })
  const state = world(on, { replies: ['chore(deps): bump the very long dependency list to latest'], files: { '.commitlintrc.json': config } })
  await runCommit($)
  expect(state.prompts[0]?.system).toContain('<type> is one of feat, fix.')
  expect(state.prompts[0]?.system).toContain('at most 50 characters')
  expect(state.prompts[0]?.system).toContain('.commitlintrc.json')

  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: 'the first line is 57 characters (max 50)' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '"chore" is not one of feat, fix' })).toBeDefined()
})

test('a model that does not answer leaves Regenerate and Cancel', async ($, on) => {
  world(on, { replies: [] })
  expect((await runCommit($)).text).toBe('commit-composer: No message: empty-reply.')
  const ui = await mountPane($, 'desktop')
  expect((await ui.findAll({ type: 'Button' })).map(button => button.text)).toEqual(['Regenerate', 'Cancel'])
})

test('with mods-hub: a commit made from the pane is published as git.commit', async ($, on) => {
  const state = world(on, { replies: ['feat(auth): add token refresh'] })
  const hub = fakeHub(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))

  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['git.commit'], consumes: [] }])
  await runCommit($)
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'commit' })
  await ui.unmount()

  expect(state.committed).toBe('feat(auth): add token refresh')
  expect(hub.published).toEqual([
    { topic: 'git.commit', data: { sha: 'abc1234def5678', message: 'feat(auth): add token refresh', branch: 'feat/auth', files: 2 }, scope: 'global' },
  ])
})

test('without mods-hub a commit runs no extra git command', async ($, on) => {
  const state = world(on, { replies: ['fix: x'] })
  await runCommit($)
  const ui = await mountPane($, 'desktop')
  await ui.press({ key: 'commit' })
  await ui.unmount()
  expect(state.calls).not.toContain('rev-parse HEAD')
})
