import type { On, PromptOrigin } from 'claude-code'
import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const JIRA = 'https://acme.atlassian.net'

/** Stands in for the engine: the git remote the session sees, and the prompt as it enters. */
const engine = (on: On, remote: string | null = 'git@github.com:acme/app.git') => {
  on('session.repo', () => ({ value: { root: '/repo', remote, internal: false, name: null } }))
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
}

const send = async ($: Engine, text: string, origin: PromptOrigin = { kind: 'composer' }) =>
  (await $.prompt.submit({ text, wait: false, origin })).text

const REFERENCED = '\n\nReferenced tickets: '

test('links Jira keys and GitHub issue numbers, reading the repository from the git remote', {
  options: { jiraBaseUrl: JIRA },
}, async ($, on) => {
  engine(on)

  const text = await send($, 'Fix ABC-123 and see #42, which relates to ABC-124.')

  expect(text).toBe(
    'Fix ABC-123 and see #42, which relates to ABC-124.' +
      REFERENCED +
      `ABC-123 (${JIRA}/browse/ABC-123), ABC-124 (${JIRA}/browse/ABC-124), #42 (https://github.com/acme/app/issues/42)`,
  )
})

test('reads https remotes too, and a configured repository wins over the remote', async ($, on) => {
  engine(on, 'https://github.com/acme/app.git')
  expect(await send($, 'see #7')).toBe(`see #7${REFERENCED}#7 (https://github.com/acme/app/issues/7)`)
})

test('uses the configured repository instead of the remote', { options: { githubRepo: 'other/place' } }, async ($, on) => {
  engine(on, 'git@gitlab.com:acme/app.git')

  expect(await send($, 'see #7')).toBe(`see #7${REFERENCED}#7 (https://github.com/other/place/issues/7)`)
})

test('ignores Jira keys without a base URL, and issue numbers when no GitHub repository is known', async ($, on) => {
  engine(on, 'git@gitlab.com:acme/app.git')

  expect(await send($, 'Fix ABC-123 and #42')).toBe('Fix ABC-123 and #42')
})

test('does not mistake acronyms, URLs, code fences or headings for tickets', {
  options: { jiraBaseUrl: JIRA },
}, async ($, on) => {
  engine(on)
  const untouched = [
    'Save it as UTF-8 with SHA-256 checksums',
    `Look at ${JIRA}/browse/ABC-123 and https://github.com/acme/app/issues/9`,
    'Here is the log:\n```\nERR-500 at #12\n```',
    '# Title\nUse the color #333 here',
    'version#2 is odd',
  ]

  for (const text of untouched) expect(await send($, text)).toBe(text)
})

test('still links a three-digit issue number when the line is not about colours', async ($, on) => {
  engine(on)

  expect(await send($, 'Please look at #333')).toBe(
    `Please look at #333${REFERENCED}#333 (https://github.com/acme/app/issues/333)`,
  )
})

test('limits Jira keys to the configured projects', { options: { jiraBaseUrl: `${JIRA}/`, jiraProjects: 'abc, web' } }, async ($, on) => {
  engine(on)

  expect(await send($, 'ABC-1, WEB-2 and XYZ-3')).toBe(
    `ABC-1, WEB-2 and XYZ-3${REFERENCED}ABC-1 (${JIRA}/browse/ABC-1), WEB-2 (${JIRA}/browse/WEB-2)`,
  )
})

test('leaves slash commands, notifications and prompts that already carry the line alone', {
  options: { jiraBaseUrl: JIRA },
}, async ($, on) => {
  engine(on)
  const already = `Fix ABC-1${REFERENCED}ABC-1 (${JIRA}/browse/ABC-1)`

  expect(await send($, '/review ABC-1')).toBe('/review ABC-1')
  expect(await send($, 'ABC-1 finished', { kind: 'task-notification' })).toBe('ABC-1 finished')
  expect(await send($, already)).toBe(already)
})
