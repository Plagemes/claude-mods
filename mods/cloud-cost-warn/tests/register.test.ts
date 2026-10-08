import type { On } from 'claude-code'
import { test, expect } from 'claude-code/testing'

import { findExpensive } from '../hooks/cost'
import { fakeHub } from './hub'

const PERSON = { wait: false, origin: { kind: 'composer' } } as const

/** Stands in for the engine: records the commands that reach the Bash tool and lets prompts through. */
function engine(on: On) {
  const ran: string[] = []
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash') ran.push(e.command)
    return { result: 'ran' }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  return ran
}

const EXPENSIVE = [
  'aws ec2 run-instances --image-id ami-123 --instance-type p4d.24xlarge --count 1',
  'aws ec2 run-instances --instance-type=g5.xlarge --image-id ami-123',
  'aws --region us-west-2 ec2 run-instances --instance-type g4dn.xlarge --image-id ami-123',
  'aws ec2 run-instances --instance-type x2idn.16xlarge --image-id ami-123',
  'aws ec2 run-instances --instance-type m5.metal --image-id ami-123',
  'aws ec2 run-instances --instance-type c6i.16xlarge --image-id ami-123',
  'aws ec2 run-instances --instance-type inf2.xlarge --image-id ami-123',
  'aws rds create-db-instance --db-instance-identifier prod --db-instance-class db.r6g.16xlarge --engine postgres',
  'aws rds create-db-instance --db-instance-class db.r6g.4xlarge --multi-az --engine postgres',
  'aws eks create-cluster --name demo --role-arn arn:aws:iam::1:role/x',
  'eksctl create cluster --name demo --node-type m5.xlarge --nodes 3',
  'eksctl create cluster --name demo',
  'gcloud compute instances create trainer --machine-type=a2-highgpu-1g',
  'gcloud compute instances create trainer --machine-type n1-standard-8 --accelerator type=nvidia-tesla-t4,count=2',
  'gcloud compute instances create big --machine-type=n2-standard-64',
  'gcloud compute instances create mem --machine-type m1-ultramem-160',
  'gcloud beta compute instances create gpu --machine-type g2-standard-4',
  'gcloud container clusters create demo --num-nodes 3 --machine-type e2-standard-4',
  'az vm create --name gpu --resource-group rg --image Ubuntu2204 --size Standard_NC24s_v3',
  'az vm create -n gpu -g rg --image Ubuntu2204 --size Standard_ND96asr_v4',
  'az aks create --resource-group rg --name demo --node-count 5',
  'AWS_PROFILE=dev aws ec2 run-instances --instance-type p3.2xlarge --image-id ami-1',
  'terraform fmt && aws ec2 run-instances --instance-type p3.2xlarge --image-id ami-1',
]

const CHEAP = [
  'aws ec2 run-instances --instance-type t3.micro --image-id ami-123',
  'aws ec2 run-instances --instance-type m5.large --count 2 --image-id ami-123',
  'aws ec2 run-instances --instance-type c6i.4xlarge --image-id ami-123',
  'aws ec2 run-instances --instance-type p4d.24xlarge --image-id ami-123 --dry-run',
  'aws ec2 run-instances --launch-template LaunchTemplateName=web',
  'aws ec2 describe-instances',
  'aws ec2 terminate-instances --instance-ids i-123',
  'aws rds create-db-instance --db-instance-class db.t3.micro --engine postgres',
  'aws rds describe-db-instances',
  'aws s3 ls',
  'eksctl get cluster',
  'gcloud compute instances create web --machine-type=e2-small',
  'gcloud compute instances create web --machine-type=n2-standard-8',
  'gcloud compute instances list',
  'gcloud container clusters list',
  'az vm create --name web --resource-group rg --image Ubuntu2204 --size Standard_D2s_v5',
  'az vm list',
  'az aks list',
  'echo "aws ec2 run-instances --instance-type p4d.24xlarge"',
  'git commit -m "document eksctl create cluster"',
  'ls -la',
]

test('denies commands that create GPU, huge or standing resources, and puts a price on them', async ($, on) => {
  const ran = engine(on)
  for (const command of EXPENSIVE) {
    const result = await $.tool.call({ tool: 'Bash', command })
    expect(`${command} => ${result.deny ?? 'ALLOWED'}`).toContain('cloud-cost-warn')
    expect(result.deny).toMatch(/roughly \$[\d.,]+-\$[\d.,]+ per hour \(about \$[\d.,]+-\$[\d.,]+ a month\)/)
    expect(result.deny).toContain('COST-OK')
  }
  expect(ran).toHaveLength(0)
})

test('leaves small instances, dry runs, reads and unrelated commands alone', async ($, on) => {
  const ran = engine(on)
  for (const command of CHEAP) {
    const result = await $.tool.call({ tool: 'Bash', command })
    expect(`${command} => ${result.deny ?? 'allowed'}`).toBe(`${command} => allowed`)
  }
  expect(ran).toHaveLength(CHEAP.length)
})

test('estimates scale with the size and the count', async ($, on) => {
  engine(on)
  const one = await $.tool.call({ tool: 'Bash', command: 'aws ec2 run-instances --instance-type p3.2xlarge --image-id ami-1' })
  expect(one.deny).toContain('an EC2 instance (p3.2xlarge), roughly $2.60-$3.67 per hour')
  const three = await $.tool.call({ tool: 'Bash', command: 'aws ec2 run-instances --instance-type p3.2xlarge --count 3 --image-id ami-1' })
  expect(three.deny).toContain('3 EC2 instances (p3.2xlarge each), roughly $7.80-$11.02 per hour')
  const gcp = await $.tool.call({ tool: 'Bash', command: 'gcloud compute instances create a b --machine-type=a2-highgpu-1g' })
  expect(gcp.deny).toContain('2 Compute Engine VMs (a2-highgpu-1g each)')
})

test('COST-OK in the latest message from the person opens the gate, the next message closes it', async ($, on) => {
  const ran = engine(on)
  const command = 'eksctl create cluster --name demo'
  expect((await $.tool.call({ tool: 'Bash', command })).deny).toContain('cloud-cost-warn')

  await $.prompt.submit({ ...PERSON, text: 'spin up a cluster, COST-OK' })
  expect((await $.tool.call({ tool: 'Bash', command })).deny).toBeUndefined()
  expect(ran).toEqual([command])

  await $.prompt.submit({ ...PERSON, text: 'and now deploy the app' })
  expect((await $.tool.call({ tool: 'Bash', command })).deny).toContain('cloud-cost-warn')
})

test('COST-OK from a notification or another plugin is not an approval', async ($, on) => {
  engine(on)
  await $.prompt.submit({ text: 'COST-OK', wait: false, origin: { kind: 'task-notification' } })
  await $.prompt.submit({ text: 'COST-OK', wait: false, origin: { kind: 'plugin', name: 'other' } })
  const result = await $.tool.call({ tool: 'Bash', command: 'aws ec2 run-instances --instance-type g5.xlarge --image-id ami-1' })
  expect(result.deny).toContain('cloud-cost-warn')
})

test('largeSize sets the size from which ordinary instances count as expensive', { options: { largeSize: '4xlarge' } }, async ($, on) => {
  engine(on)
  const result = await $.tool.call({ tool: 'Bash', command: 'aws ec2 run-instances --instance-type c6i.4xlarge --image-id ami-1' })
  expect(result.deny).toContain('c6i.4xlarge')
  const small = await $.tool.call({ tool: 'Bash', command: 'aws ec2 run-instances --instance-type c6i.2xlarge --image-id ami-1' })
  expect(small.deny).toBeUndefined()
})

test('regression: a command handed to bash -c, sh -lc or eval is checked too', () => {
  expect(findExpensive('bash -c "aws ec2 run-instances --instance-type p3.2xlarge --image-id ami-1"', 32)[0]?.what).toBe('an EC2 instance (p3.2xlarge)')
  expect(findExpensive("sh -lc 'eksctl create cluster --nodes 3'", 32)[0]?.what).toContain('EKS cluster with 3')
  expect(findExpensive('eval aws ec2 run-instances --instance-type p4d.24xlarge', 32)).toHaveLength(1)
  expect(findExpensive('bash -c "echo aws ec2 run-instances --instance-type p3.2xlarge"', 32)).toHaveLength(0)
  // The shared shell reader: wrappers, substitutions, heredocs fed to a shell; a heredoc note is only text.
  expect(findExpensive('timeout 60 aws ec2 run-instances --instance-type p3.2xlarge --image-id ami-1', 32)).toHaveLength(1)
  expect(findExpensive('ID=$(aws ec2 run-instances --instance-type p3.2xlarge --query x)', 32)).toHaveLength(1)
  expect(findExpensive('bash <<EOF\neksctl create cluster --nodes 3\nEOF', 32)).toHaveLength(1)
  expect(findExpensive("cat <<'EOF' > plan.md\neksctl create cluster --nodes 3\nEOF", 32)).toHaveLength(0)
})

test('regression: COST-OK does not carry into a turn the person did not start', async ($, on) => {
  engine(on)
  const command = 'eksctl create cluster --name demo'
  await $.prompt.submit({ ...PERSON, text: 'spin up a cluster, COST-OK' })
  expect((await $.tool.call({ tool: 'Bash', command })).deny).toBeUndefined()
  // Delivered into the approved turn: it stays approved.
  await $.prompt.submit({ text: 'task done', wait: false, origin: { kind: 'task-notification' }, turnId: 'turn-1' })
  expect((await $.tool.call({ tool: 'Bash', command })).deny).toBeUndefined()
  // A notification that starts a turn of its own is not approved.
  await $.prompt.submit({ text: 'task done', wait: false, origin: { kind: 'task-notification' } })
  expect((await $.tool.call({ tool: 'Bash', command })).deny).toContain('cloud-cost-warn')
})

test('with mods-hub: a deny is published as risk.blocked with the estimate', async ($, on) => {
  engine(on)
  const hub = fakeHub(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve() // the hello waits for session.start to return (afterStart)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['risk.blocked'], consumes: [] }])
  const command = 'eksctl create cluster --name demo --node-type m5.xlarge --nodes 3'
  expect((await $.tool.call({ tool: 'Bash', command })).deny).toContain('cloud-cost-warn')
  expect(hub.published).toHaveLength(1)
  const [event] = hub.published
  expect(event?.topic).toBe('risk.blocked')
  expect(event?.data).toMatchObject({ guard: 'cloud-cost-warn', tool: 'Bash', severity: 'medium', command })
  expect(String((event?.data as { reason?: unknown }).reason)).toMatch(/^costly-resource: would create an EKS cluster with 3 .* per hour$/)
})
