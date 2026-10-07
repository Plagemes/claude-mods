// Real output of vitest 3.2 bench, benchmark.js 2.1, go 1.24 test -bench, criterion 0.5 (a first and a second run),
// pytest-benchmark 5 (table and --benchmark-json, samples dropped) and hyperfine 1.21 on small demo suites.

export const VITEST_BENCH = String.raw`Benchmarking is an experimental feature.
Breaking changes might not follow SemVer, please pin Vitest's version when using it.

 RUN  v3.2.7 /home/dev/bench-js


 ✓ src/sort.bench.ts > sorting 1288ms
     name                  hz     min      max    mean     p75      p99     p995     p999      rme  samples
   · native sort     2,615.95  0.2183  24.3249  0.3823  0.2692   3.9824   5.6919  20.7697  ±16.47%     1308
   · insertion sort    418.74  0.9173  57.1311  2.3881  1.3925  15.4503  24.1525  57.1311  ±27.46%      211

 ✓ src/sort.bench.ts 1960ms
     name                   hz     min      max    mean     p75     p99    p995    p999      rme  samples
   · json roundtrip  11,788.13  0.0417  26.5979  0.0848  0.0497  0.4963  2.5607  5.3451  ±14.94%     5980

 ✓ src/sort.bench.ts 1960ms
     name                   hz     min      max    mean     p75     p99    p995    p999      rme  samples
   · json roundtrip  11,788.13  0.0417  26.5979  0.0848  0.0497  0.4963  2.5607  5.3451  ±14.94%     5980

 BENCH  Summary

  native sort - src/sort.bench.ts > sorting
    6.25x faster than insertion sort

`

export const BENCHMARK_JS = String.raw`Array#map x 809,993 ops/sec ±5.37% (75 runs sampled)
for loop x 280,133 ops/sec ±13.60% (50 runs sampled)
RegExp#test x 30,735,050 ops/sec ±5.45% (69 runs sampled)
Fastest is RegExp#test
`

export const GO_BENCH = String.raw`goos: linux
goarch: amd64
pkg: example.com/benchgo/hash
cpu: Intel(R) Xeon(R) Processor @ 2.10GHz
BenchmarkSHA256-4   	 1000000	      1471 ns/op	 696.02 MB/s	       0 B/op	       0 allocs/op
PASS
ok  	example.com/benchgo/hash	1.537s
goos: linux
goarch: amd64
pkg: example.com/benchgo/strs
cpu: Intel(R) Xeon(R) Processor @ 2.10GHz
BenchmarkConcat-4    	  162915	      6894 ns/op	    5664 B/op	      99 allocs/op
BenchmarkBuilder-4   	 2899394	       535.2 ns/op	     248 B/op	       5 allocs/op
BenchmarkSizes/small-4         	14336743	        89.06 ns/op	      24 B/op	       2 allocs/op
BenchmarkSizes/large-4         	  281569	      4263 ns/op	    3320 B/op	       9 allocs/op
PASS
ok  	example.com/benchgo/strs	6.915s
`

export const CRITERION = "    Finished `bench` profile [optimized] target(s) in 0.03s\n     Running benches/fib.rs (target/release/deps/fib-20167c041c4d763b)\nBenchmarking fib 20\nBenchmarking fib 20: Warming up for 1.0000 s\nBenchmarking fib 20: Collecting 100 samples in estimated 2.0504 s (101k iterations)\nBenchmarking fib 20: Analyzing\nfib 20                  time:   [20.382 \u00b5s 20.590 \u00b5s 20.817 \u00b5s]\nFound 5 outliers among 100 measurements (5.00%)\n  3 (3.00%) high mild\n  2 (2.00%) high severe\n\nBenchmarking fibonacci of a rather long benchmark name 15\nBenchmarking fibonacci of a rather long benchmark name 15: Warming up for 1.0000 s\nBenchmarking fibonacci of a rather long benchmark name 15: Collecting 100 samples in estimated 2.0053 s (1.0M iterations)\nBenchmarking fibonacci of a rather long benchmark name 15: Analyzing\nfibonacci of a rather long benchmark name 15\n                        time:   [1.9074 \u00b5s 1.9395 \u00b5s 1.9816 \u00b5s]\nFound 16 outliers among 100 measurements (16.00%)\n  6 (6.00%) low mild\n  5 (5.00%) high mild\n  5 (5.00%) high severe\n\nBenchmarking sum/iter\nBenchmarking sum/iter: Warming up for 1.0000 s\nBenchmarking sum/iter: Collecting 100 samples in estimated 2.0000 s (2.4B iterations)\nBenchmarking sum/iter: Analyzing\nsum/iter                time:   [863.34 ps 900.35 ps 944.07 ps]\nFound 15 outliers among 100 measurements (15.00%)\n  15 (15.00%) high mild\n\n"

export const CRITERION_AGAIN = "    Finished `bench` profile [optimized] target(s) in 0.04s\n     Running benches/fib.rs (target/release/deps/fib-20167c041c4d763b)\nBenchmarking fib 20\nBenchmarking fib 20: Warming up for 1.0000 s\nBenchmarking fib 20: Collecting 100 samples in estimated 2.0126 s (96k iterations)\nBenchmarking fib 20: Analyzing\nfib 20                  time:   [20.572 \u00b5s 20.792 \u00b5s 21.065 \u00b5s]\n                        change: [+1.5497% +2.6798% +3.7954%] (p = 0.00 < 0.05)\n                        Performance has regressed.\nFound 2 outliers among 100 measurements (2.00%)\n  1 (1.00%) high mild\n  1 (1.00%) high severe\n\nBenchmarking fibonacci of a rather long benchmark name 15\nBenchmarking fibonacci of a rather long benchmark name 15: Warming up for 1.0000 s\nBenchmarking fibonacci of a rather long benchmark name 15: Collecting 100 samples in estimated 2.0076 s (1.1M iterations)\nBenchmarking fibonacci of a rather long benchmark name 15: Analyzing\nfibonacci of a rather long benchmark name 15\n                        time:   [1.8983 \u00b5s 1.9076 \u00b5s 1.9166 \u00b5s]\n                        change: [-2.6957% -0.9302% +0.7080%] (p = 0.31 > 0.05)\n                        No change in performance detected.\nFound 4 outliers among 100 measurements (4.00%)\n  1 (1.00%) low severe\n  3 (3.00%) low mild\n\nBenchmarking sum/iter\nBenchmarking sum/iter: Warming up for 1.0000 s\nBenchmarking sum/iter: Collecting 100 samples in estimated 2.0000 s (2.7B iterations)\nBenchmarking sum/iter: Analyzing\nsum/iter                time:   [723.11 ps 727.80 ps 732.53 ps]\n                        change: [-24.668% -21.138% -17.465%] (p = 0.00 < 0.05)\n                        Performance has improved.\nFound 3 outliers among 100 measurements (3.00%)\n  2 (2.00%) low mild\n  1 (1.00%) high mild\n\n"

export const PYTEST_BENCHMARK = String.raw`..                                                                       [100%]
Wrote benchmark data in: bench.json


------------------------------------------------------------------------------------ benchmark: 2 tests -----------------------------------------------------------------------------------
Name (time in us)        Min                   Max              Mean             StdDev            Median               IQR            Outliers  OPS (Kops/s)            Rounds  Iterations
-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
test_sorted           3.9520 (1.0)      4,037.1760 (2.54)     5.0020 (1.0)      17.8714 (2.16)     4.6690 (1.0)      0.2210 (1.0)      138;8154      199.9189 (1.0)      102523           1
test_fib_10           5.4120 (1.37)     1,586.3540 (1.0)      7.2001 (1.44)      8.2615 (1.0)      6.4850 (1.39)     0.5860 (2.65)   1373;18677      138.8875 (0.69)     118850           1
-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

Legend:
  Outliers: 1 Standard Deviation from Mean; 1.5 IQR (InterQuartile Range) from 1st Quartile and 3rd Quartile.
  OPS: Operations Per Second, computed as 1 / Mean
2 passed in 2.18s
`

export const PYTEST_BENCHMARK_JSON = String.raw`{
  "benchmarks": [
    {
      "group": null,
      "name": "test_fib_10",
      "fullname": "test_perf.py::test_fib_10",
      "params": null,
      "param": null,
      "extra_info": {},
      "options": {
        "disable_gc": false,
        "timer": "perf_counter",
        "min_rounds": 5,
        "max_time": 1.0,
        "min_time": 5e-06,
        "precision": null,
        "confidence": null,
        "warmup": false
      },
      "stats": {
        "min": 5.4120000640978105e-06,
        "max": 0.0015863539997553744,
        "mean": 7.200072300945331e-06,
        "stddev": 8.261472239868278e-06,
        "rounds": 118850,
        "median": 6.485000085376669e-06,
        "iqr": 5.859997145307716e-07,
        "q1": 6.1710002228210215e-06,
        "q3": 6.756999937351793e-06,
        "iqr_outliers": 18677,
        "stddev_outliers": 1373,
        "outliers": "1373;18677",
        "ld15iqr": 5.4120000640978105e-06,
        "hd15iqr": 7.637000180693576e-06,
        "ops": 138887.4942087325,
        "total": 0.8557285929673526,
        "iterations": 1
      }
    },
    {
      "group": null,
      "name": "test_sorted",
      "fullname": "test_perf.py::test_sorted",
      "params": null,
      "param": null,
      "extra_info": {},
      "options": {
        "disable_gc": false,
        "timer": "perf_counter",
        "min_rounds": 5,
        "max_time": 1.0,
        "min_time": 5e-06,
        "precision": null,
        "confidence": null,
        "warmup": false
      },
      "stats": {
        "min": 3.952000042772852e-06,
        "max": 0.004037176000110776,
        "mean": 5.002027115117531e-06,
        "stddev": 1.7871383732631952e-05,
        "rounds": 102523,
        "median": 4.66900019091554e-06,
        "iqr": 2.2100039132055826e-07,
        "q1": 4.575999810185749e-06,
        "q3": 4.797000201506307e-06,
        "iqr_outliers": 8154,
        "stddev_outliers": 138,
        "outliers": "138;8154",
        "ld15iqr": 4.256000011082506e-06,
        "hd15iqr": 5.128999873704743e-06,
        "ops": 199918.94825554205,
        "total": 0.5128228259231946,
        "iterations": 1
      }
    }
  ],
  "datetime": "2026-10-07T15:55:43.797686+00:00",
  "version": "5.3.0"
}
`

export const HYPERFINE = String.raw`Benchmark 1: sleep 0.1
  Time (mean ± σ):     102.0 ms ±   1.5 ms    [User: 1.3 ms, System: 0.2 ms]
  Range (min … max):   100.8 ms … 107.3 ms    28 runs
 
Benchmark 2: sleep 0.2
  Time (mean ± σ):     201.2 ms ±   0.2 ms    [User: 1.1 ms, System: 0.6 ms]
  Range (min … max):   201.0 ms … 201.7 ms    14 runs
 
Summary
  sleep 0.1 ran
    1.97 ± 0.03 times faster than sleep 0.2
`

