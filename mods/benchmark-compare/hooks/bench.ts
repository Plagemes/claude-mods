import type { BenchResult, BenchRow } from '../types'

export type { BenchResult, BenchRow }

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g
const NUMBER = '[\\d,]+(?:\\.\\d+)?'
const TIME_UNIT = '(ps|ns|µs|μs|us|ms|s)'
const NS_PER: Record<string, number> = { ps: 0.001, ns: 1, µs: 1_000, μs: 1_000, us: 1_000, ms: 1_000_000, s: 1_000_000_000 }

const num = (text: string): number => Number(text.replace(/,/g, ''))
export const stripAnsi = (text: string): string => text.replace(ANSI, '')
export const toNs = (value: number, unit: string): number => value * (NS_PER[unit] ?? 1)

// ── Parsers, one per output format ──────────────────────────────────────────

/** vitest bench (tinybench tables): `· name  2,615.95  0.2183 ...` under `✓ file > group 1288ms`; hz is ops/s. */
const parseVitest = (lines: readonly string[]): BenchResult[] => {
  const found: BenchResult[] = []
  let group = ''
  for (const line of lines) {
    const header = /^\s*[✓✗×]\s+(\S+?)(?:\s+>\s+(.+?))?\s+\d+ms\s*$/.exec(line)
    if (header !== null) {
      group = header[2] ?? ''
      continue
    }
    const row = new RegExp(`^\\s*·\\s+(.+?)\\s{2,}(${NUMBER})\\s+${NUMBER}`).exec(line)
    if (row !== null) found.push({ name: group === '' ? (row[1] as string) : `${group} > ${row[1]}`, value: num(row[2] as string), unit: 'ops' })
  }
  return found
}

/** benchmark.js: `Array#map x 809,993 ops/sec ±5.37% (75 runs sampled)`. */
const parseBenchmarkJs = (lines: readonly string[]): BenchResult[] =>
  lines.flatMap(line => {
    const match = new RegExp(`^\\s*(.+?) x (${NUMBER}) ops/sec\\b`).exec(line)
    return match === null ? [] : [{ name: match[1] as string, value: num(match[2] as string), unit: 'ops' as const }]
  })

/** go test -bench: `BenchmarkConcat-4  162915  6894 ns/op ...`, the package from the `pkg:` line before it. */
const parseGo = (lines: readonly string[]): BenchResult[] => {
  const found: { pkg: string; name: string; value: number }[] = []
  let pkg = ''
  for (const line of lines) {
    const header = /^pkg:\s+(\S+)/.exec(line)
    if (header !== null) pkg = header[1] as string
    const match = /^(Benchmark\S+?)(?:-\d+)?\s+\d+\s+([\d.]+) ns\/op\b/.exec(line)
    if (match !== null) found.push({ pkg, name: (match[1] as string).replace(/^Benchmark/, ''), value: Number(match[2]) })
  }
  const packages = new Set(found.map(one => one.pkg))
  return found.map(one => ({
    name: packages.size > 1 ? `${one.pkg.slice(one.pkg.lastIndexOf('/') + 1)}.${one.name}` : one.name,
    value: one.value,
    unit: 'ns' as const,
  }))
}

/** cargo bench, libtest: `test bench_sort ... bench:   1,234 ns/iter (+/- 56)`. */
const parseLibtest = (lines: readonly string[]): BenchResult[] =>
  lines.flatMap(line => {
    const match = new RegExp(`^test (\\S+)\\s+\\.\\.\\. bench:\\s+(${NUMBER}) ns/iter`).exec(line)
    return match === null ? [] : [{ name: match[1] as string, value: num(match[2] as string), unit: 'ns' as const }]
  })

/** criterion: `fib 20   time:   [26.029 µs 26.251 µs 26.505 µs]`, a long name on the line before; the middle estimate counts. */
const parseCriterion = (lines: readonly string[]): BenchResult[] => {
  const found: BenchResult[] = []
  const estimate = `\\[(${NUMBER}) ${TIME_UNIT} (${NUMBER}) ${TIME_UNIT} (${NUMBER}) ${TIME_UNIT}\\]`
  lines.forEach((line, index) => {
    const match = new RegExp(`^(.*?)\\s*time:\\s+${estimate}`).exec(line)
    if (match === null) return
    const name = (match[1] as string).trim() || (lines[index - 1] ?? '').trim()
    if (name !== '') found.push({ name, value: toNs(num(match[4] as string), match[5] as string), unit: 'ns' })
  })
  return found
}

/** pytest-benchmark's table: `Name (time in us)` header, then `test_x  3.95 (1.0)  4,037.17 (2.54)  5.00 (1.0) ...`; Mean counts. */
const parsePytestBenchmark = (lines: readonly string[]): BenchResult[] => {
  const found: BenchResult[] = []
  let unit: string | undefined
  let meanAt = -1
  for (const line of lines) {
    const header = /^Name \(time in (\w+|µs)\)\s+(.*)$/.exec(line)
    if (header !== null) {
      unit = header[1] === 'us' ? 'us' : header[1]
      meanAt = (header[2] as string).trim().split(/\s{2,}/).indexOf('Mean')
      continue
    }
    if (unit === undefined || meanAt < 0) continue
    if (/^-{5,}/.test(line) || line.trim() === '') continue
    if (/^Legend:/.test(line)) {
      unit = undefined
      continue
    }
    const [name, ...rest] = line.trim().split(/\s+/)
    const values = rest.filter(token => !token.startsWith('(') && !token.endsWith(')'))
    const mean = values[meanAt]
    if (name !== undefined && mean !== undefined && /^[\d,.]+$/.test(mean)) found.push({ name, value: toNs(num(mean), unit), unit: 'ns' })
  }
  return found
}

/** hyperfine: `Benchmark 1: sleep 0.1` then `  Time (mean ± σ):     102.3 ms ±   0.5 ms`. */
const parseHyperfine = (lines: readonly string[]): BenchResult[] => {
  const found: BenchResult[] = []
  let name: string | undefined
  for (const line of lines) {
    const header = /^Benchmark \d+:\s+(.+)$/.exec(line)
    if (header !== null) name = (header[1] as string).trim()
    const time = new RegExp(`^\\s*Time \\(mean ± σ\\):\\s+(${NUMBER}) ${TIME_UNIT}`).exec(line)
    if (time !== null && name !== undefined) {
      found.push({ name, value: toNs(num(time[1] as string), time[2] as string), unit: 'ns' })
      name = undefined
    }
  }
  return found
}

/** mitata and similar: `fibonacci   19.32 µs/iter  (18.95 µs … 21.7 µs)`. */
const parsePerIter = (lines: readonly string[]): BenchResult[] =>
  lines.flatMap(line => {
    const match = new RegExp(`^\\s*(\\S.*?)\\s+(${NUMBER})\\s*${TIME_UNIT}/iter\\b`).exec(line)
    if (match === null || /^test /.test(line)) return []
    return [{ name: (match[1] as string).trim(), value: toNs(num(match[2] as string), match[3] as string), unit: 'ns' as const }]
  })

/** JSON reports: pytest-benchmark's `--benchmark-json` (`benchmarks[].stats.mean`, seconds) and hyperfine's `--export-json` (`results[].mean`). */
export const parseBenchJson = (text: string): BenchResult[] => {
  let report: unknown
  try {
    report = JSON.parse(text)
  } catch {
    return []
  }
  if (typeof report !== 'object' || report === null) return []
  const record = report as Record<string, unknown>
  const items = (key: string): Record<string, unknown>[] =>
    Array.isArray(record[key]) ? (record[key] as unknown[]).filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null) : []
  const fromPytest = items('benchmarks').flatMap(item => {
    const stats = item.stats as Record<string, unknown> | undefined
    return typeof item.name === 'string' && typeof stats?.mean === 'number' ? [{ name: item.name, value: stats.mean * 1e9, unit: 'ns' as const }] : []
  })
  const fromHyperfine = items('results').flatMap(item =>
    typeof item.command === 'string' && typeof item.mean === 'number' ? [{ name: item.command, value: item.mean * 1e9, unit: 'ns' as const }] : [],
  )
  return [...fromPytest, ...fromHyperfine]
}

/**
 * Every benchmark result a run printed, whatever wrote it (vitest bench,
 * benchmark.js, go test -bench, cargo bench with libtest or criterion,
 * pytest-benchmark, hyperfine, mitata). A name seen twice keeps its last
 * value (vitest prints its tables again at the end).
 */
export const parseBenchOutput = (output: string): BenchResult[] => {
  const lines = stripAnsi(output).split(/\r?\n/)
  const parsers = [parseVitest, parseBenchmarkJs, parseGo, parseLibtest, parseCriterion, parsePytestBenchmark, parseHyperfine, parsePerIter]
  const byName = new Map<string, BenchResult>()
  for (const parse of parsers) for (const result of parse(lines)) if (Number.isFinite(result.value) && result.value > 0) byName.set(result.name, result)
  return [...byName.values()]
}

// ── Comparing ───────────────────────────────────────────────────────────────

/** How much faster `after` is than `before`, in percent: ops/s grow, times shrink. */
export const speedupOf = (before: BenchResult, after: BenchResult): number | null => {
  if (before.unit !== after.unit || before.value <= 0 || after.value <= 0) return null
  const ratio = before.unit === 'ops' ? after.value / before.value : before.value / after.value
  return (ratio - 1) * 100
}

/** Rows for every benchmark in either run, baseline order first; slower beyond `threshold` percent is a regression. */
export const compareRuns = (before: readonly BenchResult[], after: readonly BenchResult[], threshold: number): BenchRow[] => {
  const afterByName = new Map(after.map(result => [result.name, result]))
  const beforeNames = new Set(before.map(result => result.name))
  const rows: BenchRow[] = before.map(old => {
    const now = afterByName.get(old.name)
    if (now === undefined) return { name: old.name, before: old, after: null, speedup: null, verdict: 'gone' }
    const speedup = speedupOf(old, now)
    const verdict = speedup === null || Math.abs(speedup) <= threshold ? 'same' : speedup > 0 ? 'faster' : 'slower'
    return { name: old.name, before: old, after: now, speedup, verdict }
  })
  for (const now of after) if (!beforeNames.has(now.name)) rows.push({ name: now.name, before: null, after: now, speedup: null, verdict: 'new' })
  return rows
}

// ── Showing ─────────────────────────────────────────────────────────────────

const compact = (value: number): string => {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}G`
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (value >= 1e4) return `${(value / 1e3).toFixed(1)}K`
  return value >= 100 ? value.toFixed(0) : value.toFixed(2)
}

/** `1.47 µs`, `535 ns`, `102.3 ms` or `2.62K ops/s`. */
export const formatResult = (result: BenchResult): string => {
  if (result.unit === 'ops') return `${compact(result.value)} ops/s`
  const ns = result.value
  const [scaled, unit] = ns >= 1e9 ? [ns / 1e9, 's'] : ns >= 1e6 ? [ns / 1e6, 'ms'] : ns >= 1e3 ? [ns / 1e3, 'µs'] : [ns, 'ns']
  return `${scaled >= 100 ? scaled.toFixed(0) : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2)} ${unit}`
}

/** `▲ 12.3% faster`, `▼ 8.1% slower`, `≈ +1.2%`, `new`, `gone`. */
export const formatChange = (row: BenchRow): string => {
  if (row.verdict === 'new' || row.verdict === 'gone') return row.verdict
  if (row.speedup === null) return 'units differ'
  const size = Math.abs(row.speedup).toFixed(1)
  if (row.verdict === 'faster') return `▲ ${size}% faster`
  if (row.verdict === 'slower') return `▼ ${size}% slower`
  return `≈ ${row.speedup >= 0 ? '+' : '−'}${size}%`
}

/** `2 slower · 1 faster · 5 same`, the kinds that occur. */
export const verdictLine = (rows: readonly BenchRow[]): string => {
  const order: BenchRow['verdict'][] = ['slower', 'faster', 'same', 'new', 'gone']
  return order
    .map(verdict => [verdict, rows.filter(row => row.verdict === verdict).length] as const)
    .filter(([, count]) => count > 0)
    .map(([verdict, count]) => `${count} ${verdict}`)
    .join(' · ')
}

// ── Finding the command ─────────────────────────────────────────────────────

/** What the project's folder holds, as far as choosing a benchmark command goes. */
export type ProjectFacts = {
  names: ReadonlySet<string>
  packageJson?: string
  /** pyproject.toml and requirements files, joined, to look for pytest-benchmark. */
  pythonManifests?: string
  /** The project virtualenv's python, when there is one. */
  venvPython?: string
}

const runnerOf = (names: ReadonlySet<string>): string =>
  names.has('pnpm-lock.yaml') ? 'pnpm' : names.has('yarn.lock') ? 'yarn' : names.has('bun.lockb') || names.has('bun.lock') ? 'bun' : 'npm'

/** The benchmark command a project most likely runs, or undefined when none is apparent. */
export const detectBenchCommand = (facts: ProjectFacts): string | undefined => {
  if (facts.packageJson !== undefined) {
    let manifest: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(facts.packageJson)
      if (typeof parsed === 'object' && parsed !== null) manifest = parsed as Record<string, unknown>
    } catch {
      // An unreadable package.json has no scripts.
    }
    const scripts = (typeof manifest.scripts === 'object' && manifest.scripts !== null ? manifest.scripts : {}) as Record<string, unknown>
    const script = ['bench', 'benchmark', 'benchmarks', 'perf'].find(name => typeof scripts[name] === 'string')
    if (script !== undefined) return `${runnerOf(facts.names)} run ${script}`
    const deps = ['dependencies', 'devDependencies'].flatMap(field =>
      typeof manifest[field] === 'object' && manifest[field] !== null ? Object.keys(manifest[field] as object) : [],
    )
    if (deps.includes('vitest')) return 'npx vitest bench --run'
  }
  if (facts.names.has('go.mod')) return 'go test -bench=. -benchmem -run=^$ ./...'
  if (facts.names.has('Cargo.toml')) return 'cargo bench'
  if (facts.pythonManifests !== undefined && /pytest[-_]benchmark/i.test(facts.pythonManifests)) {
    return `${facts.venvPython ?? 'python'} -m pytest --benchmark-only`
  }
  return undefined
}

/** A command line as argv, honouring quotes; undefined when it needs a shell (pipes, redirections, `&&`, variables). */
export const splitCommand = (command: string): string[] | undefined => {
  if (/[|&;<>`]|\$\(|\$\{?[A-Za-z_]/.test(command.replace(/'[^']*'|"[^"]*"/g, ''))) return undefined
  const words: string[] = []
  for (const match of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) words.push(match[1] ?? match[2] ?? match[3] ?? '')
  return words.length === 0 ? undefined : words
}
