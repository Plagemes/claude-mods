/**
 * The learned ranker: a 2-layer perceptron (inputs → tanh hidden → sigmoid out) trained online by SGD on
 * binary cross-entropy with L2 weight decay, from feedback on recalled memories (used: 1, ignored: 0).
 * Deterministic initialisation (seeded PRNG, Xavier scale) so two fresh brains rank alike. Pure: no `$`.
 */

export type RankerConfig = { inputs: number; hidden: number; learningRate: number; l2: number; seed: number }
export const DEFAULT_RANKER: RankerConfig = { inputs: 16, hidden: 8, learningRate: 0.05, l2: 1e-4, seed: 7 }

/** Predictions remembered for the accuracy figure. */
const ACCURACY_WINDOW = 100

export type RankerFile = {
  v: 1
  config: RankerConfig
  w1: number[][]
  b1: number[]
  w2: number[]
  b2: number
  samples: number
  /** Last predictions' correctness, oldest first (1 right, 0 wrong). */
  hits: number[]
}

/** mulberry32: a tiny seeded PRNG. */
export function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const sigmoid = (z: number): number => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)))

export type Forward = { hidden: number[]; output: number }

export class Ranker {
  w1: number[][]
  b1: number[]
  w2: number[]
  b2: number
  samples = 0
  hits: number[] = []

  constructor(readonly config: RankerConfig = DEFAULT_RANKER) {
    const random = prng(config.seed)
    const scale1 = Math.sqrt(6 / (config.inputs + config.hidden))
    const scale2 = Math.sqrt(6 / (config.hidden + 1))
    this.w1 = Array.from({ length: config.hidden }, () => Array.from({ length: config.inputs }, () => (random() * 2 - 1) * scale1))
    this.b1 = new Array<number>(config.hidden).fill(0)
    this.w2 = Array.from({ length: config.hidden }, () => (random() * 2 - 1) * scale2)
    this.b2 = 0
  }

  forward(x: readonly number[]): Forward {
    const hidden = this.w1.map((row, j) => {
      let z = this.b1[j] ?? 0
      for (let i = 0; i < row.length; i += 1) z += (row[i] ?? 0) * (x[i] ?? 0)
      return Math.tanh(z)
    })
    let z = this.b2
    for (let j = 0; j < hidden.length; j += 1) z += (this.w2[j] ?? 0) * (hidden[j] ?? 0)
    return { hidden, output: sigmoid(z) }
  }

  predict(x: readonly number[]): number {
    return this.forward(x).output
  }

  /** The loss of one sample: binary cross-entropy plus the L2 penalty. */
  loss(x: readonly number[], y: number): number {
    const p = Math.min(1 - 1e-12, Math.max(1e-12, this.predict(x)))
    let l2 = 0
    for (const row of this.w1) for (const w of row) l2 += w * w
    for (const w of this.w2) l2 += w * w
    return -(y * Math.log(p) + (1 - y) * Math.log(1 - p)) + (this.config.l2 / 2) * l2
  }

  /** Back-propagation: the gradient of `loss` for one sample. */
  gradients(x: readonly number[], y: number): { w1: number[][]; b1: number[]; w2: number[]; b2: number } {
    const { hidden, output } = this.forward(x)
    const dz2 = output - y
    const w2 = hidden.map((h, j) => dz2 * h + this.config.l2 * (this.w2[j] ?? 0))
    const b2 = dz2
    const dz1 = hidden.map((h, j) => dz2 * (this.w2[j] ?? 0) * (1 - h * h))
    const w1 = this.w1.map((row, j) => row.map((w, i) => (dz1[j] ?? 0) * (x[i] ?? 0) + this.config.l2 * w))
    return { w1, b1: dz1, w2, b2 }
  }

  /** One online SGD step; records whether the prediction before the step was right. Returns that prediction. */
  train(x: readonly number[], y: number, weight = 1): number {
    const before = this.predict(x)
    this.hits = [...this.hits, (before >= 0.5 ? 1 : 0) === y ? 1 : 0].slice(-ACCURACY_WINDOW)
    const grad = this.gradients(x, y)
    const rate = this.config.learningRate * weight
    for (let j = 0; j < this.w1.length; j += 1) {
      const row = this.w1[j] as number[]
      const g = grad.w1[j] as number[]
      for (let i = 0; i < row.length; i += 1) row[i] = (row[i] ?? 0) - rate * (g[i] ?? 0)
      this.b1[j] = (this.b1[j] ?? 0) - rate * (grad.b1[j] ?? 0)
      this.w2[j] = (this.w2[j] ?? 0) - rate * (grad.w2[j] ?? 0)
    }
    this.b2 -= rate * grad.b2
    this.samples += 1
    return before
  }

  /** Share of the last predictions that were right, or null before any. */
  accuracy(): number | null {
    return this.hits.length === 0 ? null : this.hits.reduce((sum, hit) => sum + hit, 0) / this.hits.length
  }

  toFile(): RankerFile {
    return { v: 1, config: this.config, w1: this.w1, b1: this.b1, w2: this.w2, b2: this.b2, samples: this.samples, hits: this.hits }
  }

  static fromFile(value: unknown, config: RankerConfig = DEFAULT_RANKER): Ranker {
    const ranker = new Ranker(config)
    const file = value as Partial<RankerFile> | undefined
    const isShaped =
      file?.v === 1 &&
      Array.isArray(file.w1) &&
      file.w1.length === config.hidden &&
      file.w1.every(row => Array.isArray(row) && row.length === config.inputs && row.every(Number.isFinite)) &&
      Array.isArray(file.b1) &&
      file.b1.length === config.hidden &&
      Array.isArray(file.w2) &&
      file.w2.length === config.hidden &&
      Number.isFinite(file.b2)
    if (!isShaped) return ranker
    ranker.w1 = file.w1 as number[][]
    ranker.b1 = file.b1 as number[]
    ranker.w2 = file.w2 as number[]
    ranker.b2 = file.b2 as number
    ranker.samples = Number(file.samples) || 0
    ranker.hits = Array.isArray(file.hits) ? file.hits.filter(hit => hit === 0 || hit === 1).slice(-ACCURACY_WINDOW) : []
    return ranker
  }
}

/**
 * The score a candidate is ranked by: the heuristic alone until `minSamples` feedback samples, then a blend
 * that hands over to the network (half at `minSamples`, all of it at twice that).
 */
export function blendedScore(ranker: Ranker, x: readonly number[], heuristic: number, minSamples: number): { score: number; learnt: number | null } {
  if (ranker.samples < minSamples) return { score: heuristic, learnt: null }
  const learnt = ranker.predict(x)
  const share = Math.min(1, ranker.samples / (2 * minSamples))
  return { score: share * learnt + (1 - share) * heuristic, learnt }
}
