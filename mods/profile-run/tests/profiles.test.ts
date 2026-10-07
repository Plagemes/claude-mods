import { expect, test } from 'claude-code/testing'

import {
  aggregateCpuProfile,
  busyMicros,
  formatMs,
  optimisable,
  optimisePrompt,
  parsePprofTop,
  parsePstatsDump,
  nodeOptionValue,
  planProfile,
  pprofDuration,
  sortFunctions,
} from '../hooks/profiles'
import type { ProfileFunction } from '../hooks/profiles'
import { NODE_CPUPROFILE, NODE_CPUPROFILE_COMPACT, PPROF_TOP, PSTATS_DUMP } from './fixtures'

const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places
const row = (fn: ProfileFunction | undefined) =>
  fn === undefined ? undefined : `${fn.name} @ ${fn.location} ${round(fn.selfMs)}ms ${round(fn.selfPercent)}% ${round(fn.totalPercent)}%`

test('a V8 CPU profile: self time per function from sample deltas, totals counted once through recursion', () => {
  const { functions, coveredMs } = aggregateCpuProfile(JSON.parse(NODE_CPUPROFILE), '/home/dev/app')
  expect(round(coveredMs)).toBe(181.31)
  expect(functions.slice(0, 5).map(row)).toEqual([
    'sortNumbers @ slow.js:3 111.93ms 61.73% 69.88%',
    'buildStrings @ slow.js:2 15.3ms 8.44% 8.44%',
    '(anonymous) @ slow.js:3 14.76ms 8.14% 8.14%',
    'main @ slow.js:4 12.67ms 6.99% 91.81%',
    '(garbage collector) @ (native) 11.54ms 6.36% 6.36%',
  ])
  // fib calls itself 27 levels deep: its total must not exceed 100%.
  expect(row(functions.find(fn => fn.name === 'fib'))).toBe('fib @ slow.js:1 2.45ms 1.35% 1.35%')
  expect(functions.some(fn => fn.name === '(idle)' || fn.name === '(root)')).toBe(false)
  expect(functions.reduce((sum, fn) => sum + fn.selfPercent, 0)).toBeGreaterThan(99.99)
})

test('the compacted form of a large profile aggregates to the same numbers', () => {
  const full = aggregateCpuProfile(JSON.parse(NODE_CPUPROFILE), '/home/dev/app')
  const compact = aggregateCpuProfile(JSON.parse(NODE_CPUPROFILE_COMPACT), '/home/dev/app')
  expect(compact.functions.slice(0, 6).map(row)).toEqual(full.functions.slice(0, 6).map(row))
  expect(round(busyMicros(JSON.parse(NODE_CPUPROFILE)) / 1000)).toBe(181.31)
  expect(() => aggregateCpuProfile({ nodes: [] }, '/')).toThrow()
})

test('cProfile stats: self and cumulative time, builtins and project paths made readable', () => {
  const { functions, coveredMs } = parsePstatsDump(PSTATS_DUMP, '/home/dev/app')
  expect(round(coveredMs)).toBe(169.9)
  expect(row(functions[0])).toBe('<genexpr> @ slow.py:7 52.35ms 30.81% 44.54%')
  expect(row(functions[1])).toBe("<method 'zfill' of 'str' objects> @ (built-in) 23.32ms 13.73% 13.73%")
  expect(row(functions.find(fn => fn.name === 'main'))).toBe('main @ slow.py:12 10.04ms 5.91% 97.37%')
  expect(row(functions.find(fn => fn.name === 'raw_decode'))).toBe('raw_decode @ /usr/lib/python3.13/json/decoder.py:351 21.89ms 12.88% 12.88%')
  expect(sortFunctions(functions, 'total')[0]?.name).toBe('<module>')
})

test('go tool pprof -top -filefunctions: flat as self, cum% as total, inline marks dropped', () => {
  const { functions, coveredMs } = parsePprofTop(PPROF_TOP, '/home/dev/prof-go')
  expect(coveredMs).toBe(180)
  expect(row(functions[0])).toBe('slices.partitionOrdered[go.shape.int] @ /usr/local/go1.24.7/src/slices/zsortordered.go 90ms 50% 61.11%')
  expect(row(functions.find(fn => fn.name === 'cmp.Less[go.shape.int]'))).toBe('cmp.Less[go.shape.int] @ /usr/local/go1.24.7/src/cmp/cmp.go 10ms 5.56% 5.56%')
  expect(row(functions.find(fn => fn.name === 'example.com/hot.SortInts'))).toBe('example.com/hot.SortInts @ hot.go 0ms 0% 83.33%')
  expect(pprofDuration('1.20s')).toBe(1200)
  expect(pprofDuration('0')).toBe(0)
  expect(() => parsePprofTop('File: x\nType: cpu\n', '/')).toThrow()
})

test('plans: node flags, NODE_OPTIONS for JS tools, cProfile for python and pytest, -cpuprofile for one go package', () => {
  const dir = '/r/.claude/profiles'
  expect(planProfile('node scripts/build.js --fast', dir, 'p1', 'python3')).toEqual({
    profiler: 'node',
    argv: ['node', '--cpu-prof', '--cpu-prof-dir=/r/.claude/profiles', 'scripts/build.js', '--fast'],
    env: {},
  })
  expect(planProfile('npm run build', dir, 'p1', 'python3', '--max-old-space-size=4096')).toEqual({
    profiler: 'node',
    argv: ['npm', 'run', 'build'],
    env: { NODE_OPTIONS: '--max-old-space-size=4096 --cpu-prof --cpu-prof-dir=/r/.claude/profiles' },
  })
  expect(planProfile('python3 -m mypkg.cli "a b"', dir, 'p1', 'python3')).toEqual({
    profiler: 'python',
    argv: ['python3', '-m', 'cProfile', '-o', '/r/.claude/profiles/p1.pstats', '-m', 'mypkg.cli', 'a b'],
    statsFile: '/r/.claude/profiles/p1.pstats',
  })
  expect(planProfile('pytest -q tests/test_api.py', dir, 'p1', '/r/.venv/bin/python')).toEqual({
    profiler: 'python',
    argv: ['/r/.venv/bin/python', '-m', 'cProfile', '-o', '/r/.claude/profiles/p1.pstats', '-m', 'pytest', '-q', 'tests/test_api.py'],
    statsFile: '/r/.claude/profiles/p1.pstats',
  })
  expect(planProfile('go test -run TestHot ./internal/hot', dir, 'p1', 'python3')).toEqual({
    profiler: 'go',
    argv: ['go', 'test', '-cpuprofile=/r/.claude/profiles/p1.pprof', '-o=/r/.claude/profiles/p1.test', '-run', 'TestHot', './internal/hot'],
    profileFile: '/r/.claude/profiles/p1.pprof',
  })
  expect(planProfile('go test ./...', dir, 'p1', 'python3').profiler).toBe('none')
  expect(planProfile('go test -count 3 ./a ./b', dir, 'p1', 'python3').profiler).toBe('none')
  const goRun = planProfile('go run ./cmd/server', dir, 'p1', 'python3')
  expect(goRun.profiler === 'none' && goRun.message).toContain('pprof')
  expect(planProfile('npm run build && npm test', dir, 'p1', 'python3').profiler).toBe('none')
  expect(planProfile('python -c "print(1)"', dir, 'p1', 'python3').profiler).toBe('none')
  expect(planProfile('ruby app.rb', dir, 'p1', 'python3').profiler).toBe('none')
})

test('the optimise prompt names the three hottest functions of the program itself', () => {
  const { functions, coveredMs } = aggregateCpuProfile(JSON.parse(NODE_CPUPROFILE), '/home/dev/app')
  expect(optimisable(functions).map(fn => fn.name).slice(0, 3)).toEqual(['sortNumbers', 'buildStrings', 'main'])
  const prompt = optimisePrompt('node slow.js', 'node', functions, coveredMs)
  expect(prompt).toStartWith('I profiled `node slow.js` (node, 181 ms sampled). The hottest functions by self time:')
  expect(prompt).toContain('1. sortNumbers at slow.js:3: 112 ms self (61.7%), 69.9% total')
  expect(prompt).toContain('2. buildStrings at slow.js:2: 15 ms self (8.4%), 8.4% total')
  expect(prompt).toContain('3. main at slow.js:4: 13 ms self (7.0%), 91.8% total')
  expect(formatMs(1534)).toBe('1.53 s')
})

test('a project path with spaces is quoted in NODE_OPTIONS, so the profiles land in the project', () => {
  const plan = planProfile('npm run build', '/Users/me/My Project/.claude/profiles', 'p1', 'python3')
  expect(plan).toEqual({
    profiler: 'node',
    argv: ['npm', 'run', 'build'],
    env: { NODE_OPTIONS: '--cpu-prof --cpu-prof-dir="/Users/me/My Project/.claude/profiles"' },
  })
  expect(nodeOptionValue('C:\\Users\\me\\My Project')).toBe('"C:\\\\Users\\\\me\\\\My Project"')
  expect(nodeOptionValue('C:\\Users\\me\\proj')).toBe('C:\\Users\\me\\proj')
})

test('regression: python -c grouped with other options is refused, and python options stay before cProfile', () => {
  const dir = '/r/.claude/profiles'
  for (const command of ['python -u -c "print(1)"', 'python3 -Bc "import app"', 'python -X dev -c "x()"']) {
    expect(planProfile(command, dir, 'p1', 'python3').profiler).toBe('none')
  }
  expect(planProfile('python -u -X importtime app.py --fast', dir, 'p1', 'python3')).toEqual({
    profiler: 'python',
    argv: ['python', '-u', '-X', 'importtime', '-m', 'cProfile', '-o', '/r/.claude/profiles/p1.pstats', 'app.py', '--fast'],
    statsFile: '/r/.claude/profiles/p1.pstats',
  })
})
