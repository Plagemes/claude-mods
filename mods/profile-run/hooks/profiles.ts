import type { ProfileFunction } from '../types'

export type { ProfileFunction }

/** How a command is profiled, or why it cannot be. */
export type ProfilePlan =
  | { profiler: 'node'; argv: string[]; env: Record<string, string> }
  | { profiler: 'python'; argv: string[]; statsFile: string }
  | { profiler: 'go'; argv: string[]; profileFile: string }
  | { profiler: 'none'; message: string }

/** A profile reduced to its functions, hottest first by self time, and the time it covers. */
export type Profile = { functions: ProfileFunction[]; coveredMs: number }

const IGNORED_NODES = new Set(['(root)', '(idle)'])
const JS_TOOLS = /^(?:npm|npx|pnpm|pnpx|yarn|tsx|ts-node|vitest|jest|mocha|ava|next|vite|webpack|esbuild|eslint|tsc|nodemon)$/
const PYTHON = /^python(?:\d(?:\.\d+)?)?(?:\.exe)?$/
/** go test flags that take the next argument as their value. */
const GO_VALUED = new Set([
  '-run', '-bench', '-benchtime', '-count', '-cpu', '-parallel', '-timeout', '-tags', '-skip', '-coverprofile', '-covermode',
  '-coverpkg', '-blockprofile', '-memprofile', '-mutexprofile', '-outputdir', '-trace', '-list', '-shuffle', '-fuzz', '-fuzztime',
  '-exec', '-p', '-o', '-C', '-ldflags', '-gcflags',
])

/**
 * Prints a cProfile stats file as JSON: the total time and, hottest first by
 * self time, `[file, line, function, calls, self seconds, cumulative seconds]`.
 */
export const PSTATS_SCRIPT = [
  'import json, pstats, sys',
  's = pstats.Stats(sys.argv[1])',
  'rows = sorted(([f, l, n, nc, tt, ct] for (f, l, n), (cc, nc, tt, ct, _) in s.stats.items()), key=lambda r: -r[4])',
  'print(json.dumps({"total": s.total_tt, "rows": rows[:80]}))',
].join('\n')

/**
 * Reduces a .cpuprofile too large to read whole to what the aggregation
 * needs (nodes without position ticks, self time per node), printed as JSON.
 */
export const COMPACT_CPUPROFILE_SCRIPT = [
  "const p = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))",
  'const self = {}',
  'const deltas = p.timeDeltas || []',
  'const mean = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0',
  ';(p.samples || []).forEach((id, i) => { self[id] = (self[id] || 0) + (i + 1 < deltas.length ? deltas[i + 1] : mean) })',
  'const nodes = p.nodes.map(n => ({ id: n.id, callFrame: { functionName: n.callFrame.functionName, url: n.callFrame.url, lineNumber: n.callFrame.lineNumber }, children: n.children || [] }))',
  'process.stdout.write(JSON.stringify({ nodes, selfMicros: self, startTime: p.startTime, endTime: p.endTime }))',
].join('\n')

// ── Planning ────────────────────────────────────────────────────────────────

/** A command as argv, honouring quotes; undefined when it needs a shell (pipes, `&&`, redirections, variables). */
export const splitWords = (command: string): string[] | undefined => {
  if (/[|&;<>`]|\$\(|\$\{?[A-Za-z_]/.test(command.replace(/'[^']*'|"[^"]*"/g, ''))) return undefined
  const words = [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(match => match[1] ?? match[2] ?? match[3] ?? '')
  return words.length === 0 ? undefined : words
}

const programOf = (word: string): string => word.slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1)

/**
 * How to profile `command`, its files going into `dir` named after `stamp`:
 * node under `--cpu-prof`, JS tools through NODE_OPTIONS, Python and pytest
 * under cProfile (with `python`), `go test` with `-cpuprofile`.
 */
export const planProfile = (command: string, dir: string, stamp: string, python: string, nodeOptions = ''): ProfilePlan => {
  const words = splitWords(command.trim())
  if (words === undefined) return { profiler: 'none', message: 'Profile one command at a time, without pipes, && or redirections.' }
  const [first = '', ...rest] = words
  const program = programOf(first)
  const cpuProf = ['--cpu-prof', `--cpu-prof-dir=${dir}`]

  if (program === 'node' || program === 'node.exe') return { profiler: 'node', argv: [first, ...cpuProf, ...rest], env: {} }
  if (JS_TOOLS.test(program)) {
    return { profiler: 'node', argv: words, env: { NODE_OPTIONS: [nodeOptions, ...cpuProf].filter(part => part !== '').join(' ') } }
  }
  if (PYTHON.test(program)) {
    if (rest[0] === '-c') return { profiler: 'none', message: 'cProfile cannot profile python -c; put the code in a file or a module.' }
    const statsFile = `${dir}/${stamp}.pstats`
    return { profiler: 'python', argv: [first, '-m', 'cProfile', '-o', statsFile, ...rest], statsFile }
  }
  if (program === 'pytest' || program === 'py.test') {
    const statsFile = `${dir}/${stamp}.pstats`
    return { profiler: 'python', argv: [python, '-m', 'cProfile', '-o', statsFile, '-m', 'pytest', ...rest], statsFile }
  }
  if (program === 'go' && rest[0] === 'test') {
    const args = rest.slice(1)
    const packages = args.filter((arg, index) => !arg.startsWith('-') && !GO_VALUED.has(args[index - 1] ?? ''))
    if (packages.some(arg => arg.endsWith('...')) || packages.length > 1) {
      return { profiler: 'none', message: 'go test -cpuprofile takes one package: name it, e.g. /profile go test ./internal/parser' }
    }
    const profileFile = `${dir}/${stamp}.pprof`
    return { profiler: 'go', argv: ['go', 'test', `-cpuprofile=${profileFile}`, `-o=${dir}/${stamp}.test`, ...rest.slice(1)], profileFile }
  }
  if (program === 'go') {
    return {
      profiler: 'none',
      message:
        'Go programs are profiled with pprof: profile a benchmark or test (/profile go test -run TestX ./pkg), or add ' +
        'runtime/pprof.StartCPUProfile to main (or import net/http/pprof) and read the file with go tool pprof -top.',
    }
  }
  return { profiler: 'none', message: `profile-run profiles node and JS tools (npm, npx, vitest…), python and pytest, and go test; not ${program}.` }
}

// ── Node .cpuprofile ────────────────────────────────────────────────────────

type CallFrame = { functionName: string; url: string; lineNumber: number }
type CpuNode = { id: number; callFrame: CallFrame; children: number[]; hitCount: number }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** `file:///home/dev/app/src/x.js` → `src/x.js` under `root`; node internals kept as they are. */
export const shortLocation = (url: string, root: string): string => {
  const path = url.startsWith('file://') ? decodeURIComponent(url.slice('file://'.length)) : url
  const prefix = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

const nodesOf = (profile: Record<string, unknown>): CpuNode[] =>
  (Array.isArray(profile.nodes) ? profile.nodes : []).filter(isRecord).map(node => {
    const frame = isRecord(node.callFrame) ? node.callFrame : {}
    return {
      id: Number(node.id),
      callFrame: {
        functionName: typeof frame.functionName === 'string' ? frame.functionName : '',
        url: typeof frame.url === 'string' ? frame.url : '',
        lineNumber: typeof frame.lineNumber === 'number' ? frame.lineNumber : -1,
      },
      children: Array.isArray(node.children) ? node.children.map(Number) : [],
      hitCount: typeof node.hitCount === 'number' ? node.hitCount : 0,
    }
  })

/** Microseconds of self time per node: from samples and their time deltas, a compacted `selfMicros`, or hit counts. */
const selfTimes = (profile: Record<string, unknown>, nodes: readonly CpuNode[]): Map<number, number> => {
  const self = new Map<number, number>()
  if (isRecord(profile.selfMicros)) {
    for (const [id, micros] of Object.entries(profile.selfMicros)) self.set(Number(id), Number(micros) || 0)
    return self
  }
  const samples = Array.isArray(profile.samples) ? profile.samples.map(Number) : []
  const deltas = Array.isArray(profile.timeDeltas) ? profile.timeDeltas.map(Number) : []
  if (samples.length > 0 && deltas.length === samples.length) {
    // A sample lasts until the next one is taken: its time is the next delta.
    const mean = deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length
    samples.forEach((id, index) => self.set(id, (self.get(id) ?? 0) + Math.max(0, deltas[index + 1] ?? mean)))
    return self
  }
  const hits = nodes.reduce((sum, node) => sum + node.hitCount, 0)
  const span = Number(profile.endTime) - Number(profile.startTime)
  const perHit = hits > 0 && span > 0 ? span / hits : 1_000
  for (const node of nodes) self.set(node.id, node.hitCount * perHit)
  return self
}

/**
 * The functions of a V8 CPU profile (`.cpuprofile`, or its compacted form):
 * self time summed per function (name, file, line), total time counted
 * once per call path so recursion is not counted twice; idle time left out.
 */
export const aggregateCpuProfile = (profile: unknown, root: string): Profile => {
  if (!isRecord(profile)) throw new SyntaxError('not a CPU profile')
  const nodes = nodesOf(profile)
  if (nodes.length === 0) throw new SyntaxError('the CPU profile has no nodes')
  const byId = new Map(nodes.map(node => [node.id, node]))
  const self = selfTimes(profile, nodes)
  const keyOf = (node: CpuNode): string => `${node.callFrame.functionName}\0${node.callFrame.url}\0${node.callFrame.lineNumber}`
  const isIgnored = (node: CpuNode): boolean => IGNORED_NODES.has(node.callFrame.functionName) && node.callFrame.url === ''

  // Post-order over the call tree, iteratively: deep recursion makes deep trees.
  const childIds = new Set(nodes.flatMap(node => node.children))
  const roots = nodes.filter(node => !childIds.has(node.id))
  const subtree = new Map<number, number>()
  const totals = new Map<string, number>()
  const selfByKey = new Map<string, number>()
  type Step = { node: CpuNode; isExit: boolean; path: Map<string, number> }
  const stack: Step[] = roots.map(node => ({ node, isExit: false, path: new Map() }))
  while (stack.length > 0) {
    const step = stack.pop() as Step
    const { node } = step
    if (isIgnored(node) && node.callFrame.functionName === '(idle)') continue
    if (!step.isExit) {
      const path = new Map(step.path)
      path.set(keyOf(node), (path.get(keyOf(node)) ?? 0) + 1)
      stack.push({ node, isExit: true, path: step.path })
      for (const id of node.children) {
        const child = byId.get(id)
        if (child !== undefined) stack.push({ node: child, isExit: false, path })
      }
      continue
    }
    const own = isIgnored(node) ? 0 : (self.get(node.id) ?? 0)
    const total = own + node.children.reduce((sum, id) => sum + (subtree.get(id) ?? 0), 0)
    subtree.set(node.id, total)
    if (isIgnored(node)) continue
    const key = keyOf(node)
    selfByKey.set(key, (selfByKey.get(key) ?? 0) + own)
    if (!step.path.has(key)) totals.set(key, (totals.get(key) ?? 0) + total)
  }

  const covered = [...selfByKey.values()].reduce((sum, micros) => sum + micros, 0)
  const functions = [...selfByKey].map(([key, micros]): ProfileFunction => {
    const [name = '', url = '', line = '-1'] = key.split('\0')
    const location = url === '' ? '(native)' : `${shortLocation(url, root)}${Number(line) >= 0 ? `:${Number(line) + 1}` : ''}`
    return {
      name: name === '' ? '(anonymous)' : name,
      location,
      selfMs: micros / 1_000,
      selfPercent: covered > 0 ? (micros / covered) * 100 : 0,
      totalPercent: covered > 0 ? ((totals.get(key) ?? micros) / covered) * 100 : 0,
    }
  })
  return { functions: sortFunctions(functions, 'self'), coveredMs: covered / 1_000 }
}

/** The sampled time of a profile without aggregating it, to pick the busiest of several processes. */
export const busyMicros = (profile: unknown): number => {
  if (!isRecord(profile)) return 0
  const nodes = nodesOf(profile)
  const self = selfTimes(profile, nodes)
  return nodes.filter(node => !(node.callFrame.functionName === '(idle)' && node.callFrame.url === '')).reduce((sum, node) => sum + (self.get(node.id) ?? 0), 0)
}

// ── Python cProfile ─────────────────────────────────────────────────────────

/** The JSON PSTATS_SCRIPT prints: self and cumulative time per function, builtins as `(built-in)`. */
export const parsePstatsDump = (text: string, root: string): Profile => {
  const dump: unknown = JSON.parse(text.slice(Math.max(0, text.indexOf('{'))))
  if (!isRecord(dump) || !Array.isArray(dump.rows)) throw new SyntaxError('no profile rows')
  const total = Number(dump.total) || 0
  const functions = dump.rows.filter(Array.isArray).map((row): ProfileFunction => {
    const [file = '', line = 0, name = '', , self = 0, cumulative = 0] = row as [string, number, string, number, number, number]
    return {
      name: String(name),
      location: file === '~' ? '(built-in)' : `${shortLocation(String(file), root)}:${line}`,
      selfMs: Number(self) * 1_000,
      selfPercent: total > 0 ? (Number(self) / total) * 100 : 0,
      totalPercent: total > 0 ? Math.min(100, (Number(cumulative) / total) * 100) : 0,
    }
  })
  return { functions: sortFunctions(functions, 'self'), coveredMs: total * 1_000 }
}

// ── Go pprof ────────────────────────────────────────────────────────────────

const MS_PER: Record<string, number> = { ns: 1e-6, us: 1e-3, µs: 1e-3, ms: 1, s: 1_000, min: 60_000, h: 3_600_000 }

/** `80ms`, `1.20s`, `0` as milliseconds. */
export const pprofDuration = (text: string): number => {
  const match = /^([\d.]+)(ns|us|µs|ms|s|min|h)?$/.exec(text.trim())
  return match === null ? 0 : Number(match[1]) * (MS_PER[match[2] ?? 'ms'] ?? 1)
}

/** `go tool pprof -top [-filefunctions]`: flat (self) and cum% per function, the total from its header. */
export const parsePprofTop = (text: string, root: string): Profile => {
  const total = /Total samples = (\S+)/.exec(text)?.[1] ?? /of (\S+) total/.exec(text)?.[1]
  const coveredMs = total === undefined ? 0 : pprofDuration(total)
  const functions: ProfileFunction[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+([\d.]+)%\s+[\d.]+%\s+(\S+)\s+([\d.]+)%\s+(.+?)(?:\s+\(inline\))?$/.exec(line)
    if (match === null) continue
    const [, flat = '0', flatPercent = '0', , cumPercent = '0', rest = ''] = match
    const [name = rest, file] = rest.split(/\s+(?=\/|[A-Za-z]:\\)/)
    functions.push({
      name,
      location: file === undefined ? '' : shortLocation(file, root),
      selfMs: pprofDuration(flat),
      selfPercent: Number(flatPercent),
      totalPercent: Number(cumPercent),
    })
  }
  if (functions.length === 0) throw new SyntaxError('pprof printed no functions')
  return { functions: sortFunctions(functions, 'self'), coveredMs }
}

// ── Showing and asking ──────────────────────────────────────────────────────

export const sortFunctions = (functions: readonly ProfileFunction[], by: 'self' | 'total'): ProfileFunction[] =>
  [...functions].sort((a, b) => (by === 'self' ? b.selfMs - a.selfMs : b.totalPercent - a.totalPercent) || a.name.localeCompare(b.name))

/** Functions worth optimising: real code, not the VM's or the profiler's own entries. */
export const optimisable = (functions: readonly ProfileFunction[]): ProfileFunction[] =>
  functions.filter(fn => !/^\((?:program|garbage collector|anonymous)\)$/.test(fn.name) && fn.location !== '(native)' && !fn.location.startsWith('node:') && fn.selfMs > 0)

export const formatMs = (ms: number): string => (ms >= 1_000 ? `${(ms / 1_000).toFixed(2)} s` : ms >= 10 ? `${ms.toFixed(0)} ms` : `${ms.toFixed(1)} ms`)

export const optimisePrompt = (command: string, profiler: string, functions: readonly ProfileFunction[], coveredMs: number): string => {
  const top = optimisable(functions).slice(0, 3)
  return [
    `I profiled \`${command}\` (${profiler}, ${formatMs(coveredMs)} sampled). The hottest functions by self time:`,
    ...top.map(
      (fn, index) =>
        `${index + 1}. ${fn.name}${fn.location === '' ? '' : ` at ${fn.location}`}: ${formatMs(fn.selfMs)} self (${fn.selfPercent.toFixed(1)}%), ${fn.totalPercent.toFixed(1)}% total`,
    ),
    '',
    'Optimise these: read each one, explain in a sentence why it is slow, and make it faster without changing behaviour. ' +
      'Keep or add tests for what you touch, and tell me to run /profile again to compare.',
  ].join('\n')
}
