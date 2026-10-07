import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, Plugin } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { readRecipe } from '../hooks/recipe'

const ROOT = '/work/shop'
const HOME = '/home/me'
const NOON = new Date(2026, 9, 7, 12, 0).getTime()
const PANE: RenderPropsOf['Pane'] = { title: 'Workflows', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 50 }, view: {} }

type World = { clock: MockClock; prompts: string[]; toasts: string[]; files: Map<string, string>; ran: string[]; exit: Map<string, number>; branch: string }

/** A project with an empty .claude/recipes, and an engine that records prompts, commands, toasts and files. */
function world(on: On): World {
  const seen: World = { clock: mock.clock(on, { now: NOON }), prompts: [], toasts: [], files: new Map(), ran: [], exit: new Map(), branch: 'main' }
  const kept = new Map<string, unknown>()
  on('store.get', ($, e) => ({ value: kept.get(e.key) }))
  on('store.set', ($, e) => {
    kept.set(e.key, e.value)
    return { value: undefined }
  })
  mock.env(on, { HOME })
  on('session.root', () => ({ value: ROOT }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.list', ($, e) => {
    const dir = `${(e.path ?? ROOT).replace(/\/+$/, '')}/`
    const names = [...seen.files.keys()].filter(path => path.startsWith(dir) && !path.slice(dir.length).includes('/')).map(path => path.slice(dir.length))
    return names.length === 0 ? { deny: `ENOENT: ${e.path}` } : { value: names.map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', ($, e) => (seen.files.has(e.path) ? { value: seen.files.get(e.path) ?? '' } : { deny: `ENOENT: ${e.path}` }))
  on('fs.write', ($, e) => {
    seen.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    const command = e.argv[0] === 'sh' ? (e.argv[2] ?? '') : e.argv.join(' ')
    seen.ran.push(command)
    const stdout = command === 'git rev-parse --abbrev-ref HEAD' ? `${seen.branch}\n` : ''
    return { value: { exitCode: seen.exit.get(command) ?? 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.submit', ($, e) => {
    if (e.origin.kind === 'plugin') seen.prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  return seen
}

const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

const recipe = async ($: Engine, args: string): Promise<string> =>
  (await $.command.run({ command: 'recipe', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 } })).text ?? ''

/** Plays the turn of the last prompt sent and lets the studio file the outcome. */
async function finishTurn($: Engine, seen: World, turnId: string, answer = 'Released.'): Promise<void> {
  await $.turn.start({ text: seen.prompts.at(-1) ?? '', turnId })
  await $.turn.complete({ answer, durationMs: 90_000, isAborted: false, turnId, reason: 'answer' })
  await seen.clock.settle()
}

test('runs a built-in recipe with params, runs its checks itself, and keeps the history (no hub)', async ($, on) => {
  const seen = world(on)
  await start($)
  expect(await recipe($, 'list')).toContain('release · inline · builtin')
  expect(await recipe($, 'run release')).toBe('Cannot run release:\n- version is required (The version to release, e.g. 1.4.0): version=…')
  expect(await recipe($, 'run release version=1.4.0 test_command="npm run test:ci"')).toBe('Running release (version=1.4.0, test_command=npm run test:ci).')
  await seen.clock.settle()
  const prompt = seen.prompts[0] ?? ''
  expect(prompt).toContain('Run the recipe "Release" (workflow-studio · release).')
  expect(prompt).toContain('Prepare a release of 1.4.0')
  expect(prompt).toContain('Do these steps yourself, in order')
  expect(prompt).toContain('Commit the release as "Release 1.4.0" and create an annotated tag v1.4.0')
  expect(prompt).toContain('- Tests: `npm run test:ci`')
  expect(prompt).toMatch(/\[workflow-studio run [0-9a-f]{8}\]$/)

  seen.exit.set('npm run test:ci', 1)
  await finishTurn($, seen, 't1')
  expect(seen.ran).toContain('npm run test:ci')
  expect(seen.toasts.some(toast => toast.startsWith('Recipe release failed — Released. · checks 0/1'))).toBe(true)
  const history = await recipe($, 'history')
  expect(history).toMatch(/^✗ 10-07 12:00 release version=1\.4\.0 test_command=npm run test:ci · failed · 0s · checks 0\/1$/)
})

test('project recipes win over built-ins; broken files list with friendly errors', async ($, on) => {
  const seen = world(on)
  seen.files.set(`${ROOT}/.claude/recipes/release.yaml`, 'name: release\ndescription: Our own release.\nsteps:\n  - npm version patch\n')
  seen.files.set(`${ROOT}/.claude/recipes/broken.yml`, 'name: Broken One\nmode: fast\nsteps:\n  - title: x\n')
  seen.files.set(`${HOME}/.claude/claude-mods/recipes/mine.json`, '{"name":"mine","description":"Personal.","steps":["say hi"]}')
  await start($)
  const list = await recipe($, 'list')
  expect(list).toContain('release · inline · project — Our own release.')
  expect(list).toContain('mine · inline · personal — Personal.')
  expect(list).toContain('⚠ broken (project) — 4 problems: /recipe validate broken')
  const report = await recipe($, 'validate broken')
  expect(report).toContain('✗ broken (/work/shop/.claude/recipes/broken.yml)')
  expect(report).toContain('  - name: "Broken One" must be 2–40 lowercase letters, digits and dashes (try "broken-one")')
  expect(report).toContain('  - mode: "fast" is not one of inline, parallel, workflow')
  expect(report).toContain('  - steps[1].prompt: required')
  expect(await recipe($, 'validate release')).toBe('✓ release (project)\n✓ release (built-in, shadowed)')
  expect(await recipe($, 'run broken')).toContain('does not load')

  expect(await recipe($, 'copy dependency-update')).toBe('Copied dependency-update to .claude/recipes/dependency-update.yaml (commit it to share it with your team).')
  expect(readRecipe(seen.files.get(`${ROOT}/.claude/recipes/dependency-update.yaml`) ?? '', 'x.yaml').recipe?.mode).toBe('parallel')
})

test('a workflow recipe asks for the Workflow tool explicitly, and a run waits for the current turn', async ($, on) => {
  const seen = world(on)
  await start($)
  await $.turn.start({ text: 'something else', turnId: 'busy' })
  expect(await recipe($, 'security-audit path=src/api')).toBe('Queued security-audit: it starts when the current turn ends.')
  expect(seen.prompts).toEqual([])
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'busy', reason: 'answer' })
  await seen.clock.settle()
  expect(seen.prompts).toHaveLength(1)
  const prompt = seen.prompts[0] ?? ''
  expect(prompt).toContain('I explicitly opt in: run this recipe as a workflow with the Workflow tool (I pressed Run on a workflow recipe in workflow-studio).')
  expect(prompt).toContain('Stage 1 — 4 in parallel:')
  expect(prompt).toContain('  2. Injection and input handling — deep, model: opus')
  expect(prompt).toContain('In src/api, trace user input')
  await finishTurn($, seen, 't2', 'Report written.')
  expect(seen.toasts.some(toast => toast.startsWith('Recipe security-audit done'))).toBe(true)
})

test('the panel on terminal and desktop: list, detail with params, Run, and the field editor that saves YAML', async ($, on) => {
  const seen = world(on)
  await start($)
  expect(await recipe($, '')).toContain('6 recipes.')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'workflow-studio', surface, component: 'Pane', requestId: 'workflow-studio', props: PANE })
    expect(await ui.find({ key: 'open-perf-pass' })).toBeDefined()
    await ui.input({ key: 'search', text: 'security', kind: 'change' })
    expect(await ui.find({ key: 'open-perf-pass' })).toBeUndefined()
    await ui.press({ key: 'open-security-audit' })
    expect((await ui.find({ key: 'run' }))?.props.label).toBe('Run as workflow')
    await ui.press({ key: 'back' })
    await ui.input({ key: 'search', text: '', kind: 'change' })

    await ui.press({ key: 'open-perf-pass' })
    await ui.input({ key: 'param-target', text: `the /checkout endpoint (${surface})` })
    await ui.press({ key: 'run' })
    await seen.clock.settle()
    expect(seen.prompts.at(-1)).toContain(`Measure the /checkout endpoint (${surface}) as it is now`)
    expect(seen.prompts.at(-1)).toContain('Stage 1 — 2 in parallel:')
    expect(await ui.find({ text: /Running perf-pass/ })).toBeDefined()

    await ui.press({ key: 'edit' })
    await ui.input({ key: 'name', text: `perf-${surface}` })
    await ui.input({ key: 'step-prompt-3', text: 'Report the numbers for {{target}} in a table.' })
    await ui.press({ key: 'step-tier-3' })
    await ui.input({ key: 'check-new', text: 'npm run bench' })
    await ui.press({ key: 'save' })
    const saved = readRecipe(seen.files.get(`${ROOT}/.claude/recipes/perf-${surface}.yaml`) ?? '', 'x.yaml').recipe
    expect(saved?.steps[3]).toEqual({ title: 'Report', prompt: 'Report the numbers for {{target}} in a table.', tier: 'standard' })
    expect(saved?.checks.at(-1)).toEqual({ name: 'npm run bench', command: 'npm run bench' })
    expect(await ui.find({ text: /Saved \.claude\/recipes\/perf-/ })).toBeDefined()

    // A save that breaks the schema shows the errors instead of writing.
    await ui.press({ key: 'edit' })
    await ui.input({ key: 'step-prompt-0', text: 'Measure {{taget}}' })
    await ui.press({ key: 'save' })
    expect(await ui.find({ text: /\{\{taget\}\} is not a param/ })).toBeDefined()
    await ui.press({ key: 'cancel-edit' })
    await ui.press({ key: 'history' })
    expect(await ui.find({ text: /perf-pass target=the \/checkout endpoint/ })).toBeDefined()
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
  for (const surface of ['mobile', 'vscode'] as const) {
    const ui = await $.ui.mount({ plugin: 'workflow-studio', surface, component: 'Pane', requestId: 'workflow-studio', props: PANE })
    expect(await ui.find({ key: 'open-release' })).toBeDefined()
    await ui.unmount()
  }
})

/** smart-router standing in with a /route plan in its state. */
const router: Plugin = {
  name: 'smart-router',
  register(on) {
    on('session.start', async ($, e, next) => {
      await $.state.set({ plugin: 'smart-router', key: 'plan' }, {
        task: 'Add dark mode',
        mode: 'parallel',
        subtasks: [
          { title: 'Find colours', tier: 'light', prompt: 'List every hard-coded colour.', dependsOn: [], writes: [] },
          { title: 'Theme tokens', tier: 'standard', prompt: 'Add light and dark tokens.', dependsOn: [], writes: ['src/theme.ts'] },
          { title: 'Verify', tier: 'light', prompt: 'Run the tests.', dependsOn: [1, 2], writes: [] },
        ],
        stages: [[0, 1], [2]],
        createdAt: Date.UTC(2026, 9, 7, 13, 0),
      })
      return next(e)
    })
  },
}

test('/recipe save turns the last autopilot plan or /route plan into a recipe', { plugins: [router] }, async ($, on) => {
  const seen = world(on)
  seen.files.set(
    `${HOME}/.claude/claude-mods/autopilot/last-plan.json`,
    JSON.stringify({ version: 1, goal: 'Make the cart total include VAT', steps: ['Find the total', 'Add VAT'], checks: [{ name: 'Tests pass', command: 'npm test' }], finishedAt: '2026-10-07T11:00:00.000Z' }),
  )
  await start($)
  expect(await recipe($, 'save --from autopilot')).toBe(
    'Saved the autopilot plan as make-the-cart-total-include-vat (2 steps) in .claude/recipes/make-the-cart-total-include-vat.yaml. Edit it with /recipe edit make-the-cart-total-include-vat.',
  )
  const pilot = readRecipe(seen.files.get(`${ROOT}/.claude/recipes/make-the-cart-total-include-vat.yaml`) ?? '', 'x.yaml').recipe
  expect(pilot?.checks).toEqual([{ name: 'Tests pass', command: 'npm test' }])

  // The /route plan is newer than autopilot's, so a plain save takes it.
  expect(await recipe($, 'save dark-mode --personal')).toContain('Saved the /route plan as dark-mode (3 steps) in ~/.claude/claude-mods/recipes/dark-mode.yaml')
  const routed = readRecipe(seen.files.get(`${HOME}/.claude/claude-mods/recipes/dark-mode.yaml`) ?? '', 'x.yaml').recipe
  expect(routed?.mode).toBe('parallel')
  expect(routed?.steps.map(step => `${step.title}:${step.tier}:${step.group ?? '-'}`)).toEqual(['Find colours:light:stage-1', 'Theme tokens:standard:stage-1', 'Verify:light:-'])
  expect(await recipe($, 'list')).toContain('dark-mode · parallel · personal')
})

/** A stand-in for mods-hub: provides `$.mods`, shows publishes and notifications as toasts, shares smart-router's models. */
const hub: Plugin = {
  name: 'mods-hub',
  register(on) {
    const MODE = { presence: 'here' as const, isSilent: false, silentUntil: null, isNight: false, quietHours: '22:00-07:00', interaction: 'auto' as const, canAsk: true }
    const INSTALLED = { hello: [], plugins: [], listedAt: null }
    on('engine.create', async ($, e, next) => ({
      ...(await next(e)),
      mods: {
        publish: async () => ({ id: '' }),
        recent: async () => [],
        latest: async () => null,
        notify: async () => ({ id: '', targets: [], held: false }),
        mode: async () => MODE,
        setMode: async () => MODE,
        setPresence: async () => MODE,
        registerTab: async () => ({ tabs: [] }),
        showTab: async () => ({ isPlaced: false }),
        registerChannel: async () => ({ channels: [] }),
        channelStatus: async () => ({ channels: [] }),
        deliver: async () => ({ isDelivered: false }),
        drain: async () => [],
        stop: async input => ({ id: 'c1', action: input.action ?? 'stop', scope: input.scope ?? 'session', reason: input.reason, by: input.by ?? '', session: '', source: '', at: 0 }),
        hello: async () => ({ installed: INSTALLED }),
        installed: async () => INSTALLED,
        share: async input => ({ key: input.name, owner: '', value: input.value, at: 0 }),
        read: async () => null,
      },
    }))
    on('mods.publish', ($, e) => {
      $.ui.toast(`HUB publish ${e.topic}`)
      return { value: { id: 'e1' } }
    })
    on('mods.notify', ($, e) => {
      $.ui.toast(`HUB notify ${e.level}: ${e.title}`)
      return { value: { id: 'n1', targets: ['toast'], held: false } }
    })
    on('mods.read', ($, e) => ({ value: e.key === 'smart-router.policy' ? { key: e.key, owner: 'smart-router', value: { models: { light: 'haiku', standard: 'opus', deep: 'fable' } }, at: 0 } : null }))
    on('mods.recent', async ($, e) => {
      if (e.prefix === 'control.') {
        const raised = JSON.parse(await $.fs.read('/hub/controls.json').catch(() => '[]')) as { at: number }[]
        return { value: raised.filter(event => event.at > (e.since ?? 0)) as never }
      }
      return { value: e.topic === 'agent.finished' ? ([1, 2, 3].map(n => ({ id: `a${n}`, topic: 'agent.finished', data: {}, source: 'smart-router', at: 0, session: 's', scope: 'session' })) as never) : [] }
    })
    on('mods.hello', () => ({ value: { installed: INSTALLED } }))
    on('mods.registerTab', () => ({ value: { tabs: [] } }))
    on('mods.showTab', async ($, e) => {
      await $.state.set({ plugin: 'mods-hub', key: 'tab' }, e.id)
      return { value: { isPlaced: true } }
    })
  },
}

test('with the hub: the Workflows tab, models from smart-router\'s policy, task events, agents counted, notify', { plugins: [hub] }, async ($, on) => {
  const seen = world(on)
  await start($)
  await recipe($, '')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'workflow-studio', surface, component: 'Pane', requestId: 'claude-mods', props: { ...PANE, title: 'Claude Mods' } })
    expect(await ui.find({ text: '⚙ Workflows' })).toBeDefined()
    expect(await ui.find({ key: 'open-flaky-test-hunt' })).toBeDefined()
    await ui.unmount()
  }
  await recipe($, 'run flaky-test-hunt runs=3')
  await seen.clock.settle()
  expect(seen.prompts[0]).toContain('  3. Fix the causes — deep, model: fable')
  expect(seen.prompts[0]).toContain('  2. Look for flaky patterns — standard, model: opus')
  expect(seen.prompts[0]).toContain('Run `npm test` 3 times')
  expect(seen.toasts).toContain('HUB publish task.started')
  await finishTurn($, seen, 't1', 'Fixed two flaky tests.')
  expect(seen.toasts).toContain('HUB publish task.finished')
  expect(seen.toasts).toContain('HUB notify success: Recipe flaky-test-hunt passed')
  expect(await recipe($, 'history')).toContain('· passed · 0s · checks 1/1 · 3 agents')
})

/** Raises a `control.*` event on the stand-in hub (it serves /hub/controls.json to `recent` with the `control.` prefix). */
function raise(seen: World, topic: string, at: number): void {
  const raised = JSON.parse(seen.files.get('/hub/controls.json') ?? '[]') as unknown[]
  raised.push({ id: `c-${at}`, topic, data: { id: `c-${at}`, scope: 'all', reason: 'from the phone', by: 'owner via whatsapp', session: 'other' }, source: 'whatsapp-bridge', at, session: 'other', scope: 'session' })
  seen.files.set('/hub/controls.json', JSON.stringify(raised))
}

test('with the hub: control.pause holds a queued run until control.resume; control.stop cancels the waiting run and skips the sent one\'s checks', { plugins: [hub] }, async ($, on) => {
  const seen = world(on)
  await start($)
  // A run waits for the current turn; a pause holds it past that turn's end.
  await $.turn.start({ text: 'my own question', turnId: 'mine' })
  expect(await recipe($, 'run flaky-test-hunt runs=3')).toContain('Queued flaky-test-hunt')
  raise(seen, 'control.pause', NOON + 1_000)
  await seen.clock.advance(6_000)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'mine', reason: 'answer' })
  await seen.clock.advance(10_000)
  expect(seen.prompts).toHaveLength(0)
  raise(seen, 'control.resume', NOON + 17_000)
  await seen.clock.advance(6_000)
  expect(seen.prompts).toHaveLength(1)

  // A stop while its turn runs: the turn finishes, its checks do not run, it is filed as cancelled.
  await $.turn.start({ text: seen.prompts[0] ?? '', turnId: 't1' })
  raise(seen, 'control.stop', NOON + 25_000)
  await seen.clock.advance(6_000)
  await $.turn.complete({ answer: 'Fixed.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await seen.clock.settle()
  expect(seen.ran.filter(command => command.startsWith('npm'))).toEqual([])
  expect(await recipe($, 'history')).toContain('· cancelled ·')

  // A stop while a run waits for the turn: it never goes out.
  await $.turn.start({ text: 'another question', turnId: 'mine-2' })
  expect(await recipe($, 'run flaky-test-hunt runs=2')).toContain('Queued flaky-test-hunt')
  raise(seen, 'control.stop', NOON + 40_000)
  await seen.clock.advance(10_000)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'mine-2', reason: 'answer' })
  await seen.clock.advance(10_000)
  expect(seen.prompts).toHaveLength(1)
  expect((await recipe($, 'history')).split('\n')[0]).toContain('· cancelled ·')
})

test('a branch name with shell characters never reaches a check command', async ($, on) => {
  const seen = world(on)
  seen.branch = 'x;touch${IFS}pwned'
  seen.files.set(`${ROOT}/.claude/recipes/ship.yaml`, ['name: ship', 'description: Ship the branch.', 'steps:', '  - Push {{branch}}.', 'checks:', '  - name: Branch pushed', '    command: git ls-remote --exit-code origin {{branch}}', '  - name: Tests', '    command: npm test'].join('\n'))
  await start($)
  await recipe($, 'run ship')
  await seen.clock.settle()
  await finishTurn($, seen, 't1', 'Pushed.')
  expect(seen.ran.some(command => command.includes('pwned'))).toBe(false)
  expect(seen.ran).toContain('npm test')
  expect(await recipe($, 'history')).toContain('failed')
})
