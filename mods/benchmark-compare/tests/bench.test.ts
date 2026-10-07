import { expect, test } from 'claude-code/testing'

import { compareRuns, detectBenchCommand, formatChange, formatResult, parseBenchJson, parseBenchOutput, splitCommand, verdictLine } from '../hooks/bench'
import { BENCHMARK_JS, CRITERION, CRITERION_AGAIN, GO_BENCH, HYPERFINE, PYTEST_BENCHMARK, PYTEST_BENCHMARK_JSON, VITEST_BENCH } from './fixtures'

const named = (output: string) => Object.fromEntries(parseBenchOutput(output).map(result => [result.name, `${result.value} ${result.unit}`]))

test('vitest bench: hz per benchmark, named by group, the repeated summary tables counted once', () => {
  expect(named(VITEST_BENCH)).toEqual({
    'sorting > native sort': '2615.95 ops',
    'sorting > insertion sort': '418.74 ops',
    'json roundtrip': '11788.13 ops',
  })
})

test('benchmark.js ops/sec and go test -bench ns/op, packages named when there are several', () => {
  expect(named(BENCHMARK_JS)).toEqual({ 'Array#map': '809993 ops', 'for loop': '280133 ops', 'RegExp#test': '30735050 ops' })
  expect(named(GO_BENCH)).toEqual({
    'hash.SHA256': '1471 ns',
    'strs.Concat': '6894 ns',
    'strs.Builder': '535.2 ns',
    'strs.Sizes/small': '89.06 ns',
    'strs.Sizes/large': '4263 ns',
  })
  expect(named('pkg: example.com/x\nBenchmarkParse-8   \t  50000\t     23456 ns/op\n')).toEqual({ Parse: '23456 ns' })
})

test('criterion: the middle estimate in ns, long names from the line above, change lines ignored', () => {
  const first = parseBenchOutput(CRITERION)
  expect(first.map(result => result.name)).toEqual(['fib 20', 'fibonacci of a rather long benchmark name 15', 'sum/iter'])
  expect(Math.round(first[0]?.value ?? 0)).toBe(20_590)
  expect(Math.round((first[1]?.value ?? 0) * 10)).toBe(19_395)
  expect(Math.round((first[2]?.value ?? 0) * 100_000)).toBe(90_035)
  expect(Math.round(parseBenchOutput(CRITERION_AGAIN)[0]?.value ?? 0)).toBe(20_792)
  expect(named('test tests::bench_add ... bench:       1,234 ns/iter (+/- 56)\n')).toEqual({ 'tests::bench_add': '1234 ns' })
})

test('pytest-benchmark: the Mean column of its table in its time unit, or the JSON report', () => {
  const table = parseBenchOutput(PYTEST_BENCHMARK)
  expect(table.map(result => result.name)).toEqual(['test_sorted', 'test_fib_10'])
  expect(Math.round(table[0]?.value ?? 0)).toBe(5_002)
  expect(Math.round((table[1]?.value ?? 0) * 10)).toBe(72_001)
  const json = parseBenchJson(PYTEST_BENCHMARK_JSON)
  expect(json.map(result => result.name).sort()).toEqual(['test_fib_10', 'test_sorted'])
  expect(json.every(result => result.unit === 'ns' && result.value > 1_000 && result.value < 20_000)).toBe(true)
})

test('hyperfine means and per-iteration lines (mitata)', () => {
  expect(named(HYPERFINE)).toEqual({ 'sleep 0.1': '102000000 ns', 'sleep 0.2': '201200000 ns' })
  expect(named('fibonacci        19.32 µs/iter  (18.95 µs … 21.7 µs)  19.4 µs\n')).toEqual({ fibonacci: '19320 ns' })
  expect(parseBenchOutput('npm ERR! missing script: bench\n')).toEqual([])
})

test('compares runs in both units, with a threshold for noise', () => {
  const before = [
    { name: 'a', value: 1000, unit: 'ops' as const },
    { name: 'b', value: 100, unit: 'ns' as const },
    { name: 'c', value: 100, unit: 'ns' as const },
    { name: 'gone', value: 5, unit: 'ns' as const },
  ]
  const after = [
    { name: 'a', value: 800, unit: 'ops' as const },
    { name: 'b', value: 80, unit: 'ns' as const },
    { name: 'c', value: 103, unit: 'ns' as const },
    { name: 'new', value: 7, unit: 'ns' as const },
  ]
  const rows = compareRuns(before, after, 5)
  expect(rows.map(row => `${row.name}:${row.verdict}`)).toEqual(['a:slower', 'b:faster', 'c:same', 'gone:gone', 'new:new'])
  expect(rows.map(formatChange)).toEqual(['▼ 20.0% slower', '▲ 25.0% faster', '≈ −2.9%', 'gone', 'new'])
  expect(verdictLine(rows)).toBe('1 slower · 1 faster · 1 same · 1 new · 1 gone')
  expect(formatResult({ name: 'x', value: 2615.95, unit: 'ops' })).toBe('2616 ops/s')
  expect(formatResult({ name: 'x', value: 30_735_050, unit: 'ops' })).toBe('30.74M ops/s')
  expect(formatResult({ name: 'x', value: 1471, unit: 'ns' })).toBe('1.47 µs')
  expect(formatResult({ name: 'x', value: 102_000_000, unit: 'ns' })).toBe('102 ms')
  expect(formatResult({ name: 'x', value: 0.9, unit: 'ns' })).toBe('0.90 ns')
})

test('finds the project\'s benchmark command, and splits commands that need no shell', () => {
  const names = (...list: string[]) => new Set(list)
  expect(detectBenchCommand({ names: names('package.json', 'pnpm-lock.yaml'), packageJson: '{"scripts":{"bench":"vitest bench"}}' })).toBe('pnpm run bench')
  expect(detectBenchCommand({ names: names('package.json'), packageJson: '{"devDependencies":{"vitest":"^3"}}' })).toBe('npx vitest bench --run')
  expect(detectBenchCommand({ names: names('go.mod') })).toBe('go test -bench=. -benchmem -run=^$ ./...')
  expect(detectBenchCommand({ names: names('Cargo.toml') })).toBe('cargo bench')
  expect(detectBenchCommand({ names: names('pyproject.toml'), pythonManifests: '[dependency-groups]\ndev = ["pytest-benchmark>=5"]', venvPython: '.venv/bin/python' })).toBe(
    '.venv/bin/python -m pytest --benchmark-only',
  )
  expect(detectBenchCommand({ names: names('README.md') })).toBeUndefined()
  expect(splitCommand('go test -bench=. -run=^$ ./...')).toEqual(['go', 'test', '-bench=.', '-run=^$', './...'])
  expect(splitCommand("hyperfine 'sleep 0.1' \"sleep 0.2\"")).toEqual(['hyperfine', 'sleep 0.1', 'sleep 0.2'])
  expect(splitCommand('npm run build && npm run bench')).toBeUndefined()
  expect(splitCommand('BENCH=1 cargo bench | tee out.txt')).toBeUndefined()
})
