import type { On } from 'claude-code'
import { mock, test, expect } from 'claude-code/testing'

import { fakeHub } from './hub'

const PERSON = { wait: false, origin: { kind: 'composer' } } as const

/** Stands in for the engine; `kubeContext` is what `kubectl config current-context` prints. */
function engine(on: On, kubeContext: string | undefined = undefined) {
  on('tool.call', () => ({ result: 'ran' }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('process.run', () => ({
    value: {
      exitCode: kubeContext === undefined ? 1 : 0,
      stdout: `${kubeContext ?? ''}\n`,
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
}

const RISKY = [
  'terraform apply -auto-approve',
  'terraform -chdir=infra destroy',
  'tofu apply',
  'terragrunt run-all apply',
  'pulumi up --yes',
  'pulumi destroy',
  'kubectl --context=prod-eu apply -f deploy.yaml',
  'kubectl delete pod web-1 --namespace production',
  'kubectl -n prod rollout restart deploy/api',
  'helm upgrade api ./chart --kube-context prod-eu',
  'helm upgrade --install api ./chart -f values-prod.yaml',
  'psql "$DATABASE_URL" -c "DROP TABLE users"',
  'mysql -e "truncate table orders"',
  'psql -c "DELETE FROM sessions;"',
  'echo "delete from users" | psql mydb',
  'aws ec2 terminate-instances --instance-ids i-123',
  'aws s3api delete-bucket --bucket data',
  'aws s3 rm s3://data --recursive',
]

const SAFE = [
  'terraform plan',
  'terraform init && terraform validate',
  'kubectl --context=staging apply -f deploy.yaml',
  'kubectl --context=prod-eu get pods',
  'kubectl rollout status deploy/api -n prod --context prod',
  'kubectl delete pod web-1 --context=prod --dry-run=client',
  'helm upgrade api ./chart --kube-context staging',
  'helm upgrade product-api ./chart --kube-context dev',
  'helm list -n prod',
  'psql -c "SELECT count(*) FROM users"',
  'psql -c "DELETE FROM sessions WHERE expired"',
  'git commit -m "remove psql DROP TABLE step"',
  'aws s3 ls',
  'aws ec2 describe-instances',
  'ls -la',
]

test('denies production-affecting commands and explains how to approve them', async ($, on) => {
  engine(on)
  for (const command of RISKY) {
    const result = await $.tool.call({ tool: 'Bash', command })
    expect(`${command} => ${result.deny ?? 'ALLOWED'}`).toContain('prod-guard')
    expect(result.deny).toContain('PROD-OK')
  }
})

test('leaves read-only, staging and dry-run commands alone', async ($, on) => {
  engine(on, 'staging')
  for (const command of SAFE) {
    const result = await $.tool.call({ tool: 'Bash', command })
    expect(`${command} => ${result.deny ?? 'allowed'}`).toBe(`${command} => allowed`)
  }
})

test('the latest prompt from the person decides: PROD-OK opens the gate, the next prompt closes it', async ($, on) => {
  engine(on)
  const apply = { tool: 'Bash', command: 'terraform apply' } as const
  expect((await $.tool.call(apply)).deny).toContain('prod-guard')

  await $.prompt.submit({ ...PERSON, text: 'ship it, PROD-OK' })
  expect((await $.tool.call(apply)).deny).toBeUndefined()

  await $.prompt.submit({ ...PERSON, text: 'now something else' })
  expect((await $.tool.call(apply)).deny).toContain('prod-guard')
})

test('PROD-OK that does not come from the person (a notification, a plugin) is not an approval', async ($, on) => {
  engine(on)
  await $.prompt.submit({ text: 'PROD-OK', wait: false, origin: { kind: 'task-notification' } })
  await $.prompt.submit({ text: 'PROD-OK', wait: false, origin: { kind: 'plugin', name: 'other' } })
  const result = await $.tool.call({ tool: 'Bash', command: 'pulumi up' })
  expect(result.deny).toContain('prod-guard')
})

test('an implicit kubectl context is looked up and judged', async ($, on) => {
  engine(on, 'gke_acme_prod-cluster')
  const result = await $.tool.call({ tool: 'Bash', command: 'kubectl apply -f deploy.yaml' })
  expect(result.deny).toContain('gke_acme_prod-cluster')
})

test('prodPattern is configurable', { options: { prodPattern: 'eu-west|acme-live' } }, async ($, on) => {
  engine(on)
  expect((await $.tool.call({ tool: 'Bash', command: 'kubectl --context=eu-west-1 delete ns x' })).deny).toContain('prod-guard')
  expect((await $.tool.call({ tool: 'Bash', command: 'kubectl --context=prod delete ns x' })).deny).toBeUndefined()
})

test('commands wrapped in bash -c, sh -lc or eval are read too', async ($, on) => {
  engine(on)
  for (const command of [
    `bash -c 'kubectl delete pod web-1 --context prod'`,
    `sh -lc "terraform apply -auto-approve"`,
    `sudo bash -c "cd infra && pulumi destroy"`,
    `eval "helm upgrade api ./chart --kube-context prod-eu"`,
    // The shared shell reader: substitutions, heredocs fed to a shell, su -c, and a shell further along.
    `echo "$(terraform destroy -auto-approve)"`,
    'bash <<EOF\nkubectl delete ns api --context prod\nEOF',
    `su -c 'pulumi up --yes' deploy`,
    `docker exec ops sh -c "terraform apply"`,
  ]) {
    expect(`${command} => ${(await $.tool.call({ tool: 'Bash', command })).deny ?? 'ALLOWED'}`).toContain('prod-guard')
  }
  expect((await $.tool.call({ tool: 'Bash', command: `bash -c 'terraform plan'` })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: "cat <<'EOF' > runbook.md\nterraform destroy\nEOF" })).deny).toBeUndefined()
})

test('an approval does not carry into a turn the person did not start', async ($, on) => {
  engine(on)
  const apply = { tool: 'Bash', command: 'terraform apply' } as const
  await $.prompt.submit({ ...PERSON, text: 'ship it, PROD-OK' })
  expect((await $.tool.call(apply)).deny).toBeUndefined()
  // Delivered into the approved turn: it stays approved.
  await $.prompt.submit({ text: 'task done', wait: false, origin: { kind: 'task-notification' }, turnId: 'turn-1' })
  expect((await $.tool.call(apply)).deny).toBeUndefined()
  // A notification that starts a turn of its own is not approved.
  await $.prompt.submit({ text: 'task done', wait: false, origin: { kind: 'task-notification' } })
  expect((await $.tool.call(apply)).deny).toContain('prod-guard')
})

test('with mods-hub: a deny is published as risk.blocked, and a production deploy on the bus is mentioned', async ($, on) => {
  mock.clock(on, { now: 10_000_000 })
  engine(on)
  const hub = fakeHub(on)
  hub.events.push({ topic: 'deploy.started', data: { target: 'api', environment: 'production' }, at: 10_000_000 - 5 * 60_000, source: 'deploy-checklist' })
  const result = await $.tool.call({ tool: 'Bash', command: 'PGPASSWORD=Xk9pQ2vL7mR4tZ8w psql -c "DROP TABLE users"' })
  expect(result.deny).toContain('A production deploy (api → production) was announced in the last 30 minutes.')
  expect(hub.published).toEqual([
    {
      topic: 'risk.blocked',
      data: {
        guard: 'prod-guard',
        tool: 'Bash',
        reason: 'sql-drop: a DROP TABLE/DATABASE/SCHEMA statement can change production',
        severity: 'high',
        command: 'PGPASSWORD=[REDACTED:secret] psql -c "DROP TABLE users"',
      },
    },
  ])
})

test('with mods-hub: an old or non-production deploy is not mentioned, and hello lists what it trades', async ($, on) => {
  mock.clock(on, { now: 10_000_000 })
  engine(on)
  const hub = fakeHub(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  hub.events.push({ topic: 'deploy.started', data: { target: 'api', environment: 'staging' }, at: 10_000_000 - 60_000, source: 'deploy-checklist' })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['risk.blocked'], consumes: ['deploy.started'] }])
  expect((await $.tool.call({ tool: 'Bash', command: 'terraform apply' })).deny).not.toContain('deploy (')
})
