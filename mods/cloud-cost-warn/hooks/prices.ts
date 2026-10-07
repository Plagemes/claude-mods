/** Rough on-demand list prices in USD per hour (us regions, Linux), for estimates only. */

/** EC2 instance types that cost real money, by exact name. */
export const EC2_HOURLY: Readonly<Record<string, number>> = {
  'p2.xlarge': 0.9, 'p2.8xlarge': 7.2, 'p2.16xlarge': 14.4,
  'p3.2xlarge': 3.06, 'p3.8xlarge': 12.24, 'p3.16xlarge': 24.48, 'p3dn.24xlarge': 31.22,
  'p4d.24xlarge': 27, 'p4de.24xlarge': 34, 'p5.48xlarge': 75, 'p5e.48xlarge': 85, 'p5en.48xlarge': 85,
  'g3.4xlarge': 1.14, 'g3.8xlarge': 2.28, 'g3.16xlarge': 4.56,
  'g4dn.xlarge': 0.53, 'g4dn.2xlarge': 0.75, 'g4dn.4xlarge': 1.2, 'g4dn.8xlarge': 2.18, 'g4dn.12xlarge': 3.91, 'g4dn.16xlarge': 4.35, 'g4dn.metal': 7.82,
  'g5.xlarge': 1.01, 'g5.2xlarge': 1.21, 'g5.4xlarge': 1.62, 'g5.8xlarge': 2.45, 'g5.12xlarge': 5.67, 'g5.16xlarge': 4.1, 'g5.24xlarge': 8.14, 'g5.48xlarge': 16.29,
  'g6.xlarge': 0.8, 'g6.2xlarge': 0.98, 'g6.4xlarge': 1.32, 'g6.8xlarge': 2.0, 'g6.12xlarge': 4.6, 'g6.16xlarge': 3.4, 'g6.24xlarge': 6.7, 'g6.48xlarge': 13.35,
  'g6e.xlarge': 1.86, 'g6e.12xlarge': 10.49, 'g6e.48xlarge': 30.13,
  'inf1.xlarge': 0.23, 'inf1.6xlarge': 1.18, 'inf1.24xlarge': 4.72, 'inf2.xlarge': 0.76, 'inf2.8xlarge': 1.97, 'inf2.24xlarge': 6.49, 'inf2.48xlarge': 12.98,
  'trn1.2xlarge': 1.34, 'trn1.32xlarge': 21.5, 'trn1n.32xlarge': 24.78,
  'x1.16xlarge': 6.67, 'x1.32xlarge': 13.34, 'x1e.32xlarge': 26.69,
  'x2idn.16xlarge': 6.67, 'x2idn.24xlarge': 10.0, 'x2idn.32xlarge': 13.34, 'x2iedn.32xlarge': 26.69,
}

/** Per vCPU-hour, by the letters of the instance family (m5 -> m); used when the exact type is not listed. */
export const EC2_PER_VCPU: Readonly<Record<string, number>> = {
  c: 0.0425, m: 0.048, r: 0.063, t: 0.042, a: 0.04, i: 0.078, d: 0.1, h: 0.06, x: 0.17, u: 0.2, z: 0.1,
}
export const EC2_DEFAULT_PER_VCPU = 0.06
/** GPU and accelerator families (p, g, inf, trn, dl, vt, f). */
export const EC2_ACCELERATED = new Set(['p', 'g', 'inf', 'trn', 'dl', 'vt', 'f'])
export const EC2_ACCELERATED_PER_VCPU = 0.3
/** Memory-optimised families that count as expensive whatever their size. */
export const EC2_MEMORY_HEAVY = new Set(['x', 'u'])

/** RDS: per vCPU-hour by the letters of the instance class (db.r6g.xlarge -> r), single-AZ. */
export const RDS_PER_VCPU: Readonly<Record<string, number>> = { r: 0.13, x: 0.2, m: 0.075, t: 0.03, z: 0.1 }
export const RDS_DEFAULT_PER_VCPU = 0.1

/** Compute Engine per vCPU-hour by family; memory-optimised families are always flagged. */
export const GCP_PER_VCPU: Readonly<Record<string, number>> = {
  n1: 0.0475, n2: 0.0485, n2d: 0.042, n4: 0.047, e2: 0.0335, c2: 0.0522, c3: 0.0497, c4: 0.0522, t2d: 0.0422, m1: 0.111, m2: 0.2, m3: 0.1, m4: 0.1,
}
export const GCP_DEFAULT_PER_VCPU = 0.05
export const GCP_MEMORY_FAMILIES = new Set(['m1', 'm2', 'm3', 'm4'])
/** Families that come with GPUs attached: price per GPU-hour (a2/a3/a4, g2). */
export const GCP_GPU_FAMILIES: Readonly<Record<string, number>> = { a2: 3.67, a3: 11.06, a4: 14, g2: 0.71 }
/** Attachable GPUs (--accelerator type=...), per GPU-hour. */
export const GCP_ACCELERATORS: Readonly<Record<string, number>> = {
  'nvidia-tesla-t4': 0.35, 'nvidia-l4': 0.71, 'nvidia-tesla-v100': 2.48, 'nvidia-tesla-p100': 1.46, 'nvidia-tesla-p4': 0.6,
  'nvidia-tesla-k80': 0.45, 'nvidia-tesla-a100': 3.67, 'nvidia-a100-80gb': 5.07, 'nvidia-h100-80gb': 11.06, 'nvidia-h100-mega-80gb': 11.06,
}
export const GCP_DEFAULT_GPU = 2

/** Azure N-series (GPU) sizes, exact names without the Standard_ prefix. */
export const AZURE_HOURLY: Readonly<Record<string, number>> = {
  NC6s_v3: 3.06, NC12s_v3: 6.12, NC24s_v3: 12.24, NC4as_T4_v3: 0.53, NC8as_T4_v3: 0.75, NC16as_T4_v3: 1.2, NC64as_T4_v3: 4.35,
  NC24ads_A100_v4: 3.67, NC48ads_A100_v4: 7.35, NC96ads_A100_v4: 14.69, ND40rs_v2: 22.03, ND96asr_v4: 27.2, ND96amsr_A100_v4: 32.77,
  ND96isr_H100_v5: 98.32, NV6: 1.14, NV12: 2.28, NV24: 4.56, NV36ads_A10_v5: 3.2,
}
/** Range per hour by series when the exact size is not listed. */
export const AZURE_SERIES: Readonly<Record<string, readonly [number, number]>> = {
  NC: [0.5, 14], ND: [22, 100], NV: [0.45, 7], NG: [0.6, 4], NP: [1.6, 13],
}
export const AZURE_DEFAULT_RANGE: readonly [number, number] = [1, 30]
export const AZURE_DEFAULT_NODE_HOURLY = 0.146

/** Managed Kubernetes control plane, per cluster-hour (EKS; GKE charges the same for regional clusters). */
export const CONTROL_PLANE_HOURLY = 0.1
export const EKS_DEFAULT_NODE_TYPE = 'm5.large'
export const EKS_DEFAULT_NODES = 2
export const GKE_DEFAULT_MACHINE = 'e2-medium'
export const GKE_DEFAULT_NODES = 3
export const AKS_DEFAULT_NODES = 3
