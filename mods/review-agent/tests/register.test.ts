import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { countSeverities, describeCounts, whyNotReadOnly } from '../hooks/review'

const DIFF = 'diff --git a/src/pay.ts b/src/pay.ts\n@@ -1,2 +1,2 @@\n-const fee = 1\n+const fee = amount * 0.1\n'
const REPORT = [
  '## Summary',
  'Adds a percentage fee. Ship with fixes.',
  '',
  '## Findings',
  '### [major] Fee is not rounded',
  '`src/pay.ts:2`: floating point totals.',
  '**Fix:** round to cents.',
  '',
  '### [nit] Magic number',
  '`src/pay.ts:2`: name the rate.',
  '',
  '## Tests',
  '- Add a rounding test.',
].join('\n')
const PANE_PROPS = {
  title: 'Review',
  isFocused: false,
  bodyColumns: 90,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}
const COMPLETE = { durationMs: 4000, isAborted: false, turnId: 'r1', agentId: 'rev-1', reason: 'answer' } as const
const review = (args = '') => ({
  command: 'review',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 160 },
})

type World = { git: string[][]; spawns: { prompt: string; subagentType?: string }[]; prompts: string[]; ran: string[] }

const world = (on: On, options: { clean?: boolean; knownRefs?: string[] } = {}): World => {
  const state: World = { git: [], spawns: [], prompts: [], ran: [] }
  mock.clock(on, { now: 1_000 })
  on('process.run', ($, e) => {
    const args = e.argv.slice(1)
    state.git.push(args)
    const answer = (exitCode: number, stdout = '') => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (args[0] === 'rev-parse') return answer(0, '/work/pay\n')
    if (args[0] === 'merge-base') return (options.knownRefs ?? ['main']).includes(args[1] ?? '') ? answer(0, 'f0f0f0f\n') : answer(128)
    if (args.includes('--shortstat')) return answer(0, options.clean === true ? '' : ' 1 file changed, 1 insertion(+), 1 deletion(-)\n')
    if (args[0] === 'diff') return answer(0, DIFF)
    return answer(1)
  })
  on('agent.spawn', ($, e) => {
    // The test kit hands a plugin's spawn on in the Agent tool's spelling (subagent_type).
    const loose = e as unknown as Record<string, unknown>
    state.spawns.push({ prompt: e.prompt, subagentType: e.subagentType ?? String(loose.subagent_type) })
    return { model: 'claude', agentId: 'rev-1' }
  })
  on('turn.complete', () => ({ text: '' }))
  on('command.run', ($, e) => ({ text: `built-in /${e.command} ${e.args}` }))
  on('tool.call', ($, e) => {
    if (e.tool === 'Bash') state.ran.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.copy', () => ({ value: { isCopied: true } }))
  on('prompt.submit', ($, e) => {
    state.prompts.push(e.text)
    return { text: e.text }
  })
  return state
}

test('the reviewer reads only: plain git read commands pass, anything else is refused', async () => {
  expect(whyNotReadOnly('git diff HEAD')).toBeUndefined()
  expect(whyNotReadOnly('git --no-pager log --format="%h %s" -5')).toBeUndefined()
  expect(whyNotReadOnly('git show HEAD:src/pay.ts')).toBeUndefined()
  expect(whyNotReadOnly('rm -rf .')).toContain('only git')
  expect(whyNotReadOnly('git diff && rm -rf .')).toContain('shell operators')
  expect(whyNotReadOnly('git commit -m x')).toContain('only git')
  expect(whyNotReadOnly('git diff --output=/tmp/x')).toContain('output files')
  expect(whyNotReadOnly('git -c core.pager=sh diff')).toContain('only git')
  // git grep -O runs a program on every matching file; quotes do not hide an option from git.
  expect(whyNotReadOnly('git grep -Orm -l .')).toContain('external programs')
  expect(whyNotReadOnly('git grep -iOrm x')).toContain('external programs')
  expect(whyNotReadOnly('git grep --open=rm x')).toContain('external programs')
  expect(whyNotReadOnly('git diff "--output=/tmp/x"')).toContain('output files')
  expect(whyNotReadOnly("git grep '-Orm' x")).toContain('external programs')
  expect(whyNotReadOnly('git log --oneline -5')).toBeUndefined()
  expect(whyNotReadOnly('git grep -n "TODO" -- src')).toBeUndefined()
  expect(describeCounts(countSeverities(REPORT))).toBe('1 major, 1 nit')
  expect(describeCounts(countSeverities('## Findings\nNo issues found.'))).toBe('no issues')
})

test('session start registers the read-only reviewer agent type', async ($, on) => {
  const agents: { name: string; tools?: readonly string[]; prompt: string; model?: string }[] = []
  on('tool.list', () => ({
    value: ['Read', 'Bash', 'Edit', 'Grep'].map(name => ({ name, description: name, isReadOnly: false })),
  } as never))
  on('agent.register', ($, e) => {
    agents.push(e)
    return { value: { agent: `review-agent:${e.name}` } }
  })
  on('command.register', () => ({ deny: 'review is a built-in command' }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work/pay', surface: 'terminal', isInteractive: true })

  expect(agents).toHaveLength(1)
  expect(agents[0]?.name).toBe('reviewer')
  expect(agents[0]?.tools).toEqual(['Read', 'Grep', 'Bash'])
  expect(agents[0]?.model).toBe('inherit')
  expect(agents[0]?.prompt).toContain('[critical]')
  expect(agents[0]?.prompt).toContain('Security')
})

test('/review spawns the reviewer on the diff and shows its findings with a fix button', async ($, on) => {
  const state = world(on)
  const started = await $.command.run(review())
  expect(started.text).toContain('Reviewing uncommitted changes (1 file changed')
  expect(state.spawns[0]?.subagentType).toBe('review-agent:reviewer')
  expect(state.spawns[0]?.prompt).toContain('+const fee = amount * 0.1')
  expect(state.spawns[0]?.prompt).toContain('Diff command: `git diff HEAD`')

  const running = await $.ui.mount({ plugin: 'review-agent', surface: 'terminal', component: 'Pane', requestId: 'review', props: PANE_PROPS })
  expect(await running.find({ type: 'Text', text: /Reviewing in the background/ })).toBeDefined()
  await running.unmount()

  await $.turn.complete({ ...COMPLETE, answer: REPORT })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'review-agent', surface, component: 'Pane', requestId: 'review', props: PANE_PROPS })
    expect((await ui.find({ key: 'report' }))?.text).toContain('Fee is not rounded')
    expect(await ui.find({ type: 'Text', text: '1 major' })).toBeDefined()
    await ui.press({ key: 'fix' })
    await ui.unmount()
  }
  expect(state.prompts[0]).toContain('Please address these code review findings')
  expect(state.prompts[0]).toContain('### [major] Fee is not rounded')
})

test('/review <base> diffs from the fork point; bad refs, clean trees and PR numbers are handled', async ($, on) => {
  const state = world(on)
  await $.command.run(review('main'))
  expect(state.git).toContainEqual(['merge-base', 'main', 'HEAD'])
  expect(state.spawns[0]?.prompt).toContain('Review the changes since main')
  expect(state.spawns[0]?.prompt).toContain('git diff f0f0f0f')

  await $.turn.complete({ ...COMPLETE, answer: REPORT })
  const unknown = await $.command.run(review('nope'))
  expect(unknown.text).toContain('Cannot find "nope"')
  const injected = await $.command.run(review('--output=/tmp/x'))
  expect(injected.text).toContain('is not a branch, tag or commit name')
  const pullRequest = await $.command.run(review('123'))
  expect(pullRequest.text).toBe('built-in /review 123')
  expect(state.spawns).toHaveLength(1)
})

test('a clean working tree has nothing to review', async ($, on) => {
  const state = world(on, { clean: true })
  const ran = await $.command.run(review())
  expect(ran.text).toContain('Nothing to review: no uncommitted changes')
  expect(state.spawns).toHaveLength(0)
})

test("a reviewer's Bash is held to read-only git; other agents and the main loop are untouched", async ($, on) => {
  const state = world(on)
  await $.command.run(review())
  const asReviewer = (command: string) => $.tool.call({ tool: 'Bash', command, agentId: 'rev-1' } as never)

  const denied = await asReviewer('rm -rf src')
  expect(String(denied.text ?? denied.deny)).toContain('the reviewer is read-only')
  await asReviewer('git diff HEAD -- src/pay.ts')
  await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'other-agent' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm run build' })
  expect(state.ran).toEqual(['git diff HEAD -- src/pay.ts', 'npm test', 'npm run build'])
})
