import { expect, test } from 'claude-code/testing'

import type { IssuePilotIssue } from '../types'
import { acceptanceCriteria, branchNameOf, commitMessageOf, linksIn, parseReport, prBodyOf, prTitleOf, redact, testCommandFrom, workPrompt } from '../hooks/compose'
import { estimate, formatMinutes, parseLearnedRules, sizeOf, tierOf } from '../hooks/estimate'
import { adfToText, base64, explainGh, findTransition, ghListArgs, isGitHubRemote, jiraJql, linearFilter, parseGhList, pickLinearState, pickProvider, textToAdf } from '../hooks/providers'

const BODY = [
  'Users who sign in with SSO end up in a redirect loop. See https://sentry.io/acme/issues/991 and https://github.com/acme/shop/issues/7.',
  '',
  '## Acceptance criteria',
  '- SSO users land on the dashboard after sign-in',
  '- The `returnTo` parameter is honoured',
  '',
  '## Notes',
  '- [ ] Add a regression test in `src/auth/callback.test.ts`',
  '- [x] Reproduced locally',
].join('\n')

const issue = (over: Partial<IssuePilotIssue> = {}): IssuePilotIssue => ({
  provider: 'github',
  id: '12',
  ref: '#12',
  number: '12',
  title: 'Login redirect loops after SSO',
  body: BODY,
  url: 'https://github.com/acme/shop/issues/12',
  labels: ['bug'],
  milestone: 'v2.4',
  state: 'open',
  points: null,
  estimate: estimate({ title: 'Login redirect loops after SSO', body: BODY, labels: ['bug'], points: null, criteria: 4 }),
  ...over,
})

test('acceptance criteria come from the criteria section, checklists and Gherkin lines; links are collected', () => {
  expect(acceptanceCriteria(BODY)).toEqual([
    { text: 'SSO users land on the dashboard after sign-in', isDone: false },
    { text: 'The `returnTo` parameter is honoured', isDone: false },
    { text: 'Add a regression test in `src/auth/callback.test.ts`', isDone: false },
    { text: 'Reproduced locally', isDone: true },
  ])
  expect(acceptanceCriteria('Scenario\nGiven a cart with 2 items\nWhen I remove one\nThen the total updates')).toHaveLength(3)
  expect(linksIn(BODY)).toEqual(['https://sentry.io/acme/issues/991', 'https://github.com/acme/shop/issues/7'])
})

test('tiers follow the words and labels like smart-router; learned rules win; size from points or content', () => {
  expect(tierOf({ title: 'Fix typo in README', body: '', labels: [], points: null, criteria: 0 }).tier).toBe('light')
  expect(tierOf({ title: 'Checkout total is wrong', body: 'Steps to reproduce: add 2 items', labels: ['bug'], points: null, criteria: 0 }).tier).toBe('standard')
  expect(tierOf({ title: 'Session tokens are not rotated', body: 'A security review found the JWT is reused', labels: [], points: null, criteria: 0 })).toMatchObject({ tier: 'deep' })
  expect(tierOf({ title: 'Small change', body: '', labels: ['epic'], points: null, criteria: 0 }).reason).toBe('label epic')
  const rules = parseLearnedRules(JSON.stringify({ rules: [{ keywords: ['invoice', 'pdf'], tier: 'deep' }, { keywords: [], tier: 'light' }, { tier: 'nope' }] }))
  expect(rules).toEqual([{ keywords: ['invoice', 'pdf'], tier: 'deep' }])
  expect(tierOf({ title: 'Invoice PDF footer', body: 'the pdf footer is cut', labels: ['docs'], points: null, criteria: 0 }, rules)).toEqual({ tier: 'deep', reason: 'learned rule: invoice + pdf' })
  expect(parseLearnedRules('not json')).toEqual([])
  expect(sizeOf({ title: '', body: '', labels: [], points: 8, criteria: 0 })).toBe('L')
  expect(sizeOf({ title: '', body: 'x', labels: [], points: null, criteria: 0 })).toBe('S')
  expect(sizeOf({ title: '', body: 'x'.repeat(5_000), labels: [], points: null, criteria: 6 })).toBe('XL')
})

test('the estimate gives minutes and dollars on the tier model', () => {
  const small = estimate({ title: 'Fix typo in README', body: '', labels: [], points: null, criteria: 0 })
  expect(small).toMatchObject({ tier: 'light', size: 'S', model: 'haiku' })
  const big = estimate({ title: 'Redesign the sync architecture', body: '', labels: [], points: 13, criteria: 0 })
  expect(big).toMatchObject({ tier: 'deep', size: 'XL', model: 'opus' })
  expect(big.usd).toBeGreaterThan(small.usd * 20)
  expect(big.minutes).toBeGreaterThan(small.minutes)
  // A big "light" job still needs a standard model.
  expect(estimate({ title: 'Update docs', body: 'x'.repeat(7_000), labels: [], points: null, criteria: 3 }).tier).toBe('standard')
  expect(formatMinutes(25)).toBe('~25 min')
  expect(formatMinutes(135)).toBe('~2.5 h')
})

test('branch names are <type>/<number>-<slug>', () => {
  expect(branchNameOf(issue())).toBe('fix/12-login-redirect-loops-after-sso')
  expect(branchNameOf({ number: 'shop-7', title: 'Add gift cards to the checkout page', labels: ['story'] })).toBe('feat/shop-7-add-gift-cards-checkout-page')
  expect(branchNameOf({ number: 'eng-42', title: 'Update the README', labels: [] })).toBe('docs/eng-42-update-readme')
})

test('the work prompt carries the issue, criteria, links and the definition of done', () => {
  const prompt = workPrompt(issue(), 'fix/12-login-redirect-loops-after-sso', 'npm test')
  expect(prompt).toContain('Work on GitHub issue #12: Login redirect loops after SSO')
  expect(prompt).toContain('https://github.com/acme/shop/issues/12')
  expect(prompt).toContain('<issue>\nUsers who sign in with SSO')
  expect(prompt).toContain('- [ ] SSO users land on the dashboard after sign-in')
  expect(prompt).toContain('- [x] Reproduced locally')
  expect(prompt).toContain('## Links\n- https://sentry.io/acme/issues/991')
  expect(prompt).toContain('the suite passes: `npm test`')
  expect(prompt).toContain('Do not push or open a pull request')
  expect(prompt).toContain('Labels: bug')
  expect(workPrompt(issue({ body: '' }), 'b', undefined)).toContain('None are listed')
})

test('PR title, body and commit: Fixes #N, summary, testing, risks', () => {
  expect(prTitleOf(issue())).toBe('Fixes #12: Login redirect loops after SSO')
  expect(prTitleOf(issue({ provider: 'jira', ref: 'SHOP-7' }))).toBe('Fixes SHOP-7: Login redirect loops after SSO')
  const report = parseReport('SUMMARY:\nThe callback now keeps returnTo.\nRISKS:\n- Low: one handler.')
  expect(report).toEqual({ summary: 'The callback now keeps returnTo.', risks: '- Low: one handler.' })
  expect(parseReport('no shape')).toBeUndefined()
  const tests = { command: 'npm test', outcome: 'passed' as const, passed: 12, failed: 0, summary: '✓ 12 passed', tail: '' }
  const body = prBodyOf({ issue: issue(), report, stat: ' src/auth/callback.ts | 4 ++--\n 1 file changed', commits: '- fix returnTo', tests })
  expect(body.startsWith('Fixes #12\n')).toBe(true)
  for (const part of ['## Summary\nThe callback now keeps returnTo.', '## Changes\n- fix returnTo', '## Testing\n- `npm test`: ✓ 12 passed', '## Risks\n- Low: one handler.', '- [ ] The `returnTo` parameter is honoured']) {
    expect(body).toContain(part)
  }
  const fallback = prBodyOf({ issue: issue(), report: undefined, stat: ' db/migrations/002.sql | 9 +++', commits: '', tests: null })
  expect(fallback).toContain('- No test run')
  expect(fallback).toContain('migrations or schema')
  expect(commitMessageOf(issue(), 'fix/12-login')).toBe('fix: login redirect loops after SSO (#12)\n\nFixes #12\nhttps://github.com/acme/shop/issues/12')
})

test('secrets are masked in what is posted', () => {
  const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`
  const masked = redact(`Use the token ${token} and AKIAZ7Q4N2XWJ5R8T3LM to reproduce`)
  expect(masked).not.toContain(token)
  expect(masked).not.toContain('AKIAZ7Q4N2XWJ5R8T3LM')
  expect(masked).toContain('[REDACTED:')
  expect(redact('plain text with 12 tests')).toBe('plain text with 12 tests')
})

test('test commands are detected from the project files', () => {
  expect(testCommandFrom({ 'package.json': '{"scripts":{"test":"vitest run"}}', 'pnpm-lock.yaml': '' })).toBe('pnpm test')
  expect(testCommandFrom({ 'package.json': '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' })).toBeUndefined()
  expect(testCommandFrom({ 'go.mod': 'module x' })).toBe('go test ./...')
  expect(testCommandFrom({})).toBeUndefined()
})

test('providers: remotes, picking, gh args and output, gh errors', () => {
  expect(isGitHubRemote('git@github.com:acme/shop.git')).toBe(true)
  expect(isGitHubRemote('https://github.com/acme/shop')).toBe(true)
  expect(isGitHubRemote('https://gitlab.com/acme/shop.git')).toBe(false)
  expect(pickProvider('auto', ['github', 'jira'])).toBe('jira')
  expect(pickProvider('auto', ['github'])).toBe('github')
  expect(pickProvider('linear', ['github'])).toBeUndefined()
  expect(ghListArgs({ isMine: true, label: 'bug', milestone: 'v2' })).toEqual(['issue', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,body,labels,milestone,url,state', '--assignee', '@me', '--label', 'bug', '--milestone', 'v2'])
  expect(parseGhList(JSON.stringify([{ number: 3, title: 'T', body: 'B', labels: [{ name: 'bug' }], milestone: { title: 'v2' }, url: 'u', state: 'OPEN' }]))[0]).toMatchObject({ ref: '#3', labels: ['bug'], milestone: 'v2', state: 'open' })
  expect(explainGh('To get started with GitHub CLI, please run:  gh auth login', 4)).toContain('not logged in')
})

test('Jira: basic auth, JQL, ADF both ways, transitions; Linear: filter and states', () => {
  expect(base64('me@acme.io:tok')).toBe('bWVAYWNtZS5pbzp0b2s=')
  expect(base64('é')).toBe('w6k=')
  expect(jiraJql({ isMine: true, label: 'ui "x"', milestone: '' }, 'project = SHOP')).toBe('statusCategory != Done AND assignee = currentUser() AND labels = "ui \\"x\\"" AND (project = SHOP) ORDER BY updated DESC')
  const adf = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Acceptance criteria' }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Totals round to cents' }] }] }] },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { state: 'DONE' }, content: [{ type: 'text', text: 'Spec agreed' }] }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'See ' }, { type: 'text', text: 'the doc', marks: [{ type: 'link', attrs: { href: 'https://wiki/x' } }] }] },
  ] }
  const text = adfToText(adf)
  expect(text).toContain('## Acceptance criteria')
  expect(text).toContain('- Totals round to cents')
  expect(text).toContain('- [x] Spec agreed')
  expect(text).toContain('the doc (https://wiki/x)')
  expect(acceptanceCriteria(text).map(one => one.text)).toEqual(['Totals round to cents', 'Spec agreed'])
  expect(textToAdf('one\ntwo\n\nthree')).toEqual({ type: 'doc', version: 1, content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'one' }, { type: 'hardBreak' }, { type: 'text', text: 'two' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'three' }] },
  ] })
  expect(findTransition([{ id: '1', name: 'Start progress', to: 'In Progress' }, { id: '2', name: 'Review', to: 'In Review' }], 'in progress')?.id).toBe('1')
  expect(linearFilter({ isMine: true, label: 'bug', milestone: '' })).toEqual({ state: { type: { nin: ['completed', 'canceled'] } }, assignee: { isMe: { eq: true } }, labels: { some: { name: { eqIgnoreCase: 'bug' } } } })
  const states = [{ id: 'a', name: 'Todo', type: 'unstarted', position: 0 }, { id: 'c', name: 'In Review', type: 'started', position: 2 }, { id: 'b', name: 'In Progress', type: 'started', position: 1 }]
  expect(pickLinearState(states, 'start', '')?.id).toBe('b')
  expect(pickLinearState(states, 'review', 'in review')?.id).toBe('c')
})
