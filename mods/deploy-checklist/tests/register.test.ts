import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { deployKind, isTestCommand, testsRunFirst } from '../hooks/checks'

const PLUGIN = 'deploy-checklist'
const PANE_PROPS = {
  title: 'Deploy checklist',
  isFocused: true,
  bodyColumns: 90,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

type Repo = {
  branch: string
  porcelain: string
  tag: string | null
  changelogSinceTag: boolean
  files: Set<string>
  failingTests: boolean
  ran: string[]
  submitted: string[]
  toasts: string[]
  opened: number
  clock: ReturnType<typeof mock.clock>
}

/** A git repository and an engine whose Bash runs everything it is asked to. */
const world = (on: On, overrides: Partial<Repo> = {}): Repo => {
  const repo: Repo = {
    branch: 'main',
    porcelain: '',
    tag: 'v1.2.0',
    changelogSinceTag: true,
    files: new Set(['/work/app/CHANGELOG.md']),
    failingTests: false,
    ran: [],
    submitted: [],
    toasts: [],
    opened: 0,
    clock: mock.clock(on),
    ...overrides,
  }
  on('process.run', ($, e) => {
    const line = e.argv.slice(1).join(' ')
    const answer = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (line === 'rev-parse --show-toplevel') return answer('/work/app\n')
    if (line === 'rev-parse --abbrev-ref HEAD') return answer(`${repo.branch}\n`)
    if (line === 'status --porcelain') return answer(repo.porcelain)
    if (line.startsWith('rev-list --left-right')) return answer('0\t2\n')
    if (line === 'describe --tags --abbrev=0') return repo.tag === null ? answer('', 128) : answer(`${repo.tag}\n`)
    if (line.startsWith('rev-parse --verify -q @{upstream}')) return answer('', 1)
    if (line.startsWith('diff --name-only')) return answer(repo.changelogSinceTag ? 'CHANGELOG.md\n' : '')
    return answer('', 1)
  })
  on('fs.exists', ($, e) => ({ value: repo.files.has(e.path) }))
  on('ui.open', () => {
    repo.opened += 1
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    repo.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => {
    repo.submitted.push(e.text)
    return { text: e.text }
  })
  on('tool.call', ($, e) => {
    const command = 'command' in e ? String(e.command) : String(e.tool)
    repo.ran.push(command)
    return repo.failingTests && isTestCommand(command) ? { isError: true, result: 'exit 1', text: '1 failed' } : { result: 'ok' }
  })
  return repo
}

const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })

const mountPane = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'deploy-checklist', props: PANE_PROPS })

test('recognises deploy commands and leaves look-alikes alone', () => {
  const deploys = [
    'vercel --prod',
    'npx vercel deploy --prod --yes',
    'netlify deploy --dir=dist --prod',
    'fly deploy',
    'flyctl deploy --remote-only',
    'firebase deploy --only hosting',
    'gcloud app deploy app.yaml',
    'kubectl -n web rollout restart deploy/api',
    'bundle exec cap production deploy',
    'npm publish --access public',
    'npm run build && pnpm publish',
    'bash -c "vercel --prod --yes"',
  ]
  for (const command of deploys) expect(`${command} => ${deployKind(command, undefined) ?? 'none'}`).not.toContain('=> none')

  const safe = ['vercel', 'vercel --preview', 'netlify deploy', 'kubectl rollout status deploy/api', 'npm publish --dry-run', 'cat fly.toml', 'echo deploy', 'git commit -m "fly deploy config"']
  for (const command of safe) expect(`${command} => ${deployKind(command, undefined) ?? 'none'}`).toContain('=> none')

  expect(deployKind('git push heroku main', /git push heroku/)).toBe('custom deploy')
  expect(isTestCommand('npm test')).toBe(true)
  expect(isTestCommand('pnpm run test:unit -- --run')).toBe(true)
  expect(isTestCommand('npx vitest run')).toBe(true)
  expect(isTestCommand('python -m pytest -q')).toBe(true)
  expect(isTestCommand('cat jest.config.js')).toBe(false)
  expect(testsRunFirst('npm test && vercel --prod', undefined)).toBe(true)
  expect(testsRunFirst('vercel --prod && npm test', undefined)).toBe(false)
})

test('blocks a deploy with the checklist and opens the pane', async ($, on) => {
  const repo = world(on, { branch: 'feature/login', porcelain: ' M src/app.ts\n?? notes.md\n', changelogSinceTag: false })
  const result = await bash($, 'vercel --prod')

  expect(result.deny).toContain('deploy-checklist: this vercel --prod waits for the user')
  expect(result.deny).toContain('✗ Branch: on feature/login; deploys go out from main or master')
  expect(result.deny).toContain('✗ Working tree: 2 uncommitted changes: src/app.ts, notes.md')
  expect(result.deny).toContain('! Tests: no test run seen in this session')
  expect(result.deny).toContain('! Changelog: CHANGELOG.md not updated since v1.2.0')
  expect(repo.ran).toHaveLength(0)

  await repo.clock.advance(0)
  expect(repo.opened).toBe(1)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect((await ui.find({ key: 'head' }))?.text).toContain('✗ Not ready to deploy')
    expect((await ui.find({ key: 'item:branch' }))?.text).toContain('on feature/login')
    expect((await ui.find({ key: 'deploy' }))?.props.label).toBe('Deploy anyway')
    expect(await ui.find({ type: 'Code', text: 'vercel --prod' })).toBeDefined()
    await ui.unmount()
  }
})

test('Deploy anyway approves that exact command once and tells Claude to run it', async ($, on) => {
  const repo = world(on)
  expect((await bash($, 'fly deploy')).deny).toContain('waits for the user')

  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'deploy' }))?.props.label).toBe('Deploy anyway')
  await ui.press({ key: 'deploy' })
  expect(repo.submitted[0]).toContain('approved the deploy')
  expect(repo.submitted[0]).toContain('fly deploy')

  expect((await bash($, 'fly deploy --remote-only')).deny).toContain('waits for the user')
  expect(repo.ran).toHaveLength(0)
})

test('the approval is used once, by the same command', async ($, on) => {
  const repo = world(on)
  await bash($, 'npm publish')
  const ui = await mountPane($, 'desktop')
  await ui.press({ key: 'deploy' })

  expect((await bash($, 'npm publish')).deny).toBeUndefined()
  expect(repo.ran).toEqual(['npm publish'])
  expect((await bash($, 'npm publish')).deny).toContain('waits for the user')
})

test('an approval expires after 15 minutes', async ($, on) => {
  const repo = world(on)
  await bash($, 'firebase deploy')
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'deploy' })
  await repo.clock.advance(16 * 60_000)
  expect((await bash($, 'firebase deploy')).deny).toContain('waits for the user')
  expect(repo.ran).toHaveLength(0)
})

test('Cancel drops the deploy: nothing is submitted and the next try asks again', async ($, on) => {
  const repo = world(on)
  await bash($, 'gcloud app deploy')
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'cancel' })
  expect(repo.toasts).toContain('Deploy cancelled')
  expect(repo.submitted).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: /No deploy is waiting/ })).toBeDefined()
  expect((await bash($, 'gcloud app deploy')).deny).toContain('waits for the user')
  expect(repo.ran).toHaveLength(0)
})

test('the last test run of the session shows in the checklist', async ($, on) => {
  const repo = world(on, { failingTests: true })
  await bash($, 'npm test')
  await repo.clock.advance(3 * 60_000)
  expect((await bash($, 'vercel --prod')).deny).toContain('✗ Tests: npm test failed 3 min ago')

  repo.failingTests = false
  await bash($, 'npx vitest run')
  const result = await bash($, 'vercel --prod')
  expect(result.deny).toContain('✓ Tests: npx vitest run passed just now')
  expect(result.deny).toContain('✓ Branch: main (2 commits not pushed)')
  expect(result.deny).toContain('✓ Changelog: CHANGELOG.md updated since v1.2.0')
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'head' }))?.text).toContain('✓ Ready to deploy')
  expect((await ui.find({ key: 'deploy' }))?.props.label).toBe('Deploy')
})

test('with confirmWhenPassing off, an all-green deploy runs straight away', { options: { confirmWhenPassing: false } }, async ($, on) => {
  const repo = world(on)
  await bash($, 'npm test')
  expect((await bash($, 'npm test && vercel --prod')).deny).toBeUndefined()
  expect(repo.ran).toEqual(['npm test', 'npm test && vercel --prod'])

  repo.porcelain = ' M src/app.ts\n'
  expect((await bash($, 'vercel --prod')).deny).toContain('✗ Working tree')
})

test('ordinary commands pass and an extra pattern adds deploys', { options: { extraPattern: 'git push heroku' } }, async ($, on) => {
  const repo = world(on)
  expect((await bash($, 'ls -la')).deny).toBeUndefined()
  expect((await bash($, 'kubectl rollout status deploy/api')).deny).toBeUndefined()
  expect((await bash($, 'git push heroku main')).deny).toContain('custom deploy')
  expect(repo.ran).toEqual(['ls -la', 'kubectl rollout status deploy/api'])
})

test('fails closed: a checklist that cannot run blocks the deploy only', async ($, on) => {
  const repo = world(on)
  on('state.get', () => ({ deny: 'state unavailable' }))
  expect((await bash($, 'vercel --prod')).deny).toContain('could not be run')
  expect((await bash($, 'echo hello')).deny).toBeUndefined()
  expect(repo.ran).toEqual(['echo hello'])
})

test('/deploy-checklist with nothing waiting reports readiness', async ($, on) => {
  world(on, { porcelain: ' M CHANGELOG.md\n' })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  const result = await $.command.run({
    command: 'deploy-checklist',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  expect(result.text).toContain('No deploy is waiting. Not ready yet:')
  expect(result.text).toContain('✓ Changelog: CHANGELOG.md has new, uncommitted entries')
  expect(result.text).toContain('✗ Working tree: 1 uncommitted change: CHANGELOG.md')
})

test('regression: a command that only names a runner does not count as a test run', () => {
  for (const command of ['npm i -D vitest', 'cat jest.config.js', 'grep -rn jest src', 'echo pytest', 'git commit -m "run jest"', 'pip install pytest']) {
    expect(isTestCommand(command)).toBe(false)
  }
  for (const command of ['cd web && npx jest', 'bundle exec rspec', 'php artisan test', 'bash -c "npm test"', './gradlew check', 'CI=1 pytest -q']) {
    expect(isTestCommand(command)).toBe(true)
  }
  expect(testsRunFirst('npm i -D vitest && vercel --prod', undefined)).toBe(false)
})

test('regression: a deploy inside bash -lc or sh -ec is recognised', () => {
  expect(deployKind(`bash -lc "vercel --prod"`, undefined)).toBe('vercel --prod')
  expect(deployKind(`sh -ec 'npm test && fly deploy'`, undefined)).toBe('fly deploy')
  expect(deployKind(`git commit -m "fly deploy"`, undefined)).toBeUndefined()
})
