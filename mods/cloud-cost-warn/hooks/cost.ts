import {
  AKS_DEFAULT_NODES, AZURE_DEFAULT_NODE_HOURLY, AZURE_DEFAULT_RANGE, AZURE_HOURLY, AZURE_SERIES, CONTROL_PLANE_HOURLY,
  EC2_ACCELERATED, EC2_ACCELERATED_PER_VCPU, EC2_DEFAULT_PER_VCPU, EC2_HOURLY, EC2_MEMORY_HEAVY, EC2_PER_VCPU,
  EKS_DEFAULT_NODES, EKS_DEFAULT_NODE_TYPE, GCP_ACCELERATORS, GCP_DEFAULT_GPU, GCP_DEFAULT_PER_VCPU, GCP_GPU_FAMILIES,
  GCP_MEMORY_FAMILIES, GCP_PER_VCPU, GKE_DEFAULT_MACHINE, GKE_DEFAULT_NODES, RDS_DEFAULT_PER_VCPU, RDS_PER_VCPU,
} from './prices'
import { simpleCommands } from './shared/shell'

export type Estimate = {
  /** The command, as typed (shortened). */
  command: string
  /** What it would create, in a few words. */
  what: string
  /** Estimated cost per hour: low and high. */
  low: number
  high: number
  /** A cheaper way to get what is needed. */
  tip: string
}

type Range = readonly [number, number]

const SPREAD: Range = [0.85, 1.2]
export const HOURS_PER_MONTH = 730
const MAX_COMMAND_LENGTH = 90
const DEFAULT_LARGE_VCPUS = 32
const METAL_VCPUS = 96
const SMALL_SIZES: Readonly<Record<string, number>> = { nano: 1, micro: 1, small: 1, medium: 2, large: 2 }
/** gcloud flags that take no value, so the word after them is a name, not a value. */
const GCLOUD_SWITCH = /^--(?:no-|enable-|preemptible$|spot$|async$|quiet$|can-ip-forward$|deletion-protection$|shielded-)/
const G2_GPUS: Readonly<Record<number, number>> = { 24: 2, 48: 4, 96: 8 }

const estimate = (command: string, what: string, [low, high]: Range, tip: string): Estimate => ({ command, what, low, high, tip })
const around = (hourly: number): Range => [hourly * SPREAD[0], hourly * SPREAD[1]]
const plus = (a: Range, b: Range): Range => [a[0] + b[0], a[1] + b[1]]
const times = (a: Range, n: number): Range => [a[0] * n, a[1] * n]

/** vCPUs of an instance size word: `xlarge` 4, `8xlarge` 32, `metal` as a large host. */
export function vcpusOfSize(size: string): number | undefined {
  if (size === 'metal' || size.startsWith('metal-')) return METAL_VCPUS
  const multiple = /^(\d*)xlarge$/.exec(size)
  if (multiple !== null) return 4 * Number(multiple[1] === '' ? 1 : multiple[1])
  return SMALL_SIZES[size]
}

/** How many vCPUs the `largeSize` setting stands for; 8xlarge (32) when it is not a size. */
export function largeThreshold(setting: string): number {
  return vcpusOfSize(setting.trim().toLowerCase()) ?? DEFAULT_LARGE_VCPUS
}

/** The value of `--name value` or `--name=value`. */
function flagValue(words: readonly string[], ...names: string[]): string | undefined {
  for (const [index, word] of words.entries()) {
    for (const name of names) {
      if (word === name) return words[index + 1]
      if (word.startsWith(`${name}=`)) return word.slice(name.length + 1)
    }
  }
  return undefined
}

const hasFlag = (words: readonly string[], ...names: string[]): boolean => words.some(word => names.includes(word.split('=')[0] ?? word))

function hasSequence(words: readonly string[], sequence: readonly string[]): boolean {
  return words.some((_, start) => sequence.every((word, offset) => words[start + offset] === word))
}

const numberOr = (text: string | undefined, fallback: number): number => {
  const value = Number(text)
  return text !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

type Ec2Size = { type: string; letters: string; vcpus: number | undefined }

function parseEc2Type(type: string): Ec2Size | undefined {
  const match = /^([a-z]+)\d+[a-z-]*\.([a-z0-9-]+)$/.exec(type)
  return match === null ? undefined : { type, letters: match[1] as string, vcpus: vcpusOfSize(match[2] as string) }
}

function ec2Hourly({ type, letters, vcpus }: Ec2Size): Range {
  const exact = EC2_HOURLY[type]
  if (exact !== undefined) return around(exact)
  const rate = EC2_ACCELERATED.has(letters) ? EC2_ACCELERATED_PER_VCPU : (EC2_PER_VCPU[letters] ?? EC2_DEFAULT_PER_VCPU)
  return around(rate * (vcpus ?? 8))
}

function isLargeEc2({ letters, vcpus }: Ec2Size, large: number): boolean {
  return EC2_ACCELERATED.has(letters) || EC2_MEMORY_HEAVY.has(letters) || (vcpus !== undefined && vcpus >= large)
}

function awsEc2(words: readonly string[], large: number, command: string): Estimate[] {
  if (!hasSequence(words, ['ec2', 'run-instances']) || hasFlag(words, '--dry-run', '--help', '--generate-cli-skeleton')) return []
  const size = parseEc2Type(flagValue(words, '--instance-type') ?? '')
  if (size === undefined || !isLargeEc2(size, large)) return []
  const count = numberOr((flagValue(words, '--count') ?? '').split(':').pop(), 1)
  return [
    estimate(
      command,
      count > 1 ? `${count} EC2 instances (${size.type} each)` : `an EC2 instance (${size.type})`,
      times(ec2Hourly(size), count),
      'a smaller instance type, a spot instance, or a local GPU/dev box for experiments',
    ),
  ]
}

function awsRds(words: readonly string[], large: number, command: string): Estimate[] {
  if (!hasSequence(words, ['rds', 'create-db-instance']) || hasFlag(words, '--help', '--generate-cli-skeleton')) return []
  const match = /^db\.([a-z]+)\d*[a-z-]*\.([a-z0-9-]+)$/.exec(flagValue(words, '--db-instance-class') ?? '')
  const vcpus = match === null ? undefined : vcpusOfSize(match[2] as string)
  if (match === null || vcpus === undefined) return []
  const isMultiAz = hasFlag(words, '--multi-az')
  if (vcpus < (isMultiAz ? large / 2 : large)) return []
  const hourly = vcpus * (RDS_PER_VCPU[match[1] as string] ?? RDS_DEFAULT_PER_VCPU) * (isMultiAz ? 2 : 1)
  return [
    estimate(
      command,
      `an RDS database (${match[0]}${isMultiAz ? ', multi-AZ' : ''})`,
      around(hourly),
      'a smaller class for development, or a local Postgres/MySQL container',
    ),
  ]
}

function eks(words: readonly string[], command: string): Estimate[] {
  if (hasFlag(words, '--help', '--dry-run')) return []
  const isEksctl = hasSequence(words, ['create', 'cluster'])
  if (!isEksctl && !hasSequence(words, ['eks', 'create-cluster'])) return []
  const nodeType = flagValue(words, '--node-type') ?? EKS_DEFAULT_NODE_TYPE
  const parsed = parseEc2Type(nodeType)
  const nodes = numberOr(flagValue(words, '--nodes', '-N'), EKS_DEFAULT_NODES)
  const control: Range = [CONTROL_PLANE_HOURLY, CONTROL_PLANE_HOURLY]
  const range = isEksctl && parsed !== undefined ? plus(control, times(ec2Hourly(parsed), nodes)) : control
  return [
    estimate(
      command,
      isEksctl ? `an EKS cluster with ${nodes} x ${nodeType} nodes` : 'an EKS cluster (control plane only; nodes are extra)',
      range,
      'a local cluster (kind, minikube, k3d) for development',
    ),
  ]
}

type GcpMachine = { hourly: Range; isHeavy: boolean }

/** Price and weight of a Compute Engine machine type such as n2-standard-32 or a2-highgpu-8g. */
function gcpMachine(type: string, large: number): GcpMachine {
  const family = type.split('-')[0] ?? ''
  const count = Number(/-custom-(\d+)-/.exec(type)?.[1] ?? /-(\d+)g?$/.exec(type)?.[1] ?? Number.NaN)
  const gpuRate = GCP_GPU_FAMILIES[family]
  if (gpuRate !== undefined) {
    const gpus = family === 'g2' ? (G2_GPUS[count] ?? 1) : Number.isFinite(count) ? count : 1
    const vmShare = family === 'g2' ? (Number.isFinite(count) ? count : 4) * 0.03 : 0
    return { hourly: around(gpus * gpuRate + vmShare), isHeavy: true }
  }
  const vcpus = Number.isFinite(count) ? count : 2
  const rate = GCP_PER_VCPU[family] ?? GCP_DEFAULT_PER_VCPU
  return { hourly: around(vcpus * rate), isHeavy: GCP_MEMORY_FAMILIES.has(family) || vcpus >= large }
}

function acceleratorHourly(words: readonly string[]): Range | undefined {
  const spec = flagValue(words, '--accelerator')
  if (spec === undefined) return undefined
  const type = /type=([\w-]+)/.exec(spec)?.[1] ?? ''
  const count = numberOr(/count=(\d+)/.exec(spec)?.[1], 1)
  return around(count * (GCP_ACCELERATORS[type] ?? GCP_DEFAULT_GPU))
}

/** Names after `create`, not counting the values of flags. */
function instanceNames(words: readonly string[]): number {
  const start = words.lastIndexOf('create') + 1
  let names = 0
  for (let index = start; index < words.length; index += 1) {
    const word = words[index] as string
    if (!word.startsWith('-')) names += 1
    else if (!word.includes('=') && !GCLOUD_SWITCH.test(word)) index += 1
  }
  return Math.max(names, 1)
}

function gcloudInstance(words: readonly string[], large: number, command: string): Estimate[] {
  if (!hasSequence(words, ['compute', 'instances', 'create']) || hasFlag(words, '--help')) return []
  const type = flagValue(words, '--machine-type') ?? 'n1-standard-1'
  const machine = gcpMachine(type, large)
  const accelerator = acceleratorHourly(words)
  if (!machine.isHeavy && accelerator === undefined) return []
  const count = instanceNames(words)
  const one = accelerator === undefined ? machine.hourly : plus(machine.hourly, accelerator)
  return [
    estimate(
      command,
      `${count > 1 ? `${count} Compute Engine VMs` : 'a Compute Engine VM'} (${type}${accelerator === undefined ? '' : ' with GPU'}${count > 1 ? ' each' : ''})`,
      times(one, count),
      'a smaller machine type, a spot VM (--provisioning-model=SPOT), or fewer GPUs',
    ),
  ]
}

function gke(words: readonly string[], large: number, command: string): Estimate[] {
  if (!hasSequence(words, ['container', 'clusters', 'create']) || hasFlag(words, '--help')) return []
  const type = flagValue(words, '--machine-type') ?? GKE_DEFAULT_MACHINE
  const nodes = numberOr(flagValue(words, '--num-nodes'), GKE_DEFAULT_NODES)
  const accelerator = acceleratorHourly(words)
  const node = plus(gcpMachine(type, large).hourly, accelerator ?? [0, 0])
  return [
    estimate(
      command,
      `a GKE cluster with ${nodes} x ${type} nodes${accelerator === undefined ? '' : ' with GPUs'}`,
      plus(times(node, nodes), [CONTROL_PLANE_HOURLY, CONTROL_PLANE_HOURLY]),
      'a local cluster (kind, minikube, k3d), or fewer and smaller nodes',
    ),
  ]
}

/** `Standard_NC24s_v3` costs by its exact name, else by its series (NC, ND, NV ...). */
function azureHourly(size: string): Range | undefined {
  const name = size.replace(/^Standard_/i, '')
  const exact = AZURE_HOURLY[name]
  if (exact !== undefined) return around(exact)
  const series = /^(N[A-Z])\d/.exec(name)?.[1]
  return series === undefined ? undefined : (AZURE_SERIES[series] ?? AZURE_DEFAULT_RANGE)
}

function azureVm(words: readonly string[], command: string): Estimate[] {
  if (!hasSequence(words, ['vm', 'create']) || hasFlag(words, '--help')) return []
  const size = flagValue(words, '--size') ?? ''
  const hourly = /^Standard_N[A-Z]/i.test(size) ? azureHourly(size) : undefined
  if (hourly === undefined) return []
  return [estimate(command, `an Azure VM (${size})`, hourly, 'a smaller N-series size, a spot VM (--priority Spot), or a CPU size for development')]
}

function aks(words: readonly string[], command: string): Estimate[] {
  if (!hasSequence(words, ['aks', 'create']) || hasFlag(words, '--help')) return []
  const size = flagValue(words, '--node-vm-size')
  const nodes = numberOr(flagValue(words, '--node-count'), AKS_DEFAULT_NODES)
  const node = size === undefined ? undefined : azureHourly(size)
  return [
    estimate(
      command,
      `an AKS cluster with ${nodes} x ${size ?? 'default'} nodes`,
      times(node ?? around(AZURE_DEFAULT_NODE_HOURLY), nodes),
      'a local cluster (kind, minikube, k3d), or fewer and smaller nodes',
    ),
  ]
}

/**
 * Commands of the line that create expensive cloud resources, with a rough hourly cost; reads text, runs nothing.
 * The shared shell reader peels wrappers (`sudo`, `env`, `timeout`, ...) and opens `bash -c`, `eval`, `$(…)` and
 * heredocs fed to a shell.
 */
export function findExpensive(line: string, large: number): Estimate[] {
  return simpleCommands(line).flatMap(({ argv: words, name: tool }) => {
    const shown = words.join(' ')
    const command = shown.length > MAX_COMMAND_LENGTH ? `${shown.slice(0, MAX_COMMAND_LENGTH)}...` : shown
    switch (tool) {
      case 'aws':
        return [...awsEc2(words, large, command), ...awsRds(words, large, command), ...eks(words, command)]
      case 'eksctl':
        return eks(words, command)
      case 'gcloud':
        return [...gcloudInstance(words, large, command), ...gke(words, large, command)]
      case 'az':
        return [...azureVm(words, command), ...aks(words, command)]
      default:
        return []
    }
  })
}

const group = (n: number): string => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')

export function money(n: number): string {
  return n < 100 ? `$${n.toFixed(2)}` : `$${group(n)}`
}
