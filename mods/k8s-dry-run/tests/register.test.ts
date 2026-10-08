import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { findKubectl, findKubectls, objectName, parseDiff, previewArgv } from '../hooks/kubectl'
import { fakeHub } from './hub'

const PLUGIN = 'k8s-dry-run'
const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 14, bodyColumns: 110, scroll: { offset: 0, bodyRows: 14 }, view: {} } as const
const PANE_PROPS = { title: 'kubectl diff', isFocused: false, bodyColumns: 110, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

const DIFF = [
  'diff -u -N /tmp/LIVE-2795/apps.v1.Deployment.shop.web /tmp/MERGED-2795/apps.v1.Deployment.shop.web',
  '--- /tmp/LIVE-2795/apps.v1.Deployment.shop.web\t2026-10-07 10:00:00.000000000 +0000',
  '+++ /tmp/MERGED-2795/apps.v1.Deployment.shop.web\t2026-10-07 10:00:00.000000000 +0000',
  '@@ -6,7 +6,7 @@',
  '   generation: 4',
  '   name: web',
  ' spec:',
  '-  replicas: 2',
  '+  replicas: 4',
  '   selector:',
  '     matchLabels:',
  '       app: web',
  'diff -u -N /tmp/LIVE-2795/v1.Service.shop.web-internal /tmp/MERGED-2795/v1.Service.shop.web-internal',
  '--- /tmp/LIVE-2795/v1.Service.shop.web-internal\t1970-01-01 00:00:00.000000000 +0000',
  '+++ /tmp/MERGED-2795/v1.Service.shop.web-internal\t2026-10-07 10:00:00.000000000 +0000',
  '@@ -0,0 +1,4 @@',
  '+apiVersion: v1',
  '+kind: Service',
  '+metadata:',
  '+  name: web-internal',
  '',
].join('\n')

type Answer = { exitCode: number; stdout?: string; stderr?: string }

type World = {
  runs: { argv: readonly string[]; stdin: string | undefined; env: Record<string, string> | undefined }[]
  executed: string[]
  submitted: string[]
  statuses: (string | undefined)[]
  toasts: string[]
  opened: string[]
  clock: ReturnType<typeof mock.clock>
}

/** A cluster whose current context is `context`; `answer` stands for kubectl's dry runs. */
const world = (on: On, context: string, answer: (argv: readonly string[]) => Answer = () => ({ exitCode: 1, stdout: DIFF })): World => {
  const w: World = { runs: [], executed: [], submitted: [], statuses: [], toasts: [], opened: [], clock: mock.clock(on, { now: 1_000 }) }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', ($, e) => {
    const isContext = e.argv.join(' ').endsWith('config current-context')
    if (!isContext) w.runs.push({ argv: e.argv, stdin: e.init?.stdin, env: e.init?.env })
    const reply = isContext ? { exitCode: 0, stdout: `${context}\n` } : answer(e.argv)
    return { value: { stdout: '', stderr: '', ...reply, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', ($, e) => {
    w.executed.push(e.tool === 'Bash' ? e.command : String(e.tool))
    return { result: { stdout: 'deployment.apps/web configured\n', stderr: '', interrupted: false } }
  })
  on('prompt.submit', ($, e) => {
    w.submitted.push(e.text)
    return { text: e.text }
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
  on('ui.close', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['another band'] }))
  return w
}

const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })
const slash = ($: Engine, command: string) =>
  $.command.run({ command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
const say = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

test('holds kubectl apply with its server-side diff until Approve, which lets the same command run once', async ($, on) => {
  const w = world(on, 'staging')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const held = await bash($, 'kubectl apply -f k8s/ -n shop')
  expect(held.deny).toBe(
    [
      'k8s-dry-run: held for approval. The server-side dry run of `kubectl apply -f k8s/ -n shop` on context "staging", namespace "shop" would change 2 objects:',
      '  ~ Deployment shop/web (+1 −1)',
      '  + Service shop/web-internal (+4 −0)',
      'Show this to the user and ask them to approve it. They approve with the Approve button above the prompt, /k8s-approve, or a short "yes". Once approved, run exactly the same command again; do not change it or add --dry-run.',
    ].join('\n'),
  )
  expect(w.runs[0]).toEqual({ argv: ['kubectl', 'diff', '-f', 'k8s/', '-n', 'shop'], stdin: undefined, env: { KUBECTL_EXTERNAL_DIFF: 'diff -u -N' } })
  expect(w.executed).toEqual([])
  expect(w.statuses.at(-1)).toBe('⎈ kubectl apply awaiting approval')

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect((await band.find({ key: 'k8s-hold' }))?.text).toContain('kubectl change held')
    expect((await band.find({ key: 'k8s-object:Deployment shop/web' }))?.text).toContain('+1 −1')
    expect(await band.find({ type: 'Text', text: 'another band' })).toBeDefined()
    await band.unmount()
  }

  const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await band.press({ key: 'k8s-approve' })
  expect(w.submitted.at(-1)).toBe('I approve `kubectl apply -f k8s/ -n shop` on context "staging", namespace "shop". Run exactly that command again now.')
  expect(await band.find({ key: 'k8s-hold' })).toBeUndefined()

  expect((await bash($, 'kubectl  apply -f k8s/ -n shop')).deny).toBeUndefined()
  expect(w.executed).toEqual(['kubectl  apply -f k8s/ -n shop'])
  expect((await bash($, 'kubectl apply -f k8s/ -n shop')).deny).toContain('held for approval')
  expect(w.executed).toHaveLength(1)
})

test('a typed "yes" approves outside production; production needs the button or /k8s-approve', async ($, on) => {
  const w = world(on, 'gke_acme_prod-eu')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const held = await bash($, 'kubectl apply -f deploy.yaml')
  expect(held.deny).toContain('(PRODUCTION)')
  expect(held.deny).toContain('a typed "yes" is not enough on production')
  await say($, 'yes')
  expect((await bash($, 'kubectl apply -f deploy.yaml')).deny).toContain('held for approval')

  expect((await slash($, 'k8s-approve')).text).toBe('Approved once: kubectl apply -f deploy.yaml')
  await w.clock.settle()
  expect(w.submitted.at(-1)).toContain('I approve `kubectl apply -f deploy.yaml` on context "gke_acme_prod-eu"')
  expect((await bash($, 'kubectl apply -f deploy.yaml')).deny).toBeUndefined()
  expect(w.executed).toEqual(['kubectl apply -f deploy.yaml'])
  expect((await slash($, 'k8s-approve')).text).toBe('No kubectl change is waiting for approval.')

  expect((await bash($, 'kubectl --context kind-dev apply -f deploy.yaml')).deny).toContain('context "kind-dev"')
  await say($, 'Yes!')
  expect((await bash($, 'kubectl --context kind-dev apply -f deploy.yaml')).deny).toBeUndefined()
})

test('fails closed on production when no dry run is possible, open elsewhere; no changes run at once', async ($, on) => {
  let reply: Answer = { exitCode: 2, stderr: 'Unable to connect to the server: dial tcp 10.0.0.1:443: i/o timeout' }
  const w = world(on, 'prod', () => reply)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const blocked = await bash($, 'kubectl apply -f k8s/')
  expect(blocked.deny).toContain('k8s-dry-run: blocked. No server-side dry run of this change on production context "prod" was possible (Unable to connect to the server')
  expect(w.executed).toEqual([])

  const ran = await bash($, 'kubectl --context minikube apply -f k8s/')
  expect(ran.deny).toBeUndefined()
  expect(ran.context?.at(-1)).toContain('k8s-dry-run: no dry run was possible (Unable to connect to the server')

  reply = { exitCode: 0, stdout: '' }
  const unchanged = await bash($, 'kubectl apply -f k8s/')
  expect(unchanged.deny).toBeUndefined()
  expect(unchanged.context?.at(-1)).toBe('k8s-dry-run: the server-side dry run showed no changes, so the command ran without asking.')
  expect(w.executed).toEqual(['kubectl --context minikube apply -f k8s/', 'kubectl apply -f k8s/'])
})

test('previews deletes and heredoc manifests, and leaves reads and dry runs alone', async ($, on) => {
  const w = world(on, 'staging', argv =>
    argv.includes('delete') ? { exitCode: 0, stdout: 'deployment.apps/web\nservice/web\n' } : { exitCode: 1, stdout: DIFF },
  )
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const held = await bash($, 'kubectl delete deployment,service web -n shop --wait')
  expect(w.runs.at(-1)?.argv).toEqual(['kubectl', 'delete', 'deployment,service', 'web', '-n', 'shop', '--dry-run=server', '-o', 'name'])
  expect(held.deny).toContain('  - deployment.apps/web (deleted)')
  const band = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await band.find({ key: 'k8s-show' })).toBeUndefined()
  await band.press({ key: 'k8s-reject' })
  expect(w.submitted.at(-1)).toBe('I rejected `kubectl delete deployment,service web -n shop --wait`: do not run it. Tell me what you would change instead.')

  await bash($, "cat <<'EOF' | kubectl apply -f -\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: flags\nEOF")
  expect(w.runs.at(-1)?.argv).toEqual(['kubectl', 'diff', '-f', '-'])
  expect(w.runs.at(-1)?.stdin).toBe('apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: flags\n')
  await bash($, 'cat k8s/web.yaml | kubectl apply -f -')
  expect(w.runs.at(-1)?.argv).toEqual(['kubectl', 'diff', '-f', 'k8s/web.yaml'])
  const piped = await bash($, 'helm template ./chart | kubectl apply -f -')
  expect(piped.context?.at(-1)).toBe('k8s-dry-run: no dry run was possible (its manifests come from another command), so the command ran without a reviewed diff.')

  await bash($, "kubectl apply -f - <<'EOF'\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: flags\nEOF")
  expect(w.runs.at(-1)?.stdin).toBe('apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: flags\n')

  const before = w.runs.length
  await bash($, 'kubectl get pods -n shop')
  await bash($, 'kubectl apply -f k8s/ --dry-run=server')
  expect(w.runs).toHaveLength(before)
  expect(w.executed).toEqual([
    'helm template ./chart | kubectl apply -f -',
    'kubectl get pods -n shop',
    'kubectl apply -f k8s/ --dry-run=server',
  ])
})

test('/k8s-diff shows each object diff on every surface', async ($, on) => {
  const w = world(on, 'staging')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect((await slash($, 'k8s-diff')).text).toBe('No kubectl change is waiting for approval.')
  await bash($, 'kubectl replace -f k8s/web.yaml')
  await slash($, 'k8s-diff')
  expect(w.opened).toEqual(['k8s-diff'])
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'k8s-diff', props: PANE_PROPS })
    const codes = await pane.findAll({ type: 'Code' })
    expect(codes).toHaveLength(2)
    expect(codes[0]?.props.format).toBe('diff')
    expect(codes[0]?.text.startsWith('@@ -6,7 +6,7 @@')).toBe(true)
    expect((await pane.find({ key: 'object:Service shop/web-internal' }))?.text).toContain('+ Service shop/web-internal')
    await pane.unmount()
  }
})

test('reads kubectl calls, their previews and diff output', () => {
  const call = findKubectl('cd deploy && KUBECONFIG=~/.kube/x kubectl --context=stage -n web apply -R -f manifests/ --prune -l app=web --server-side')
  expect(call).toMatchObject({ verb: 'apply', context: 'stage', namespace: 'web', cd: 'deploy' })
  expect(call === undefined ? undefined : previewArgv(call)).toEqual([
    'kubectl', 'diff', '--context=stage', '-n', 'web', '-R', '-f', 'manifests/', '-l', 'app=web', '--server-side',
  ])
  expect(findKubectl('kubectl apply -f - < k8s/all.yaml')?.words).toEqual(['apply', '-f', 'k8s/all.yaml'])
  expect(findKubectl('kubectl apply view-last-applied deploy/web')).toBeUndefined()
  expect(findKubectl('kubectl delete pod x --dry-run=client')).toBeUndefined()
  expect(findKubectl('echo kubectl apply -f x')).toBeUndefined()

  expect(objectName('/tmp/MERGED-1/rbac.authorization.k8s.io.v1.ClusterRole..reader')).toBe('ClusterRole reader')
  const objects = parseDiff(DIFF)
  expect(objects.map(object => [object.name, object.change, object.adds, object.dels])).toEqual([
    ['Deployment shop/web', 'update', 1, 1],
    ['Service shop/web-internal', 'create', 4, 0],
  ])
})

test('a second change in the same command is refused, and wrappers or bash -c do not hide kubectl', async ($, on) => {
  const w = world(on, 'prod')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const chained = await bash($, 'kubectl apply -f unchanged.yaml && kubectl delete deployment web -n shop')
  expect(chained.deny).toContain('makes 2 kubectl changes')
  expect(w.executed).toEqual([])

  for (const command of ['bash -c "kubectl delete ns shop"', 'timeout 60 kubectl apply -f k8s/', 'sudo -E kubectl apply -f k8s/', '(cd k8s && kubectl apply -f .)']) {
    expect(`${command} => ${(await bash($, command)).deny ?? 'RAN'}`).toContain('k8s-dry-run')
  }
  expect(w.executed).toEqual([])
  expect(findKubectls("cd deploy && sh -lc 'kubectl apply -f web.yaml'")).toMatchObject([{ verb: 'apply', words: ['apply', '-f', 'web.yaml'], cd: 'deploy' }])
  expect(findKubectls('nice -n 5 kubectl delete pod x')[0]?.words).toEqual(['delete', 'pod', 'x'])
})

test('with mods-hub: a held change is published as risk.blocked, and the approved run as deploy.started', async ($, on) => {
  const w = world(on, 'prod-eu')
  const hub = fakeHub(on, {}, w.clock)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await w.clock.advance(1_500)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['risk.blocked', 'deploy.started'], consumes: [] }])

  const held = await bash($, 'kubectl apply -n shop -f k8s/')
  expect(held.deny).toContain('held for approval')
  expect(hub.published).toEqual([
    { topic: 'risk.blocked', data: { guard: 'k8s-dry-run', tool: 'Bash', reason: 'held for approval: 2 objects would change', severity: 'high', command: 'kubectl apply -n shop -f k8s/' } },
  ])

  await slash($, 'k8s-approve')
  await bash($, 'kubectl apply -n shop -f k8s/')
  expect(w.executed).toEqual(['kubectl apply -n shop -f k8s/'])
  expect(hub.published.at(-1)).toEqual({ topic: 'deploy.started', data: { target: 'kubectl apply -n shop', environment: 'prod-eu' }, scope: 'global' })
})
