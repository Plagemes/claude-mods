import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { SHOP_GIT_GREP } from './fixtures'

const PANE_PROPS = { title: 'Data map', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const
const MODEL_TABLE = [
  '| Data item | Collected at | Stored in | Sent to | Legal basis hint |',
  '| --- | --- | --- | --- | --- |',
  '| Email address | src/routes/signup.js:10 | MongoDB (User), logs | SendGrid, PostHog, Stripe | contract (account), consent for analytics |',
  '| IP address | src/routes/signup.js:11 | MongoDB (lastLoginIp), logs | Sentry (sendDefaultPii) | legitimate interests (security) |',
  '',
  '## Gaps to check',
  '- PostHog receives the email: needs consent.',
].join('\n')

type World = { runs: (readonly string[])[]; prompts: { model: string; prompt: string }[]; writes: Map<string, string>; toasts: string[]; copies: string[]; clock: ReturnType<typeof mock.clock> }

const world = (on: On, options: { isGit?: boolean; modelAnswers?: boolean; modelRefuses?: boolean; grepOutput?: string } = {}): World => {
  const { isGit = true, modelAnswers = true, modelRefuses = false, grepOutput = SHOP_GIT_GREP } = options
  const state: World = { runs: [], prompts: [], writes: new Map(), toasts: [], copies: [], clock: mock.clock(on, { now: Date.parse('2026-10-07T12:00:00Z') }) }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/home/dev/shop-app' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', ($, e) => {
    state.runs.push(e.argv)
    const answer = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: exitCode > 1 ? 'fatal: not a git repository' : '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[1] === 'rev-parse') return isGit ? answer('/home/dev/shop-app\n') : answer('', 128)
    return grepOutput === '' ? answer('', 1) : answer(grepOutput)
  })
  on('model.complete', ($, e) => {
    state.prompts.push({ model: e.model, prompt: e.prompt })
    if (modelRefuses) return { deny: `unknown model ${e.model}` }
    const usage = { input_tokens: 4000, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    return modelAnswers
      ? { value: { isAnswered: true as const, text: `Here is the map.\n\n${MODEL_TABLE}`, usage } }
      : { value: { isAnswered: false as const, reason: 'api-error' as const, status: 529, error: 'overloaded', usage } }
  })
  on('fs.write', ($, e) => {
    state.writes.set(e.path, e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    state.copies.push(e.text)
    return { value: { isCopied: true } }
  })
  return state
}

const dataMap = ($: Engine) =>
  $.command.run({ command: 'data-map', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
const mountPane = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: 'data-map', surface, component: 'Pane', requestId: 'data-map', props: PANE_PROPS })

test('/data-map greps the repository, has the model organise the evidence, and shows the table on every surface', async ($, on) => {
  const state = world(on)
  expect((await dataMap($)).text).toBe('Scanning the code for personal data…')
  await state.clock.advance(0)
  expect(state.runs[1]?.slice(0, 3)).toEqual(['git', 'grep', '-n'])
  expect(state.prompts).toHaveLength(1)
  expect(state.prompts[0]?.model).toBe('sonnet')
  expect(state.prompts[0]?.prompt).toContain('[email address] src/models/user.js:4')
  expect(state.toasts).toEqual(['Data map ready: 9 kinds of personal data, 4 third parties (/data-map)'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect((await ui.find({ key: 'header' }))?.text).toContain('9 kinds of personal data · 3 stores · 4 third parties')
    const table = await ui.find({ key: 'table' })
    expect(table?.text).toStartWith('| Data item | Collected at |')
    expect(table?.text).toContain('Sentry (sendDefaultPii)')
    await ui.unmount()
  }
})

test('Save writes docs/data-map.md with the table and the evidence; Copy copies the table', async ($, on) => {
  const state = world(on)
  await dataMap($)
  await state.clock.advance(0)
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'save' })
  expect(state.toasts.at(-1)).toBe('Saved docs/data-map.md')
  const saved = state.writes.get('/home/dev/shop-app/docs/data-map.md') ?? ''
  expect(saved).toStartWith('# Personal data map: shop-app\n\n_Generated 2026-10-07')
  expect(saved).toContain('| IP address | src/routes/signup.js:11 |')
  expect(saved).toContain('## Evidence')
  expect((await ui.find({ key: 'header' }))?.text).toContain('✓ docs/data-map.md')
  await ui.press({ key: 'copy' })
  expect(state.copies[0]).toStartWith('| Data item |')
  await ui.unmount()
})

test('when the model does not answer, the table is built from the scan, and says so', { options: { model: 'haiku', output: 'privacy/map.md' } }, async ($, on) => {
  const state = world(on, { modelAnswers: false, isGit: false })
  await dataMap($)
  await state.clock.advance(0)
  expect(state.runs[1]?.slice(0, 3)).toEqual(['grep', '-r', '-n'])
  expect(state.prompts[0]?.model).toBe('haiku')
  const ui = await mountPane($, 'desktop')
  expect((await ui.find({ key: 'header' }))?.text).toContain('The model did not answer')
  expect((await ui.find({ key: 'table' }))?.text).toContain('| email address |')
  await ui.press({ key: 'save' })
  await ui.unmount()
  expect(state.writes.get('/home/dev/shop-app/privacy/map.md')).toContain('organised without the model')
})

test('a project without personal-data fields says so without asking the model', async ($, on) => {
  const state = world(on, { grepOutput: '' })
  await dataMap($)
  await state.clock.advance(0)
  expect(state.prompts).toHaveLength(0)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /No personal-data fields found/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a model call that is refused outright still ends in the table from the scan', { options: { model: 'no-such-model' } }, async ($, on) => {
  const state = world(on, { modelRefuses: true })
  await dataMap($)
  await state.clock.advance(0)
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'header' }))?.text).toContain('The model did not answer')
  expect((await ui.find({ key: 'table' }))?.text).toContain('| email address |')
  await ui.unmount()
})
