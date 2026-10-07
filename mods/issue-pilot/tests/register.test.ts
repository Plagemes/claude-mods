import { expect, test } from 'claude-code/testing'

import { JIRA, LINEAR_KEY, PANE_PROPS, ROOT, SURFACES, autopilotStub, callsOf, ciStub, endTurn, hubStub, issues, start, world } from './fake'

const OWN_PANE = { plugin: 'issue-pilot', component: 'Pane', requestId: 'issue-pilot', props: PANE_PROPS } as const
const HUB_PANE = { plugin: 'issue-pilot', component: 'Pane', requestId: 'claude-mods', props: PANE_PROPS } as const
const BRANCH = 'fix/12-login-redirect-loops-after-sso'

test('lists my open GitHub issues, sized, in its own pane when there is no hub (terminal and desktop)', async ($, on) => {
  const w = world(on)
  await start($)
  expect(await issues($)).toBe('2 open issues from GitHub.')
  expect(w.opened).toEqual(['issue-pilot'])
  expect(callsOf(w, 'gh', 'issue', 'list')[0]).toEqual(['gh', 'issue', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,body,labels,milestone,url,state', '--assignee', '@me'])

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...OWN_PANE, surface })
    expect((await ui.find({ key: 'size-12' }))?.text).toBe('deep · M')
    expect((await ui.find({ key: 'size-15' }))?.text).toBe('light · S')
    expect(await ui.find({ key: 'start-12' })).toBeDefined()
    expect(await ui.find({ key: 'provider-github' })).toBeDefined()
    await ui.press({ key: 'pick-12' })
    expect(await ui.find({ type: 'Text', text: '☐ SSO users land on the dashboard' })).toBeDefined()
    await ui.press({ key: 'pick-12' })
    await ui.press({ key: 'mine' })
    expect(callsOf(w, 'gh', 'issue', 'list').at(-1)).not.toContain('@me')
    await ui.press({ key: 'mine' })
    await ui.unmount()
  }
})

test('Start: a branch, the in-progress label, the prompt with criteria and done; no comment unless asked', async ($, on) => {
  const w = world(on)
  await start($)
  await issues($)
  const ui = await $.ui.mount({ ...OWN_PANE, surface: 'terminal' })
  await ui.press({ key: 'start-12' })
  await w.clock.settle()
  expect(callsOf(w, 'git', 'switch', '-c')[0]).toEqual(['git', 'switch', '-c', BRANCH])
  expect(callsOf(w, 'gh', 'issue', 'edit')[0]).toEqual(['gh', 'issue', 'edit', '12', '--add-label', 'in progress'])
  expect(callsOf(w, 'gh', 'issue', 'comment')).toHaveLength(0)
  expect(w.prompts).toHaveLength(1)
  const prompt = w.prompts[0] ?? ''
  for (const part of ['Work on GitHub issue #12: Login redirect loops after SSO', '- [ ] SSO users land on the dashboard', '- [ ] Add a regression test', 'the suite passes: `npm test`', `You are on branch \`${BRANCH}\``]) {
    expect(prompt).toContain(part)
  }
  expect(w.statuses.at(-1)).toBe('⚑ #12 working')
  expect(w.toasts).toContain(`Working on #12 — Login redirect loops after SSO · ${BRANCH}`)
  expect(await ui.find({ key: 'finish' })).toBeDefined()
  expect(await ui.find({ key: 'start-15' })).toBeUndefined()
  expect(callsOf(w, 'gh', 'pr')).toHaveLength(0)
  await ui.unmount()
  expect(await issues($, 'start 15')).toBe('Finish or stop #12 first.')
})

test('Finish (a click): tests, commit, push, DRAFT PR "Fixes #12", link and summary comment', async ($, on) => {
  const w = world(on)
  await start($)
  await issues($, 'start 12')
  expect(callsOf(w, 'git', 'push')).toHaveLength(0)
  const said = await issues($, 'finish')
  expect(said).toBe('Opened the draft PR for #12: https://github.com/acme/shop/pull/99')
  expect(callsOf(w, 'sh', '-c')[0]).toEqual(['sh', '-c', 'npm test'])
  expect(w.stdin.get('git commit -F')).toContain('fix: login redirect loops after SSO (#12)')
  const push = w.runs.findIndex(argv => argv.join(' ') === `git push -u origin ${BRANCH}`)
  const pr = w.runs.findIndex(argv => argv[0] === 'gh' && argv[1] === 'pr')
  expect(push).toBeGreaterThan(-1)
  expect(pr).toBeGreaterThan(push)
  expect(w.runs[pr]).toEqual(['gh', 'pr', 'create', '--draft', '--title', 'Fixes #12: Login redirect loops after SSO', '--body-file', '-', '--head', BRANCH])
  const body = w.stdin.get('gh pr create') ?? ''
  for (const part of ['Fixes #12\n', '## Summary\nThe SSO callback now keeps returnTo', '## Testing\n- `npm test`: ✓ 12 passed', '## Risks\n- Low: one handler changed.', 'src/auth/callback.ts']) {
    expect(body).toContain(part)
  }
  expect(w.stdin.get('gh issue comment')).toContain('🤖 Draft pull request: https://github.com/acme/shop/pull/99')
  expect(w.toasts).toContain('Draft PR for #12 — Fixes #12: Login redirect loops after SSO')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...OWN_PANE, surface })
    expect(await ui.find({ key: 'copy-pr' })).toBeDefined()
    expect(await ui.find({ key: 'finish' })).toBeUndefined()
    await ui.unmount()
  }
})

test('opt-in start comment, a missing label created, failing tests hold the PR until "anyway"', { options: { startComment: true, testCommand: 'make check' } }, async ($, on) => {
  let edits = 0
  const w = world(on, {
    testsFail: true,
    gh: args => {
      if (args[0] === 'issue' && args[1] === 'edit') {
        edits += 1
        return edits === 1 ? { exitCode: 1, stdout: '', stderr: "could not add label: 'in progress' not found" } : undefined
      }
      return undefined
    },
  })
  await start($)
  await issues($, 'start 12')
  expect(callsOf(w, 'gh', 'label', 'create')[0]?.slice(0, 4)).toEqual(['gh', 'label', 'create', 'in progress'])
  expect(callsOf(w, 'gh', 'issue', 'edit')).toHaveLength(2)
  expect(w.stdin.get('gh issue comment')).toBe(`🤖 Working on it on branch \`${BRANCH}\` (issue-pilot).`)

  expect(await issues($, 'finish')).toContain('✗ 1 failed · 11 passed')
  expect(callsOf(w, 'sh', '-c')[0]).toEqual(['sh', '-c', 'make check'])
  expect(callsOf(w, 'git', 'push')).toHaveLength(0)
  expect(callsOf(w, 'gh', 'pr')).toHaveLength(0)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...OWN_PANE, surface })
    expect((await ui.find({ key: 'ship' }))?.text).toContain('Open draft PR anyway')
    expect((await ui.find({ key: 'tests' }))?.text).toBe('Tests: ✗ 1 failed · 11 passed')
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...OWN_PANE, surface: 'desktop' })
  await ui.press({ key: 'ship' })
  expect(callsOf(w, 'gh', 'pr', 'create')).toHaveLength(1)
  expect(w.stdin.get('gh pr create')).toContain('- `make check`: ✗ 1 failed · 11 passed')
  await ui.unmount()
})

test('errors: gh not logged in, gh missing, no tracker at all', async ($, on) => {
  let mode: 'unauthed' | 'missing' = 'unauthed'
  const w = world(on, {
    gh: () => (mode === 'missing' ? 'missing' : { exitCode: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' }),
  })
  await start($)
  expect(await issues($)).toBe('the GitHub CLI is not logged in: run `gh auth login`, then refresh.')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...OWN_PANE, surface })
    expect((await ui.find({ key: 'list-error' }))?.text).toContain('gh auth login')
    await ui.unmount()
  }
  mode = 'missing'
  expect(await issues($, 'refresh')).toBe('the GitHub CLI (gh) is not installed: get it at https://cli.github.com.')
  expect(await issues($, 'finish')).toBe('No issue in progress: start one from /issues.')
  expect(w.prompts).toHaveLength(0)
})

test('no tracker: a GitLab remote and no Jira or Linear configured', async ($, on) => {
  world(on, { remote: 'git@gitlab.com:acme/shop.git' })
  await start($)
  expect(await issues($)).toContain('No tracker')
})

test('Jira: basic auth search, In Progress on start, then PR, remote link, In Review and a redacted comment', { options: { ...JIRA, startComment: true } }, async ($, on) => {
  const secret = `ghp_${'Zq8Lm3Np7Rt'.repeat(4)}`
  const w = world(on, { report: `SUMMARY:\nGift cards apply at checkout; tested with ${secret}.\nRISKS:\n- Payment totals.` })
  await start($)
  expect(await issues($)).toBe('1 open issue from Jira.')
  const search = w.http[0]
  expect(search?.headers.Authorization).toBe('Basic bWVAYWNtZS5pbzpqaXJhLXNlY3JldC10b2tlbg==')
  expect(decodeURIComponent(search?.url ?? '')).toContain('jql=statusCategory != Done AND assignee = currentUser() ORDER BY updated DESC')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...OWN_PANE, surface })
    expect((await ui.find({ key: 'size-SHOP-7' }))?.text).toBe('standard · M')
    expect(await ui.find({ key: 'provider-jira' })).toBeDefined()
    expect(await ui.find({ key: 'provider-github' })).toBeDefined()
    await ui.unmount()
  }

  expect(await issues($, 'start SHOP-7')).toBe('Started SHOP-7 on feat/shop-7-add-gift-cards-checkout.')
  await w.clock.settle()
  const moved = w.http.find(one => one.method === 'POST' && one.url.endsWith('/issue/SHOP-7/transitions'))
  expect(JSON.parse(moved?.body ?? '{}')).toEqual({ transition: { id: '21' } })
  const startComment = w.http.find(one => one.url.endsWith('/comment'))
  expect(startComment?.body).toContain('Working on it on branch')
  expect(w.prompts[0]).toContain('- [ ] A gift card code reduces the total')

  await issues($, 'finish')
  const pr = callsOf(w, 'gh', 'pr', 'create')[0] ?? []
  expect(pr).toContain('Fixes SHOP-7: Add gift cards to checkout')
  expect(w.stdin.get('gh pr create')).not.toContain(secret)
  expect(w.stdin.get('gh pr create')).toContain('[REDACTED:')
  const link = w.http.find(one => one.url.endsWith('/remotelink'))
  expect(JSON.parse(link?.body ?? '{}')).toEqual({ object: { url: 'https://github.com/acme/shop/pull/99', title: 'Fixes SHOP-7: Add gift cards to checkout' } })
  const review = w.http.filter(one => one.method === 'POST' && one.url.endsWith('/transitions')).at(-1)
  expect(JSON.parse(review?.body ?? '{}')).toEqual({ transition: { id: '31' } })
  const summary = w.http.filter(one => one.url.endsWith('/comment')).at(-1)
  expect(summary?.body).toContain('Draft pull request: https://github.com/acme/shop/pull/99')
  expect(summary?.body).not.toContain(secret)
})

test('Linear: GraphQL with the key, started on start, then attachment, In Review and a comment', { options: { linearApiKey: LINEAR_KEY } }, async ($, on) => {
  const w = world(on)
  await start($)
  expect(await issues($)).toBe('1 open issue from Linear.')
  const list = w.http[0]
  expect(list?.headers.Authorization).toBe(LINEAR_KEY)
  expect(JSON.parse(list?.body ?? '{}').variables.filter.assignee).toEqual({ isMe: { eq: true } })

  expect(await issues($, 'start eng-42')).toBe('Started ENG-42 on feat/eng-42-export-invoices-csv.')
  await w.clock.settle()
  const queries = () => w.http.map(one => JSON.parse(one.body || '{}') as { query?: string; variables?: Record<string, unknown> })
  expect(queries().find(one => one.query?.includes('IssuePilotMove'))?.variables).toEqual({ id: 'uuid-42', stateId: 's-prog' })
  expect(w.prompts[0]).toContain('- [ ] CSV has one row per invoice')

  await issues($, 'finish')
  expect(callsOf(w, 'gh', 'pr', 'create')[0]).toContain('Fixes ENG-42: Export invoices as CSV')
  expect(queries().find(one => one.query?.includes('IssuePilotLink'))?.variables).toEqual({ issueId: 'uuid-42', url: 'https://github.com/acme/shop/pull/99', title: 'Fixes ENG-42: Export invoices as CSV' })
  expect(queries().filter(one => one.query?.includes('IssuePilotMove')).at(-1)?.variables).toEqual({ id: 'uuid-42', stateId: 's-rev' })
  expect(String(queries().find(one => one.query?.includes('IssuePilotComment'))?.variables?.body)).toContain('Draft pull request')
})

test('with the hub: an Issues tab; autopilot reporting done prepares the PR but never opens it without a click (autoPR off)', { plugins: [hubStub, autopilotStub] }, async ($, on) => {
  const w = world(on)
  const seenOff = w.hub
  await start($)
  expect(seenOff.hello).toContain('issue-pilot')
  expect(seenOff.tabs).toEqual(['issues'])
  await issues($)
  expect(seenOff.shown).toEqual(['issues'])
  expect(w.opened).toEqual([])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...HUB_PANE, surface })
    expect((await ui.find({ key: 'size-12' }))?.text).toBe('deep · M')
    await ui.unmount()
  }

  await issues($, 'start 12')
  const started = seenOff.published.find(event => event.topic === 'task.started')
  expect(started?.data).toEqual({ id: 'issue-pilot:github:#12', title: '#12 Login redirect loops after SSO' })
  expect(seenOff.notices.at(-1)?.title).toBe('Working on #12')
  expect(w.toasts).toEqual([])

  await $.tool.call({ tool: 'Bash', command: 'autopilot-done issue-pilot:github:#12' })
  await endTurn($)
  await w.clock.settle()
  expect(callsOf(w, 'sh', '-c')).toHaveLength(1)
  expect(seenOff.published.some(event => event.topic === 'test.result' && event.source === 'issue-pilot')).toBe(true)
  expect(callsOf(w, 'git', 'push')).toHaveLength(0)
  expect(callsOf(w, 'gh', 'pr')).toHaveLength(0)
  expect(seenOff.notices.at(-1)).toMatchObject({ level: 'success', title: '#12 is ready for a draft PR' })

  const ui = await $.ui.mount({ ...HUB_PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'phase' }))?.text).toBe(`${BRANCH} · ready for a draft PR`)
  await ui.press({ key: 'ship' })
  expect(callsOf(w, 'gh', 'pr', 'create')).toHaveLength(1)
  await ui.unmount()
  expect(seenOff.published.find(event => event.topic === 'pr.opened')?.data).toEqual({ url: 'https://github.com/acme/shop/pull/99', title: 'Fixes #12: Login redirect loops after SSO', branch: BRANCH })
  expect(seenOff.published.filter(event => event.topic === 'task.finished').at(-1)).toMatchObject({ source: 'issue-pilot', data: { outcome: 'ok' } })
  expect(seenOff.notices.at(-1)).toMatchObject({ level: 'success', title: 'Draft PR for #12', url: 'https://github.com/acme/shop/pull/99' })
})

test('with autoPR on, autopilot reporting done opens the draft PR by itself', { options: { autoPR: true }, plugins: [hubStub, autopilotStub, ciStub] }, async ($, on) => {
  const w = world(on)
  const seenAuto = w.hub
  await start($)
  await issues($, 'start 12')
  await $.tool.call({ tool: 'Bash', command: 'autopilot-done run-7 failed' })
  await endTurn($)
  await w.clock.settle()
  expect(callsOf(w, 'sh', '-c')).toHaveLength(0)
  await $.tool.call({ tool: 'Bash', command: 'autopilot-done run-8' })
  await endTurn($)
  await w.clock.settle()
  expect(callsOf(w, 'gh', 'pr', 'create')).toHaveLength(1)
  expect(seenAuto.published.some(event => event.topic === 'pr.opened')).toBe(true)

  // ci-watch's result for the branch shows on the issue.
  await $.tool.call({ tool: 'Bash', command: `ci ${BRANCH} failed` })
  await endTurn($)
  await w.clock.settle()
  const ui = await $.ui.mount({ ...HUB_PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'ci' }))?.text).toBe('CI test: failed')
  await ui.unmount()
})

test('the issue in progress survives a new session of the same project', async ($, on) => {
  const w = world(on)
  await start($)
  await issues($, 'start 12')
  const kept = w.store.get(`active:${ROOT}`) as { phase: string; branch: string } | undefined
  expect(kept).toMatchObject({ phase: 'working', branch: BRANCH })
  expect(await issues($, 'stop')).toBe(`Stopped tracking #12 (the branch ${BRANCH} is kept).`)
  expect(w.store.get(`active:${ROOT}`)).toBeNull()
  expect(w.statuses.at(-1)).toBeUndefined()
})

test('draws on the mobile and vscode surfaces too (no text fields on mobile)', async ($, on) => {
  const w = world(on, { isClean: true })
  await start($)
  await issues($, 'start 12')
  for (const surface of ['mobile', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...OWN_PANE, surface })
    expect(await ui.find({ key: 'finish' })).toBeDefined()
    expect((await ui.find({ key: 'size-15' }))?.text).toBe('light · S')
    expect((await ui.find({ key: 'label' })) === undefined).toBe(surface === 'mobile')
    await ui.unmount()
  }
  expect(w.prompts).toHaveLength(0)
})
