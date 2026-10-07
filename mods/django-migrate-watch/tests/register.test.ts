import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { appsSummary, parsePending } from '../hooks/parse'
import { fakeHub } from './hub'

const PLUGIN = 'django-migrate-watch'
const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {} } as const

/** Django 5.1+ output: operations marked +, ~ and -. */
const PENDING = [
  "Migrations for 'shop':",
  '  shop/migrations/0004_order_status_alter_order_total.py',
  '    + Add field status to order',
  '    ~ Alter field total on order',
  "Migrations for 'accounts':",
  '  accounts/migrations/0002_profile.py',
  '    + Create model Profile',
  '',
].join('\n')

type Reply = { exitCode: number; stdout: string; stderr?: string }

type World = {
  runs: { argv: readonly string[]; cwd: string | undefined }[]
  statuses: (string | undefined)[]
  submitted: string[]
  logs: string[]
  clock: ReturnType<typeof mock.clock>
  reply: Reply
}

const world = (on: On, files: readonly string[]): World => {
  const w: World = { runs: [], statuses: [], submitted: [], logs: [], clock: mock.clock(on), reply: { exitCode: 1, stdout: PENDING } }
  mock.env(on, {})
  on('session.cwd', () => ({ value: '/proj' }))
  on('fs.exists', ($, e) => ({ value: files.includes(e.path) }))
  on('process.run', ($, e) => {
    w.runs.push({ argv: e.argv, cwd: e.init?.cwd })
    return { value: { stderr: '', ...w.reply, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: { type: 'update' } }))
  on('ui.status', ($, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    w.submitted.push(e.text)
    return { text: e.text }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['another band'] }))
  return w
}

const DJANGO = ['/proj/manage.py', '/proj/.git', '/proj/.venv/bin/python']
const edit = ($: Engine, file_path: string) => $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' })
const mountBand = ($: Engine, surface: 'terminal' | 'desktop') => $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND_PROPS })

test('checks for missing migrations once model edits settle, with the virtualenv python', async ($, on) => {
  const w = world(on, DJANGO)
  await edit($, '/proj/shop/models.py')
  await w.clock.advance(1000)
  await edit($, '/proj/accounts/models/profile.py')
  await w.clock.advance(2999)
  expect(w.runs).toEqual([])
  await w.clock.advance(1)

  expect(w.runs).toEqual([{ argv: ['/proj/.venv/bin/python', 'manage.py', 'makemigrations', '--check', '--dry-run'], cwd: '/proj' }])
  expect(w.statuses.at(-1)).toBe('⚠ migrations missing: shop (2), accounts (1)')

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await mountBand($, surface)
    expect((await band.find({ key: 'dmw-head' }))?.text).toContain('Django models changed without migrations')
    expect(await band.find({ type: 'Text', text: 'shop: Add field status to order' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'another band' })).toBeDefined()
    await band.unmount()
  }
})

test('Create migrations hands the work to Claude, and the band clears once migrations exist', async ($, on) => {
  const w = world(on, DJANGO)
  await edit($, '/proj/shop/models.py')
  await w.clock.advance(3000)

  const band = await mountBand($, 'terminal')
  await band.press({ key: 'dmw-create' })
  expect(w.submitted).toEqual([
    [
      'Django reports model changes that have no migration yet:',
      '- shop: Add field status to order; Alter field total on order',
      '- accounts: Create model Profile',
      '',
      'Run `.venv/bin/python manage.py makemigrations` in /proj, then review each new migration file: data loss (dropped columns, NOT NULL fields without a default), renames that came out as a remove plus an add, and whether a data migration is needed. Summarize what each migration does.',
    ].join('\n'),
  ])
  expect(await band.find({ key: 'dmw-head' })).toBeUndefined()
  expect(w.statuses.at(-1)).toBe('⚠ migrations missing: shop (2), accounts (1)')

  w.reply = { exitCode: 0, stdout: 'No changes detected\n' }
  await $.tool.call({ tool: 'Bash', command: '.venv/bin/python manage.py makemigrations' })
  await w.clock.advance(3000)
  expect(w.runs).toHaveLength(2)
  expect(w.statuses.at(-1)).toBeUndefined()
})

test('a dismissed band stays hidden until the missing migrations change', async ($, on) => {
  const w = world(on, DJANGO)
  await edit($, '/proj/shop/models.py')
  await w.clock.advance(3000)
  const band = await mountBand($, 'desktop')
  await band.press({ key: 'dmw-dismiss' })
  expect(await band.find({ key: 'dmw-head' })).toBeUndefined()

  await edit($, '/proj/shop/models.py')
  await w.clock.advance(3000)
  expect(await band.find({ key: 'dmw-head' })).toBeUndefined()

  w.reply = { exitCode: 1, stdout: "Migrations for 'shop':\n  shop/migrations/0005_order_note.py\n    - Add field note to order\n" }
  await edit($, '/proj/shop/models.py')
  await w.clock.advance(3000)
  expect((await band.find({ key: 'dmw-head' }))?.text).toContain('shop (1)')
})

test('stays silent outside Django projects and when the check itself fails', async ($, on) => {
  const w = world(on, ['/proj/manage.py', '/proj/.git'])
  await edit($, '/elsewhere/lib/models.py')
  await edit($, '/proj/shop/views.py')
  await w.clock.advance(3000)
  expect(w.runs).toEqual([])

  w.reply = { exitCode: 1, stdout: '', stderr: 'Traceback (most recent call last):\n...\nModuleNotFoundError: No module named django\n' }
  await edit($, '/proj/shop/models.py')
  await w.clock.advance(3000)
  expect(w.runs.map(run => run.argv[0])).toEqual(['python3'])
  expect(w.statuses).toEqual([])
  expect(w.logs.at(-1)).toContain('ModuleNotFoundError: No module named django')
  const band = await mountBand($, 'terminal')
  expect(await band.find({ key: 'dmw-head' })).toBeUndefined()
})

test('reads Django 4 and 5 dry-run output', () => {
  const django4 = "Migrations for 'blog':\n  blog/migrations/0002_post_slug.py\n    - Add field slug to post\n    - Alter field title on post\n"
  expect(parsePending(django4)).toEqual([{ app: 'blog', file: 'blog/migrations/0002_post_slug.py', operations: ['Add field slug to post', 'Alter field title on post'] }])
  expect(appsSummary(parsePending(PENDING))).toBe('shop (2), accounts (1)')
  expect(parsePending('No changes detected\n')).toEqual([])
})

test('with mods-hub: says hello, publishes x.django-migrate-watch.missing and warns once per new set of missing migrations', async ($, on) => {
  const hub = fakeHub(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  const w = world(on, DJANGO)

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['x.django-migrate-watch.missing'], consumes: [] }])

  await edit($, '/proj/shop/models.py')
  await w.clock.advance(3000)
  await edit($, '/proj/shop/models.py')
  await w.clock.advance(3000)

  expect(w.statuses.at(-1)).toBe('⚠ migrations missing: shop (2), accounts (1)')
  expect(hub.published).toEqual([{ topic: 'x.django-migrate-watch.missing', data: { root: '/proj', apps: [{ app: 'shop', operations: 2 }, { app: 'accounts', operations: 1 }] } }])
  expect(hub.notified).toEqual([{ level: 'warning', title: 'Django models changed without migrations: shop (2), accounts (1)' }])
})
