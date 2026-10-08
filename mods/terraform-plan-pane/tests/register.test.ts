import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { environmentOf, parsePlanCommand, parsePlanJson, parsePlanText } from '../hooks/plan'
import { fakeHub } from './hub'

const PLUGIN = 'terraform-plan-pane'
const PANE_PROPS = {
  title: 'terraform plan',
  isFocused: false,
  bodyColumns: 110,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

const bold = (text: string) => `\u001b[1m${text}\u001b[0m`
const red = (text: string) => `\u001b[31m${text}\u001b[0m`

/** A Terraform 1.x plan as printed to a pipe: colored, with a replacement, a removal, an update and a create. */
const PLAN_TEXT = [
  'Terraform used the selected providers to generate the following execution',
  'plan. Resource actions are indicated with the following symbols:',
  '  + create',
  '  ~ update in-place',
  '  - destroy',
  '-/+ destroy and then create replacement',
  '',
  'Terraform will perform the following actions:',
  '',
  `${bold('  # aws_instance.web')} must be ${bold(red('replaced'))}`,
  '-/+ resource "aws_instance" "web" {',
  '      ~ ami                          = "ami-0a1" -> "ami-0b2" # forces replacement',
  '      ~ id                           = "i-123" -> (known after apply)',
  '        # (12 unchanged attributes hidden)',
  '    }',
  '',
  `${bold('  # aws_s3_bucket.logs')} will be ${bold(red('destroyed'))}`,
  '  # (because aws_s3_bucket.logs is not in configuration)',
  '  - resource "aws_s3_bucket" "logs" {',
  '      - bucket = "acme-logs" -> null',
  '    }',
  '',
  `${bold('  # aws_security_group.web')} will be updated in-place`,
  '  ~ resource "aws_security_group" "web" {',
  '        id      = "sg-1"',
  '      ~ ingress = [',
  '        # (2 unchanged elements hidden)',
  '        ]',
  '    }',
  '',
  `${bold('  # module.vpc.aws_subnet.private["a"]')} will be created`,
  '  + resource "aws_subnet" "private" {',
  '      + cidr_block = "10.0.1.0/24"',
  '    }',
  '',
  `${bold('Plan:')} 2 to add, 1 to change, 2 to destroy.`,
  '',
].join('\n')

const PLAN_JSON = JSON.stringify({
  format_version: '1.2',
  resource_changes: [
    { address: 'aws_instance.web', change: { actions: ['delete', 'create'], replace_paths: [['ami'], ['user_data']] } },
    { address: 'aws_s3_bucket.logs', action_reason: 'delete_because_no_resource_config', change: { actions: ['delete'] } },
    { address: 'aws_security_group.web', change: { actions: ['update'] } },
    { address: 'module.vpc.aws_subnet.private["a"]', change: { actions: ['create'] } },
    { address: 'aws_iam_role.ci', change: { actions: ['no-op'], importing: { id: 'ci' } } },
    { address: 'aws_route53_record.www', previous_address: 'aws_route53_record.web', change: { actions: ['no-op'] } },
    { address: 'aws_vpc.main', change: { actions: ['no-op'] } },
  ],
})

type World = {
  statuses: (string | undefined)[]
  toasts: string[]
  opened: string[]
  runs: { argv: readonly string[]; cwd: string | undefined }[]
  submitted: string[]
  clock: ReturnType<typeof mock.clock>
}

const world = (on: On, stdout: string, show: { exitCode: number; stdout: string } = { exitCode: 0, stdout: PLAN_JSON }): World => {
  const w: World = { statuses: [], toasts: [], opened: [], runs: [], submitted: [], clock: mock.clock(on) }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.call', () => ({ result: { stdout, stderr: '', interrupted: false } }))
  on('process.run', ($, e) => {
    w.runs.push({ argv: e.argv, cwd: e.init?.cwd })
    return { value: { ...show, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.status', ($, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('prompt.submit', ($, e) => {
    w.submitted.push(e.text)
    return { text: e.text }
  })
  return w
}

const tfplan = ($: Engine) =>
  $.command.run({ command: 'tfplan', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

const mountPane = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'tfplan', props: PANE_PROPS })

test('reads a plan from its output: status, toast, a note for Claude and a grouped pane', async ($, on) => {
  const w = world(on, PLAN_TEXT)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const ran = await $.tool.call({ tool: 'Bash', command: 'cd infra && terraform plan' })
  expect(ran.context).toEqual([
    'terraform-plan-pane: this plan destroys aws_s3_bucket.logs (aws_s3_bucket.logs is not in configuration) and replaces aws_instance.web (forces replacement: ami). Make sure the user knows this before anything is applied.',
  ])
  expect(w.statuses.at(-1)).toBe('⚠ tf plan: +1 ~1 ±1 -1 · /tfplan')
  expect(w.toasts).toEqual(['terraform plan destroys aws_s3_bucket.logs and replaces aws_instance.web. /tfplan'])
  expect(w.runs).toEqual([])

  expect((await tfplan($)).text).toBe('terraform plan: +1 ~1 ±1 -1')
  expect(w.opened).toEqual(['tfplan'])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    const counts = (await ui.find({ key: 'counts' }))?.text
    expect(counts).toContain('-1 to destroy')
    expect(counts).toContain('±1 to replace')
    expect(counts).toContain('~1 to update')
    expect(counts).toContain('+1 to create')
    expect((await ui.find({ key: 'meta' }))?.text).toBe('$ cd infra && terraform plan · /repo/infra · read from its output')
    expect((await ui.find({ key: 'group:destroy' }))?.text).toContain('aws_s3_bucket.logs')
    const destroyHeading = (await ui.findAll({ type: 'Text', text: 'Destroy (1)' }))[0]
    expect(destroyHeading?.props.color).toBe('error')
    expect((await ui.find({ key: 'group:replace' }))?.text).toContain('(forces replacement: ami)')
    expect((await ui.find({ key: 'group:create' }))?.text).toContain('module.vpc.aws_subnet.private["a"]')
    expect(await ui.find({ key: 'cut' })).toBeUndefined()
    await ui.unmount()
  }

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'review' })
  expect(w.submitted.at(-1)).toContain('it destroys aws_s3_bucket.logs (aws_s3_bucket.logs is not in configuration) and replaces aws_instance.web (forces replacement: ami).')
  expect(w.submitted.at(-1)).toContain('Do not apply anything.')
})

test('with -out it reads the saved plan with show -json for exact actions', async ($, on) => {
  const w = world(on, PLAN_TEXT)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'terraform -chdir=infra plan -out=tf.plan' })
  await w.clock.settle()

  expect(w.runs).toEqual([{ argv: ['terraform', '-chdir=infra', 'show', '-json', '-no-color', 'tf.plan'], cwd: '/repo' }])
  expect(w.statuses.at(-1)).toBe('⚠ tf plan: +1 ~1 ±1 -1 ⇣1 →1 · /tfplan')
  expect(w.toasts).toHaveLength(1)

  await tfplan($)
  const ui = await mountPane($, 'desktop')
  expect((await ui.find({ key: 'meta' }))?.text).toContain('read from the saved plan file')
  expect((await ui.find({ key: 'group:replace' }))?.text).toContain('(forces replacement: ami, user_data)')
  expect((await ui.find({ key: 'group:destroy' }))?.text).toContain('(not in configuration)')
  expect((await ui.find({ key: 'group:import' }))?.text).toContain('aws_iam_role.ci')
  expect((await ui.find({ key: 'group:move' }))?.text).toContain('(moved from aws_route53_record.web)')
})

test('a clean plan and a failed one say so, quietly', async ($, on) => {
  const w = world(on, 'No changes. Your infrastructure matches the configuration.\n')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({ tool: 'Bash', command: 'tofu plan' })
  expect(ran.context ?? []).toEqual([])
  expect(w.statuses.at(-1)).toBe('✓ tf plan: no changes')
  expect(w.toasts).toEqual([])
  await tfplan($)
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'counts' }))?.text).toBe('✓ No changes')
  expect(await ui.find({ key: 'review' })).toBeUndefined()

  const failed = parsePlanText('╷\n│ Error: Reference to undeclared resource\n│\n│   on main.tf line 4\n╵\n')
  expect(failed.error).toBe('Reference to undeclared resource')
  expect(failed.resources).toEqual([])
})

test('says when the output it read was cut short of the summary', async ($, on) => {
  const cut = PLAN_TEXT.split('\n').filter(line => !line.includes('module.vpc') && !line.includes('cidr_block')).join('\n').replace(' 2 to add', ' 9 to add')
  world(on, cut)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'terraform plan' })
  await tfplan($)
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'cut' }))?.text).toContain("The plan's summary says 9 to add, 1 to change, 2 to destroy")
})

test('reads which command runs a plan, and ignores the rest', () => {
  expect(parsePlanCommand('cd envs/prod && TF_LOG=info terraform -chdir=stack plan -out tf.plan -var region=eu')).toEqual({
    tool: 'terraform',
    cd: 'envs/prod',
    chdir: 'stack',
    out: 'tf.plan',
  })
  expect(parsePlanCommand('tofu plan -no-color | tee plan.txt')).toEqual({ tool: 'tofu', cd: undefined, chdir: undefined, out: undefined })
  expect(parsePlanCommand('/usr/local/bin/terraform plan "-out=my plan"')?.out).toBe('my plan')
  expect(parsePlanCommand('terraform apply tf.plan')).toBeUndefined()
  expect(parsePlanCommand('echo terraform plan')).toBeUndefined()
  expect(parsePlanCommand('terraform fmt && terraform validate')).toBeUndefined()
  // The shared shell reader also opens wrappers and nested scripts.
  expect(parsePlanCommand('sudo -u deploy env TF_VAR_x=1 terraform plan')).toEqual({ tool: 'terraform', cd: undefined, chdir: undefined, out: undefined })
  expect(parsePlanCommand("bash -c 'cd infra && tofu plan -out=p.tfplan'")).toEqual({ tool: 'tofu', cd: 'infra', chdir: undefined, out: 'p.tfplan' })
  expect(environmentOf('/repo/envs/prod')).toBe('production')
  expect(environmentOf('/repo/stacks/staging-eu')).toBe('staging')
  expect(environmentOf('/repo/infra')).toBe('unspecified')
  expect(environmentOf('/repo/products')).toBe('unspecified')

  expect(parsePlanText('  # aws_instance.a (deposed object 1a2b) will be destroyed\n').resources).toEqual([
    { address: 'aws_instance.a', action: 'destroy', detail: 'deposed object' },
  ])
  expect(parsePlanText('  # aws_instance.a is tainted, so must be replaced\n').resources[0]?.detail).toBe('tainted')
  expect(parsePlanJson('{"no":"plan"}')).toBeUndefined()
})

test('with mods-hub: says hello, publishes deploy.started once per plan with changes (target and environment), and warns through the hub', async ($, on) => {
  const w = world(on, PLAN_TEXT)
  const hub = fakeHub(on, {}, w.clock)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await w.clock.advance(1_500)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['deploy.started'], consumes: [] }])

  await $.tool.call({ tool: 'Bash', command: 'cd envs/prod && terraform plan -out=tf.plan' })
  await w.clock.settle()
  expect(hub.published).toEqual([{ topic: 'deploy.started', data: { target: 'terraform:/repo/envs/prod', environment: 'production' } }])
  expect(hub.notified).toHaveLength(1)
  expect(hub.notified[0]).toMatchObject({ level: 'warning' })
  expect(hub.notified[0]?.title).toContain('plan destroys aws_s3_bucket.logs')
  expect(w.toasts).toEqual([])
})

test('with mods-hub, a clean plan and a failed one announce nothing', async ($, on) => {
  const w = world(on, 'No changes. Your infrastructure matches the configuration.\n')
  const hub = fakeHub(on, {}, w.clock)
  await $.tool.call({ tool: 'Bash', command: 'tofu plan' })
  expect(hub.published).toEqual([])
  expect(hub.notified).toEqual([])
})

test('without mods-hub the warning is the same toast and nothing is published', async ($, on) => {
  const w = world(on, PLAN_TEXT)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'terraform plan' })
  await w.clock.settle()
  expect(w.toasts).toHaveLength(1)
})
